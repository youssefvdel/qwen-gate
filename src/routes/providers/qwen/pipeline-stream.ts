/*
 * File: providers/qwen/pipeline-stream.ts
 * Qwen streaming pipeline — SSE read loop, per-chunk parsing, and post-completion flush.
 *
 * Single file merging what was 3 files (chatStreaming.ts + streamLoop.ts + chatStreamingHelpers.ts)
 * because they share types and are only consumed by the Qwen streaming path.
 * ~800 lines is fine — anthropic.ts is 935 lines.
 */

import crypto from 'node:crypto';
import type { Context } from 'hono';
import { stream as honoStream } from 'hono/streaming';
import { config } from '../../../services/configService.ts';
import { logStore } from '../../../services/logStore.ts';
import { logQwenSSE } from '../../../services/qwenLogger.ts';
import { sessionPool } from '../../../services/sessionPool.ts';
import { detectParallelToolLoop } from '../../../tools/guard.ts';
import { cleanTextOfXmlArtifacts, parseXmlToolCalls, xmlToolCallToParsed } from '../../../tools/xmlToolParser.ts';
import type { Message, OpenAIRequest, ParsedToolCall } from '../../../types/openai.ts';
import { filterContent } from '../../../utils/contentFilter.ts';
import { THINK_TAG_NAMES, TOOL_CALL_KEYWORDS } from '../../../utils/tagNames.ts';
import { detectCumulativeChunk, pendingCorrections } from '../../chatHelpersCore.ts';
import { buildChunkEvent, buildUsage, makeChoice, writeEvent, writeReasoningEvent, writeToolCallEvent } from '../../writeHelpers.ts';
import {
  type AmplificationGuardState,
  checkAmplificationGuard,
  checkFinalAmplification,
  cleanThinkTags,
  cleanupImmediately,
  extractDeltaContent,
  getSnapshotDelta,
  parseQwenErrorPayload,
  scheduleCleanup,
} from './qwen-utils.ts';

/**
 * Write a content delta event with amplification guard and log store update.
 * Returns false if the amplification guard suppressed the event.
 */
async function writeContentDelta(
  streamWriter: any,
  completionId: string,
  model: string,
  contentDelta: string,
  ampState: AmplificationGuardState,
  logId: string,
  resolvedEmail: string,
  lastRawContent: string,
  lastVStrRaw: string,
  logStore: { addProcessedOutput: (id: string, c: string) => void; updateEntry: (id: string, fn: (e: any) => void) => void },
): Promise<boolean> {
  if (checkAmplificationGuard(ampState, contentDelta.length, logId, resolvedEmail, model, lastRawContent, lastVStrRaw)) {
    return false;
  }
  logStore.addProcessedOutput(logId, contentDelta);
  ampState.emittedOutputBytes += contentDelta.length;
  await writeEvent(streamWriter, buildChunkEvent(completionId, model, [makeChoice({ content: contentDelta })]));
  return true;
}

// ── Constants ──────────────────────────────────────────────────────

const SELF_CLOSING_TAG_PATTERN = new RegExp(`^[\\n\\s]*<\\/?(?:${THINK_TAG_NAMES.join('|')})[\\s>]*[\\n\\s]*$`);
const MAX_BUFFER_CHARS = 200;

// ── Types ──────────────────────────────────────────────────────────

export interface StreamingContext {
  c: Context;
  logId: string;
  completionId: string;
  body: OpenAIRequest;
  session: { chatId: string; parentId: string | null; cachedHeaders: any; accountEmail?: string };
  stream: ReadableStream;
  qwenAbortController: AbortController;
  resolvedEmail: string;
  initialParentId: string | null;
  sessionHeaders: any;
  toolCalling: boolean;
  cleanOutput: boolean;
  qwenLogFile?: string;
}

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
  toolCallDepth: number;
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

interface StreamLoopResult {
  buffer: string;
  nextParentId: string | null;
  error?: string;
}

// ── Shared TextDecoder ─────────────────────────────────────────────

const sharedDecoder = new TextDecoder();

// ── Local MCP tool call extraction ─────────────────────────────────

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

// ── Shared content filter pipeline ─────────────────────────────────

export function filterContentPipeline(
  text: string,
  enableContentFiltering: boolean,
  skipXmlArtifactStripping?: boolean,
): { cleanText: string | null; thinking: string } {
  if (!text) return { cleanText: null, thinking: '' };
  if (skipXmlArtifactStripping) {
    const cleaned = cleanThinkTags(text);
    return { cleanText: cleaned || null, thinking: '' };
  }
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

// ── Per-chunk stream processing ────────────────────────────────────

export async function processStreamData(data: any, state: StreamProcessingState, ctx: StreamProcessingCtx): Promise<ProcessStreamResult> {
  const { streamWriter, completionId, model, enableContentFiltering, logId, resolvedEmail, ampState } = ctx;

  if (data.error) {
    const errMsg = typeof data.error === 'string' ? data.error : data.error.message || JSON.stringify(data.error);
    logStore.addError(logId, `Qwen upstream SSE error: ${errMsg}`);
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
    return 'break_stream';
  }
  let streamFinished = false;
  if (deltaStatus === 'finished') {
    const deltaPhase = data.choices[0].delta.phase;
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
    if (deltaPhase !== 'thinking_summary' && deltaPhase !== 'think') {
      streamFinished = true;
    }
  }

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

  if (state.pendingChunk) {
    rawText = state.pendingChunk + rawText;
    state.pendingChunk = '';
  }

  if (rawText.includes('<') && !rawText.includes('>') && rawText.length < MAX_BUFFER_CHARS) {
    state.pendingChunk = rawText;
    return 'continue';
  }

  state.lastRawContent += rawText;
  state.lastFullContent += rawText;

  if (!rawText) return 'continue';

  const FKW = TOOL_CALL_KEYWORDS[0];
  const tagOpen = rawText.includes(`<${FKW}=`);
  const tagClose = rawText.includes(`</${FKW}>`);
  if (tagOpen) state.toolCallDepth++;
  if (tagClose) state.toolCallDepth = Math.max(0, state.toolCallDepth - 1);

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

  if (state.lastFullContent.length > 100000) {
    const trimmedAmount = state.lastFullContent.length - 80000;
    state.lastFullContent = state.lastFullContent.slice(-80000);
    state.lastParsePosition = Math.max(0, state.lastParsePosition - trimmedAmount);
    state.lastFilteredSnapshot = '';
    state.lastThinkingSnapshot = '';
    state.lastFilteredFullContent = '';
    state.lastDeltaThinkingFull = '';
  }

  state.lastParsePosition = state.lastFullContent.length;

  if (state.loggedToolCalls.size > 500) state.loggedToolCalls.clear();

  let deltaCleaned: string | null = null;
  let deltaThinking = '';
  if (state.toolCallDepth === 0) {
    const filterDelta = filterContentPipeline(rawText, enableContentFiltering, true);
    deltaCleaned = filterDelta.cleanText;
    deltaThinking = filterDelta.thinking;
  }

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

// ── SSE read loop ──────────────────────────────────────────────────

async function runStreamLoop(
  c: { req: { raw?: { signal?: AbortSignal } } },
  reader: ReadableStreamDefaultReader<Uint8Array>,
  streamState: StreamProcessingState,
  streamCtx: StreamProcessingCtx,
  ampState: AmplificationGuardState,
  bufferRef: { text: string },
): Promise<StreamLoopResult> {
  let streamDone = false;
  let nextParentId = streamState.nextParentId;

  while (true) {
    if (streamDone) break;
    if (c.req.raw?.signal?.aborted) {
      reader.cancel();
      break;
    }

    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let readResult: Awaited<ReturnType<typeof reader.read>>;
    let idleTimedOut = false;
    try {
      readResult = await Promise.race([
        reader.read(),
        new Promise<any>((_, reject) => {
          idleTimer = setTimeout(
            () => {
              idleTimedOut = true;
              reject(
                new Error(
                  `Upstream stream idle timeout — no data for ${Math.max(10_000, config.getInt('STREAM_IDLE_TIMEOUT_MS', 60000)) / 1000}s`,
                ),
              );
            },
            Math.max(10_000, config.getInt('STREAM_IDLE_TIMEOUT_MS', 60000)),
          );
        }),
      ]);
    } catch (timeoutErr) {
      if (idleTimer) clearTimeout(idleTimer);
      if (!idleTimedOut) await reader.cancel();
      return { buffer: bufferRef.text, nextParentId, error: (timeoutErr as Error).message };
    }
    if (idleTimer) clearTimeout(idleTimer);
    if (readResult.done) break;
    if (readResult.value) ampState.rawInputBytes += readResult.value.length;

    const rawDecoded = sharedDecoder.decode(readResult.value, { stream: true });
    bufferRef.text += rawDecoded;
    const lines = bufferRef.text.split('\n');
    bufferRef.text = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;

      const dataStr = trimmed.slice(6);
      if (dataStr === '[DONE]') {
        streamDone = true;
        break;
      }

      try {
        const chunk = JSON.parse(dataStr);
        const result = await processStreamData(chunk, streamState, streamCtx);
        if (result === 'break_stream') {
          streamDone = true;
          break;
        }
      } catch (e) {
        console.error('[Chat] Streaming: parse error on chunk, ignoring partial:', (e as Error)?.message, 'raw:', dataStr.slice(0, 200));
      }
    }
    nextParentId = streamState.nextParentId;
  }

  return { buffer: bufferRef.text, nextParentId };
}

// ── Post-stream completion ─────────────────────────────────────────

async function handlePostStreamCompletion(
  args: {
    streamWriter: any;
    completionId: string;
    model: string;
    streamState: StreamProcessingState;
    ampState: AmplificationGuardState;
    logId: string;
    resolvedEmail: string;
    emittedToolCallCount: number;
    buffer: string;
    enableContentFiltering: boolean;
    includeUsage: boolean;
  },
  cleanup: {
    reader: ReadableStreamDefaultReader<Uint8Array>;
    heartbeatInterval: any;
    chatId: string;
    sessionHeaders: any;
    email: string;
    sessionPool: { release: (chatId: string, parentId: string | null, headers: any, email: string) => void };
  },
): Promise<void> {
  const {
    streamWriter,
    completionId,
    model,
    streamState,
    ampState,
    logId,
    resolvedEmail,
    emittedToolCallCount,
    buffer,
    enableContentFiltering,
    includeUsage,
  } = args;
  const { reader, heartbeatInterval, chatId, sessionHeaders, email, sessionPool } = cleanup;

  try {
    const upstreamError = parseQwenErrorPayload(buffer);
    if (upstreamError) {
      try {
        require('fs').writeFileSync('/tmp/qwen-error-buffer.json', buffer.slice(0, 10000));
      } catch (e) {}
      const cleanErrorMessage = cleanTextOfXmlArtifacts(upstreamError.message).cleanedText || upstreamError.message;
      await writeEvent(streamWriter, buildChunkEvent(completionId, model, [makeChoice({ content: cleanErrorMessage })]));
      await writeEvent(streamWriter, buildChunkEvent(completionId, model, [makeChoice({}, 'stop')]));
      await streamWriter.write('data: [DONE]\n\n');
      logStore.updateEntry(logId, (entry) => {
        entry.finalResponse = entry.finalResponse || { finishReason: '', toolCallCount: 0, contentPreview: '' };
        entry.finalResponse.finishReason = 'upstream_error';
      });
      logStore.finalizeRequest(logId);
      return;
    }

    if (streamState.pendingChunk) {
      streamState.lastFullContent += streamState.pendingChunk;
      streamState.pendingChunk = '';
    }

    const finalToolCalls = streamState.lastFullContent ? parseXmlToolCalls(streamState.lastFullContent).toolCalls.length : 0;
    const effectiveToolCallCount = Math.max(emittedToolCallCount, finalToolCalls);

    // ── Loop detection ────────────────────────────────────────────
    const correctionPrompts: string[] = [];
    if (effectiveToolCallCount >= 3) {
      const allToolCalls = streamState.lastFullContent ? parseXmlToolCalls(streamState.lastFullContent).toolCalls : [];
      const parsedForLoopCheck: ParsedToolCall[] = allToolCalls.map((tc: any, i: number) => ({
        id: `call_stream_${i}`,
        name: tc.name || 'unknown',
        arguments: typeof tc.parameters === 'object' && tc.parameters !== null ? tc.parameters : {},
      }));
      const loopCheck = detectParallelToolLoop(parsedForLoopCheck);
      if (!loopCheck.ok) {
        correctionPrompts.push(loopCheck.correctionPrompt);
        logStore.addError(logId, `Parallel loop: ${loopCheck.errors[0]}`);
      }
    }

    // Persist correction prompts so they survive account rotation
    if (correctionPrompts.length > 0) {
      pendingCorrections.set(chatId, [...correctionPrompts]);
      if (resolvedEmail) pendingCorrections.set(resolvedEmail, [...correctionPrompts]);
      pendingCorrections.set('__echo_retry__', [...correctionPrompts]);
    }

    if (streamState.lastFullContent && effectiveToolCallCount > emittedToolCallCount) {
      const parsed = parseXmlToolCalls(streamState.lastFullContent).toolCalls;
      for (const tc of parsed.slice(emittedToolCallCount)) {
        logStore.updateEntry(logId, (entry) => {
          entry.parsedToolCalls.push({ name: tc.name, args: JSON.stringify(tc.parameters) });
        });
      }
    }

    const pipelineResult = filterContentPipeline(streamState.lastFullContent, enableContentFiltering);
    const flushCleaned = pipelineResult.cleanText;
    const flushThinking = pipelineResult.thinking;

    if (flushThinking) {
      const thinkDelta = getSnapshotDelta(flushThinking, streamState.lastThinkingSnapshot);
      if (thinkDelta) {
        streamState.lastThinkingSnapshot = flushThinking;
        await writeReasoningEvent(streamWriter, completionId, model, thinkDelta);
      }
    }
    if (flushCleaned) {
      const contentDelta = getSnapshotDelta(flushCleaned, streamState.lastFilteredSnapshot);
      if (contentDelta) {
        streamState.lastFilteredSnapshot = flushCleaned;
        if (
          checkAmplificationGuard(
            ampState,
            contentDelta.length,
            logId,
            resolvedEmail,
            model,
            streamState.lastRawContent,
            streamState.lastVStrRaw,
          )
        ) {
          // guard triggered — skip content emission
        } else {
          const ct = contentDelta.replace(/[\n\s]*$/, '');
          if (ct) {
            logStore.addProcessedOutput(logId, ct);
            ampState.emittedOutputBytes += ct.length;
            await writeEvent(streamWriter, buildChunkEvent(completionId, model, [makeChoice({ content: ct })]));
          }
        }
      }
    }

    const usage = buildUsage(streamState.promptTokens, streamState.completionTokens, streamState.reasoningBuffer);
    const finalFinishReason = effectiveToolCallCount > 0 ? 'tool_calls' : 'stop';

    await writeEvent(
      streamWriter,
      buildChunkEvent(completionId, model, [makeChoice({}, finalFinishReason)], includeUsage ? undefined : { usage }),
    );

    if (includeUsage) {
      await writeEvent(streamWriter, buildChunkEvent(completionId, model, [], { usage }));
    }
    await streamWriter.write('data: [DONE]\n\n');

    checkFinalAmplification(ampState, logId, resolvedEmail, logStore);

    logStore.updateEntry(logId, (entry) => {
      const now = Date.now();
      const startedAt = new Date(entry.timestamp).getTime();
      if (startedAt) entry.latency_ms = now - startedAt;
      if (streamState.lastFullContent) entry.remainingText = streamState.lastFullContent;
      if (streamState.reasoningBuffer) entry.reasoningContent = streamState.reasoningBuffer;
      entry.finalResponse = {
        finishReason: finalFinishReason || 'stop',
        toolCallCount: effectiveToolCallCount,
        contentPreview: (streamState.lastFullContent || '').substring(0, 100),
      };
    });

    logStore.finalizeRequest(logId);
  } catch (err) {
    console.error('[Chat] handlePostStreamCompletion error:', err);
    logStore.addError(logId, err instanceof Error ? err.message : String(err));
    logStore.updateEntry(logId, (entry) => {
      if (streamState.lastFullContent) entry.remainingText = streamState.lastFullContent;
      if (streamState.reasoningBuffer) entry.reasoningContent = streamState.reasoningBuffer;
      entry.finalResponse = entry.finalResponse || { finishReason: 'error', toolCallCount: 0, contentPreview: '' };
    });
    logStore.finalizeRequest(logId);
    try {
      await streamWriter.write('data: [DONE]\n\n');
    } catch {
      /* stream may already be closed */
    }
  } finally {
    scheduleCleanup(reader, heartbeatInterval, chatId, streamState.nextParentId, sessionHeaders, email, sessionPool);
  }
}

// ── Streaming orchestrator ─────────────────────────────────────────

function createHeartbeat(streamWriter: any): any {
  const hb = setInterval(async () => {
    try {
      await streamWriter.write(': keep-alive\n\n');
    } catch {
      clearInterval(hb);
    }
  }, 15000);
  if (hb && typeof hb.unref === 'function') hb.unref();
  return hb;
}

function buildInitialStreamState(finalPrompt: string, initialParentId: string | null): StreamProcessingState {
  return {
    targetResponseId: null,
    nextParentId: initialParentId,
    completionTokens: 0,
    promptTokens: Math.ceil(finalPrompt.length / 3.5),
    currentThoughtIndex: 0,
    reasoningBuffer: '',
    lastFullContent: '',
    lastRawContent: '',
    lastFilteredSnapshot: '',
    lastThinkingSnapshot: '',
    lastVStrRaw: '',
    lastFilteredFullContent: '',
    lastDeltaThinkingFull: '',
    loggedToolCalls: new Set(),
    lastParsePosition: 0,
    toolCallDepth: 0,
    pendingChunk: '',
  };
}

function buildPromptString(messages: Message[]): string {
  return messages
    .map((m) => {
      const content = Array.isArray(m.content)
        ? m.content.map((c: any) => c.text || JSON.stringify(c)).join('\n')
        : String(m.content ?? '');
      return `${m.role}: ${content}`;
    })
    .join('\n\n');
}

export async function handleStreamingRequest(ctx: StreamingContext): Promise<Response> {
  const { c, logId, completionId, body, session, stream, qwenAbortController, resolvedEmail, sessionHeaders, cleanOutput } = ctx;

  const finalPrompt = buildPromptString(body.messages);

  c.header('Content-Type', 'text/event-stream');
  c.header('Cache-Control', 'no-cache');
  c.header('Connection', 'close');

  return honoStream(c, async (streamWriter: any) => {
    const _streamStartTime = Date.now();
    logStore.log('debug', 'stream', `[Stream] >>> Streaming started for ${logId}, model=${body.model}, tools=${body.tools?.length || 0}`);
    let streamReleased = false;
    let heartbeatInterval: any;
    let streamReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    const ampState: AmplificationGuardState = { rawInputBytes: 0, emittedOutputBytes: 0, triggered: false };

    try {
      heartbeatInterval = createHeartbeat(streamWriter);
      await writeEvent(streamWriter, buildChunkEvent(completionId, body.model, [makeChoice({ role: 'assistant', content: '' })]));

      streamReader = stream.getReader();
      const reader: ReadableStreamDefaultReader<Uint8Array> = streamReader;
      const enableContentFiltering = cleanOutput;
      const streamState = buildInitialStreamState(finalPrompt, ctx.initialParentId);

      const streamCtx: StreamProcessingCtx = {
        streamWriter,
        completionId,
        model: body.model,
        enableContentFiltering,
        cleanOutput,
        logId,
        resolvedEmail,
        ampState,
        qwenAbortController,
        qwenLogFile: ctx.qwenLogFile,
        emittedToolCallCount: 0,
      };

      const bufferRef = { text: '' };
      const loopResult = await runStreamLoop(c, reader, streamState, streamCtx, ampState, bufferRef);

      if (loopResult.error) {
        logStore.log('debug', 'stream', `[Chat] Stream timeout for ${logId}: ${loopResult.error}`);
        logStore.addError(logId, loopResult.error);
        await streamWriter.write('data: [DONE]\n\n');
        logStore.updateEntry(logId, (entry) => {
          if (streamState.reasoningBuffer) entry.reasoningContent = streamState.reasoningBuffer;
          if (streamState.lastFullContent) entry.remainingText = streamState.lastFullContent;
          entry.finalResponse = entry.finalResponse || { finishReason: '', toolCallCount: 0, contentPreview: '' };
          entry.finalResponse.finishReason = 'error';
        });
        logStore.finalizeRequest(ctx.logId);
        cleanupImmediately(
          streamReader,
          heartbeatInterval,
          session.chatId,
          ctx.initialParentId,
          sessionHeaders,
          resolvedEmail,
          sessionPool,
          false,
        );
        streamReleased = true;
        return;
      }

      const handlePostStreamCompletionArgs = {
        streamWriter,
        completionId,
        model: body.model,
        streamState,
        ampState,
        logId,
        resolvedEmail,
        emittedToolCallCount: streamCtx.emittedToolCallCount,
        buffer: loopResult.buffer,
        enableContentFiltering,
        includeUsage: !!body.stream_options?.include_usage,
      };
      const cleanup = {
        reader: streamReader,
        heartbeatInterval,
        chatId: session.chatId,
        sessionHeaders,
        email: resolvedEmail,
        sessionPool,
      };

      await handlePostStreamCompletion(handlePostStreamCompletionArgs, { ...cleanup, reader: reader });

      streamReleased = true;
      logStore.log('debug', 'stream', `[Stream] <<< Streaming completed for ${logId} in ${Date.now() - _streamStartTime}ms`);
    } finally {
      if (!streamReleased) {
        try {
          await streamWriter.write('data: [DONE]\n\n');
        } catch {
          /* stream may already be closed */
        }
        logStore.updateEntry(logId, (entry) => {
          entry.finalResponse = entry.finalResponse || { finishReason: '', toolCallCount: 0, contentPreview: '' };
          entry.finalResponse.finishReason = entry.finalResponse.finishReason || 'error';
        });
        logStore.finalizeRequest(ctx.logId);
        cleanupImmediately(
          streamReader,
          heartbeatInterval,
          session.chatId,
          ctx.initialParentId,
          sessionHeaders,
          resolvedEmail,
          sessionPool,
          false,
        );
      }
    }
  });
}
