import { logStore } from '../services/logStore.ts';
import { logQwenSSE } from '../services/qwenLogger.ts';
import { cleanTextOfXmlArtifacts, parseXmlToolCalls, xmlToolCallToParsed } from '../tools/xmlToolParser.ts';
import type { ParsedToolCall } from '../types/openai.ts';
import { filterContent } from '../utils/contentFilter.ts';
import { THINK_TAG_NAMES, TOOL_CALL_KEYWORDS } from '../utils/tagNames.ts';
import {
  type AmplificationGuardState,
  cleanThinkTags,
  detectCumulativeChunk,
  extractDeltaContent,
  getSnapshotDelta,
} from './chatHelpers.ts';

import { writeContentDelta, writeReasoningEvent, writeToolCallEvent } from './writeHelpers.ts';

// ── Constants ──────────────────────────────────────────────────────

/**
 * Matches self-closing thinking/tool tags (newlines/spaces around tags).
 * Performance: extracted to module-level const to avoid recompilation on each chunk.
 */
const SELF_CLOSING_TAG_PATTERN = new RegExp(`^[\\n\\s]*<\\/?(?:${THINK_TAG_NAMES.join('|')})[\\s>]*[\\n\\s]*$`);

/**
 * Maximum accumulated buffer size for the one-chunk delay approach.
 * If a chunk has `<` without `>` and the accumulated (pending + current) text exceeds
 * this length, we force-release it as regular content instead of continuing to buffer.
 * Prevents indefinite buffering of `<` in non-XML text like "x < 3" across many chunks.
 * 200 chars is generous: the longest possible tool call tag start
 * (e.g. `<parameter=` + longest param name) fits easily, while non-XML `<` usage
 * would accumulate well beyond 200 chars before the stream emits any content.
 */
const MAX_BUFFER_CHARS = 200;

// ── Local MCP tool call extraction (from Qwen Studio local_tool phase) ──

/**
 * Extract tool calls from SSE data containing `extra.local_mcp` in the delta.
 * Qwen Studio sends tool calls in this format during the `local_tool` phase:
 *
 * ```json
 * {"choices": [{"delta": {"role": "assistant", "content": "", "phase": "local_tool",
 *   "status": "finished",
 *   "extra": {"local_mcp": {"★": [{"tool_name": "★-bash", "params": {"command": "ls -la /tmp"}}]}}}}]}
 * ```
 *
 * @param sseData - Parsed SSE data chunk
 * @returns Array of ParsedToolCall with UUID call IDs
 */
export function extractLocalMcpToolCalls(sseData: any): ParsedToolCall[] {
  const localMcp = sseData?.choices?.[0]?.delta?.extra?.local_mcp;
  if (!localMcp) return [];

  const serverTools = localMcp['★'];
  if (!Array.isArray(serverTools)) return [];

  const toolCalls: ParsedToolCall[] = [];
  for (const tool of serverTools) {
    if (tool?.tool_name && tool?.params !== undefined) {
      const rawName = tool.tool_name;
      const name = rawName.startsWith('★-') ? rawName.slice(2) : rawName;
      toolCalls.push({
        id: `call_${crypto.randomUUID()}`,
        name,
        arguments: tool.params,
      });
    }
  }
  return toolCalls;
}

// ── Per-chunk stream processing ────────────────────────────────────

export interface StreamProcessingState {
  targetResponseId: string | null;
  nextParentId: string | null;
  completionTokens: number;
  promptTokens: number;
  currentThoughtIndex: number;
  reasoningBuffer: string;
  lastFullContent: string;
  lastRawContent: string;
  lastFilteredSnapshot: string;
  lastThinkingSnapshot: string;
  lastVStrRaw: string;
  lastFilteredFullContent: string;
  lastDeltaThinkingFull: string;
  loggedToolCalls: Set<string>;
  lastParsePosition: number;
  /** Set when upstream Qwen aborts the stream with an error (content filter,
   *  rate limit, etc.). The post-stream handler flushes partial content first,
   *  then surfaces this to the client instead of dropping what was received. */
  upstreamError?: string;
  /** Upstream error code (e.g. RateLimited) captured with upstreamError */
  upstreamCode?: string;
  /** Hours Qwen asked to wait — carried by RateLimited payloads (data.num) */
  upstreamWaitHours?: number;
  /** Depth tracking for nested tool call XML blocks. >0 means suppress content emission. */
  toolCallDepth: number;
  /**
   * One-chunk buffer for handling XML tag splits across SSE chunk boundaries.
   * When a chunk contains `<` without `>`, it might be a tag split (e.g. `<func` + `tion=read>`).
   * We buffer the incomplete chunk and wait for the next chunk. If combining them completes a
   * known tool call tag, toolCallDepth suppresses content emission. If not, the combined text
   * is regular content and is emitted normally. Max buffer size prevents indefinite buffering
   * of `<` in non-XML text (e.g. "x < 3").
   */
  pendingChunk: string;
}

export interface StreamProcessingCtx {
  streamWriter: any;
  completionId: string;
  model: string;
  emittedToolCallCount: number;
  enableContentFiltering: boolean;
  cleanOutput: boolean;
  logId: string;
  resolvedEmail: string;
  ampState: AmplificationGuardState;
  qwenAbortController: AbortController;
  qwenLogFile?: string;
  sseEventCount?: number;
}

export type ProcessStreamResult = 'continue' | 'break_stream';

/**
 * Shared content filter pipeline standardizing the order:
 * cleanTextOfXmlArtifacts → filterContent → cleanThinkTags.
 * Used in both per-chunk (processStreamData) and flush (handlePostStreamCompletion) paths.
 */
export function filterContentPipeline(
  text: string,
  enableContentFiltering: boolean,
  /** Set true for per-chunk deltas to avoid mangling partial XML tool call syntax.
   *  Skips cleanTextOfXmlArtifacts and filterContent (both strip incomplete
   *  XML tags and create orphaned tail fragments). Only runs cleanThinkTags
   *  which strips complete tags safely. Full XML stripping happens on flush. */
  skipXmlArtifactStripping?: boolean,
): { cleanText: string | null; thinking: string } {
  if (!text) return { cleanText: null, thinking: '' };
  if (skipXmlArtifactStripping) {
    // Per-chunk: only strip complete think/function tags. Partial XML tool call
    // syntax (e.g. "<function" or "=read>\n" split across chunks) is handled
    // on the full accumulated text during flush processing.
    const cleaned = cleanThinkTags(text);
    return { cleanText: cleaned || null, thinking: '' };
  }
  // Full-text processing (flush path): strip ALL XML tool call artifacts.
  const { cleanedText: stripped } = cleanTextOfXmlArtifacts(text);
  if (!enableContentFiltering) {
    const cleaned = cleanThinkTags(stripped);
    return { cleanText: cleaned || null, thinking: '' };
  }
  const filtered = filterContent(stripped);
  const cleaned = cleanThinkTags(filtered.cleanText);
  return {
    cleanText: cleaned || null,
    thinking: filtered.thinking || '',
  };
}

/**
 * Process a single parsed SSE data chunk from the stream.
 * Mutates `state` in place and returns a directive:
 *   - 'continue'      → normal processing, keep iterating
 *   - 'break_stream'  → stream finished (break out of loops)
 */
export async function processStreamData(data: any, state: StreamProcessingState, ctx: StreamProcessingCtx): Promise<ProcessStreamResult> {
  const { streamWriter, completionId, model, enableContentFiltering, logId, resolvedEmail, ampState } = ctx;

  // Check for upstream Qwen error sent as SSE data chunk
  if (data.error) {
    const errMsg = typeof data.error === 'string' ? data.error : data.error.message || JSON.stringify(data.error);
    logStore.addError(logId, `Qwen upstream SSE error: ${errMsg}`);
    logStore.updateEntry(logId, (entry) => {
      entry.finalResponse = entry.finalResponse || { finishReason: '', toolCallCount: 0, contentPreview: '' };
      entry.finalResponse.finishReason = 'error';
    });
    // Stash the error so handlePostStreamCompletion can flush the partial
    // content already received, THEN surface the error to the client —
    // instead of dropping everything and showing a bare server error.
    state.upstreamError = `Qwen upstream error: ${errMsg}`;
    return 'break_stream';
  }
  // Qwen envelope errors arrive as {"success":false,data:{code,details,num}}
  // — notably RateLimited walls delivered inside an HTTP 200 SSE stream.
  if (data?.success === false) {
    const code = data.data?.code || data.code || 'UpstreamError';
    const details = data.data?.details || data.message || 'Qwen returned an error';
    const wait = data.data?.num !== undefined ? ` Wait about ${data.data.num} hour(s) before trying again.` : '';
    state.upstreamError = `Qwen upstream error: ${code}: ${details}.${wait}`;
    state.upstreamCode = code;
    state.upstreamWaitHours = data.data?.num;
    logStore.addError(logId, state.upstreamError);
    logStore.updateEntry(logId, (entry) => {
      entry.finalResponse = entry.finalResponse || { finishReason: '', toolCallCount: 0, contentPreview: '' };
      entry.finalResponse.finishReason = 'error';
    });
    return 'break_stream';
  }
  const deltaStatus = data.choices?.[0]?.delta?.status;
  if (deltaStatus === 'error') {
    logStore.addError(logId, `Qwen stream delta returned error status`);
    logStore.updateEntry(logId, (entry) => {
      entry.finalResponse = entry.finalResponse || { finishReason: '', toolCallCount: 0, contentPreview: '' };
      entry.finalResponse.finishReason = 'error';
    });
    state.upstreamError = 'Qwen stream delta returned error status';
    return 'break_stream';
  }
  let streamFinished = false;
  if (deltaStatus === 'finished') {
    const deltaPhase = data.choices[0].delta.phase;
    // Always extract and emit local MCP tool calls before breaking
    if (deltaPhase === 'local_tool') {
      const localToolCalls = extractLocalMcpToolCalls(data);
      const newToolCalls = localToolCalls.filter((tc) => {
        const key = `${tc.name}:${JSON.stringify(tc.arguments)}`;
        if (state.loggedToolCalls.has(key)) return false;
        state.loggedToolCalls.add(key);
        return true;
      });

      if (newToolCalls.length > 0) {
        logStore.updateEntry(logId, (entry) => {
          for (const tc of newToolCalls) {
            entry.parsedToolCalls.push({ name: tc.name, args: JSON.stringify(tc.arguments) });
          }
        });
        for (let i = 0; i < newToolCalls.length; i++) {
          await writeToolCallEvent(streamWriter, completionId, model, newToolCalls[i], ctx.emittedToolCallCount + i);
        }
        ctx.emittedToolCallCount += newToolCalls.length;
      }
      if (ctx.qwenLogFile && localToolCalls.length > 0) {
        logQwenSSE(ctx.qwenLogFile, ctx.sseEventCount || 0, localToolCalls.length, localToolCalls);
      }
    }
    // Don't break on think-phase finished — with thinking_format=full,
    // answer content arrives in a separate answer phase after think completes.
    // For all other phases, mark as finished but still run content extraction:
    // content may be bundled in the same SSE event as the finished status.
    if (deltaPhase !== 'thinking_summary' && deltaPhase !== 'think') {
      streamFinished = true;
      // Fall through to content extraction so content in finished chunk isn't lost
    }
  }

  // Track SSE events for logging
  ctx.sseEventCount = (ctx.sseEventCount || 0) + 1;

  if (data['response.created']?.response_id) {
    if (!state.targetResponseId) state.targetResponseId = data['response.created'].response_id;
    state.nextParentId = data['response.created'].response_id;
  } else if (data.response_id && !state.targetResponseId) {
    state.targetResponseId = data.response_id;
    state.nextParentId = data.response_id;
  }

  if (data.usage) {
    if (data.usage.output_tokens) state.completionTokens = data.usage.output_tokens;
    if (data.usage.input_tokens) state.promptTokens = data.usage.input_tokens;
  }

  const deltaResult = extractDeltaContent(data, state.targetResponseId, state.currentThoughtIndex, state.reasoningBuffer);
  const { vStr, foundStr, isThinkingChunk } = deltaResult;
  state.currentThoughtIndex = deltaResult.currentThoughtIndex;

  if (!foundStr || vStr === '') return 'continue';
  if (vStr === 'FINISHED') return 'continue';

  if (isThinkingChunk) {
    if (state.reasoningBuffer.length < 20000) state.reasoningBuffer += vStr;
    // Write thinking content immediately for real-time reasoning_content streaming.
    // Clean XML artifacts to avoid leaking partial tool call syntax into reasoning (the
    // deferred flush was removed to prevent duplicate emission — every chunk is written once).
    if (vStr) {
      const cleaned = cleanTextOfXmlArtifacts(vStr).cleanedText;
      if (cleaned) {
        await writeReasoningEvent(streamWriter, completionId, model, cleaned);
      }
    }
    return 'continue';
  }

  if (SELF_CLOSING_TAG_PATTERN.test(vStr)) {
    return 'continue';
  }

  logStore.addRawChunk(logId, vStr);

  // Compute incremental delta for text content tracking
  let rawText = vStr;
  if (state.lastVStrRaw.length > 0) {
    const cumulativeDetection = detectCumulativeChunk(vStr, state.lastVStrRaw);
    if (cumulativeDetection.cumulative) {
      rawText = cumulativeDetection.delta;
      state.lastVStrRaw = vStr;
    } else if (!cumulativeDetection.delta) {
      rawText = '';
    } else {
      state.lastVStrRaw += vStr;
      if (state.lastVStrRaw.length > 100000) state.lastVStrRaw = state.lastVStrRaw.slice(-100000);
    }
  } else {
    state.lastVStrRaw = vStr;
  }

  // ── One-chunk buffer: delay chunks with '<' but no '>' ──────────
  // When an XML tag splits across SSE chunk boundaries (e.g. `<func` + `tion=read>`),
  // the first chunk has '<' without '>'. Delaying by 1 chunk lets us combine them
  // so cleanThinkTags sees the complete tag `<function=read>` and strips it via
  // prefix matching, instead of leaking partial fragments like `ction=read>`.
  //
  // If the combined text has '>', the tag completed — toolCallDepth handles suppression.
  // If it still has no '>', cleanThinkTags still catches partial tags via TOOL_TAG_RE
  // prefix matching (the `` clause handles non-tool-call `<` content like "x < 3").
  // MAX_BUFFER_CHARS prevents indefinite buffering of `<` in non-XML text.

  if (state.pendingChunk) {
    rawText = state.pendingChunk + rawText;
    state.pendingChunk = '';
  }

  if (rawText.includes('<') && !rawText.includes('>') && rawText.length < MAX_BUFFER_CHARS) {
    state.pendingChunk = rawText;
    return 'continue';
  }

  // At this point the text won't be delayed. Accumulate and process.
  state.lastRawContent += rawText;
  state.lastFullContent += rawText;

  // Performance: skip all downstream work when there's no new raw content.
  // This avoids the expensive parseXmlToolCalls (100KB buffer) and
  // filterContentPipeline on thinking-only or empty chunks.
  if (!rawText) return 'continue';

  // Track tool call depth to suppress content leaks from chunk-boundary fragments
  // When inside a tool call block (depth > 0), don't accumulate into
  // lastFilteredFullContent or emit content deltas to the client. The flush
  // path handles the clean version of the tool call text.
  const FKW = TOOL_CALL_KEYWORDS[0];
  const tagOpen = rawText.includes(`<${FKW}=`);
  const tagClose = rawText.includes(`</${FKW}>`);
  if (tagOpen) state.toolCallDepth++;
  if (tagClose) state.toolCallDepth = Math.max(0, state.toolCallDepth - 1);

  // Parse tool calls from the accumulated content
  const newToolCallContent = state.lastFullContent;
  const { toolCalls: xmlToolCalls } = parseXmlToolCalls(newToolCallContent);
  if (xmlToolCalls.length > 0) {
    const newToolCalls = xmlToolCalls.filter((tc) => {
      const key = `${tc.name}:${JSON.stringify(tc.parameters)}`;
      if (state.loggedToolCalls.has(key)) return false;
      state.loggedToolCalls.add(key);
      return true;
    });

    if (newToolCalls.length > 0) {
      logStore.updateEntry(logId, (entry) => {
        for (const tc of newToolCalls) {
          entry.parsedToolCalls.push({ name: tc.name, args: JSON.stringify(tc.parameters) });
        }
      });
    }

    for (const [i, tc] of newToolCalls.entries()) {
      const parsed = xmlToolCallToParsed(tc, ctx.emittedToolCallCount + i);
      await writeToolCallEvent(streamWriter, completionId, model, parsed, ctx.emittedToolCallCount + i);
    }
    ctx.emittedToolCallCount += newToolCalls.length;
  }

  // Truncate lastFullContent to prevent unbounded growth (M-10)
  // Use a generous limit (100000 chars ≈ 25000 tokens) so the content delta
  // pipeline always has stable, growing input for getSnapshotDelta to diff.
  // When truncation IS triggered, also reset the snapshot trackers so
  // filterContentPipeline rebuilds from scratch for the next chunk.
  if (state.lastFullContent.length > 100000) {
    const trimmedAmount = state.lastFullContent.length - 80000;
    state.lastFullContent = state.lastFullContent.slice(-80000);
    // Adjust parse position relative to the trim (don't reset to 0 — that
    // would re-parse the entire 80KB buffer, causing duplicate tool calls
    // and a burst of replayed content to the client).
    state.lastParsePosition = Math.max(0, state.lastParsePosition - trimmedAmount);
    state.lastFilteredSnapshot = '';
    state.lastThinkingSnapshot = '';
    state.lastFilteredFullContent = '';
    state.lastDeltaThinkingFull = '';
  }

  state.lastParsePosition = state.lastFullContent.length;

  if (state.loggedToolCalls.size > 500) state.loggedToolCalls.clear();

  // Incremental filtering: process only the new delta through the filter
  // pipeline instead of re-scanning the full accumulated buffer (up to 100KB)
  // on every chunk. Accumulate filtered output for snapshot diffing.
  //
  // Skip entirely when inside a tool call block (depth > 0): the filter
  // pipeline result would be discarded anyway (line 347 checks toolCallDepth),
  // but running it wastes regex cycles on content like "=filePath>" fragments.
  let deltaCleaned: string | null = null;
  let deltaThinking = '';
  if (state.toolCallDepth === 0) {
    const filterDelta = filterContentPipeline(rawText, enableContentFiltering, true);
    deltaCleaned = filterDelta.cleanText;
    deltaThinking = filterDelta.thinking;
  }

  // Only accumulate filtered content when outside a tool call block.
  // Inside a tool call (depth > 0), fragments like "-edit" or "=filePath>" would
  // leak through cleanThinkTags and corrupt the client's content stream.
  if (deltaCleaned && state.toolCallDepth === 0) state.lastFilteredFullContent = (state.lastFilteredFullContent || '') + deltaCleaned;
  if (deltaThinking) state.lastDeltaThinkingFull = (state.lastDeltaThinkingFull || '') + deltaThinking;

  const cleanedText = state.lastFilteredFullContent || null;
  const filteredThinking = state.lastDeltaThinkingFull || '';

  if (filteredThinking) {
    const thinkingDelta = getSnapshotDelta(filteredThinking, state.lastThinkingSnapshot);
    state.lastThinkingSnapshot = filteredThinking;
    if (thinkingDelta) {
      await writeReasoningEvent(streamWriter, completionId, model, thinkingDelta);
    }
  }

  if (cleanedText && state.toolCallDepth === 0) {
    // Text-only content (no tool calls): write content delta to SSE + logStore
    const contentDelta = getSnapshotDelta(cleanedText, state.lastFilteredSnapshot);
    state.lastFilteredSnapshot = cleanedText;
    if (contentDelta) {
      await writeContentDelta(
        streamWriter,
        completionId,
        model,
        contentDelta,
        ampState,
        logId,
        resolvedEmail,
        state.lastRawContent,
        state.lastVStrRaw,
        logStore,
      );
    }
  }

  if (streamFinished) return 'break_stream';
  return 'continue';
}
