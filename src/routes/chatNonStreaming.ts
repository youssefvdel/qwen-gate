import { Context } from 'hono';
import { logStore } from '../services/logStore.ts';
import { sessionPool } from '../services/sessionPool.ts';
import { detectParallelToolLoop } from '../tools/guard.ts';
import type { Message, OpenAIRequest, ParsedToolCall } from '../types/openai.ts';
import { filterContent } from '../utils/contentFilter.ts';
import {
  commonPrefixLen,
  detectCumulativeChunk,
  parseQwenErrorPayload,
  pendingCorrections,
  processToolCallsThroughGuard,
  ToolSpamGuard,
} from './chatHelpers.ts';

const MAX_TOOL_CALLS_PER_TURN = 8;

import { cleanTextOfXmlArtifacts, parseXmlToolCalls, xmlToolCallToParsed } from '../tools/xmlToolParser.ts';
import { extractLocalMcpToolCalls } from './chatStreamingHelpers.ts';

export interface NonStreamingContext {
  c: Context;
  logId: string;
  completionId: string;
  body: OpenAIRequest;
  session: { chatId: string; parentId: string | null; cachedHeaders: any; accountEmail?: string };
  stream: ReadableStream;
  resolvedEmail: string;
  initialParentId: string | null;
  sessionHeaders: any;
  toolCalling: boolean;
  cleanOutput: boolean;
}

interface StreamProcessorState {
  reader: ReadableStreamDefaultReader;
  decoder: TextDecoder;
  currentThoughtIndex: number;
  reasoningBuffer: string;
  lastFullContent: string;
  lastParsedPosition: number;
  targetResponseId: string | null;
  toolCallsOut: any[];
  correctionPrompts: string[];
  toolSpamGuard: ToolSpamGuard;
  buffer: string;
  completionTokens: number;
  promptTokens: number;
  nextParentId: string | null;
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

function buildQwenRequest(ctx: NonStreamingContext): StreamProcessorState {
  const reader = ctx.stream.getReader();
  const finalPrompt = buildPromptString(ctx.body.messages);
  return {
    reader,
    decoder: new TextDecoder(),
    currentThoughtIndex: 0,
    reasoningBuffer: '',
    lastFullContent: '',
    lastParsedPosition: 0,
    targetResponseId: null,
    toolCallsOut: [],
    correctionPrompts: [],
    toolSpamGuard: new ToolSpamGuard(),
    buffer: '',
    completionTokens: 0,
    promptTokens: Math.ceil(finalPrompt.length / 3.5),
    nextParentId: ctx.initialParentId,
  };
}

function processThinkingDelta(delta: any, state: StreamProcessorState): void {
  // Handle thinking_summary format (thinking_format: "summary")
  // Content is in extra.summary_thought.content[] array
  if (delta.phase === 'thinking_summary') {
    const thoughts = delta.extra?.summary_thought?.content;
    if (!thoughts) return;

    const rawNew = thoughts.slice(state.currentThoughtIndex).join('\n');
    if (!rawNew) return;

    const commonLen = commonPrefixLen(rawNew, state.reasoningBuffer);
    const vStr = rawNew.substring(commonLen);
    if (!vStr) return;

    state.currentThoughtIndex = thoughts.length;
    state.reasoningBuffer += vStr;
    return;
  }

  // Handle think format (thinking_format: "full")
  // Content is in delta.content (token-by-token)
  if (delta.phase === 'think') {
    if (delta.content !== undefined && delta.content !== '') {
      state.reasoningBuffer += delta.content;
    }
    return;
  }
}

function processAnswerDelta(delta: any, state: StreamProcessorState, ctx: NonStreamingContext): void {
  if (delta.content === undefined) return;
  const vStr = delta.content || '';
  if (!vStr || vStr === 'FINISHED') return;

  logStore.addRawChunk(ctx.logId, vStr);

  if (vStr) {
    if (state.lastFullContent.length > 0) {
      const detection = detectCumulativeChunk(vStr, state.lastFullContent);
      state.lastFullContent = detection.cumulative ? vStr : state.lastFullContent + vStr;
    } else {
      state.lastFullContent = vStr;
    }
  }

  const contentToCheck = state.lastFullContent.substring(state.lastParsedPosition);
  if (contentToCheck.length > 0) {
    const { toolCalls } = parseXmlToolCalls(contentToCheck);
    if (toolCalls.length > 0) {
      const parsed = toolCalls.map((tc, i) => xmlToolCallToParsed(tc, i));
      processToolCallsThroughGuard(parsed, state.toolCallsOut, {
        logId: ctx.logId,
        toolSpamGuard: state.toolSpamGuard,
        correctionPrompts: state.correctionPrompts,
        maxToolCalls: MAX_TOOL_CALLS_PER_TURN,
        logParsed: true,
      });
    }
    state.lastParsedPosition = state.lastFullContent.length;
  }
}

function parseQwenResponse(line: string, state: StreamProcessorState, ctx: NonStreamingContext): void {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('data: ')) return;

  const dataStr = trimmed.slice(6);
  if (dataStr === '[DONE]') return;

  let chunk: any;
  try {
    chunk = JSON.parse(dataStr);
  } catch (e) {
    console.error('[Chat] Non-streaming: parse error on chunk, ignoring partial:', (e as Error)?.message);
    return;
  }

  // Detect upstream Qwen SSE error payload mid-stream
  if (chunk.error) {
    const errMsg = typeof chunk.error === 'string' ? chunk.error : chunk.error.message || JSON.stringify(chunk.error);
    logStore.addError(ctx.logId, `Qwen upstream SSE error: ${errMsg}`);
    return;
  }
  const deltaStatus = chunk.choices?.[0]?.delta?.status;
  if (deltaStatus === 'error') {
    logStore.addError(ctx.logId, 'Qwen stream delta returned error status');
    return;
  }

  if (chunk['response.created']?.response_id) {
    if (!state.targetResponseId) state.targetResponseId = chunk['response.created'].response_id;
    state.nextParentId = chunk['response.created'].response_id;
  } else if (chunk.response_id && !state.targetResponseId) {
    state.targetResponseId = chunk.response_id;
    state.nextParentId = chunk.response_id;
  }

  if (chunk.usage) {
    if (chunk.usage.output_tokens) state.completionTokens = chunk.usage.output_tokens;
    if (chunk.usage.input_tokens) state.promptTokens = chunk.usage.input_tokens;
  }

  const delta = chunk.choices?.[0]?.delta;
  if (!delta) return;
  if (
    state.targetResponseId !== null &&
    chunk.response_id !== state.targetResponseId &&
    chunk['response.created']?.response_id !== state.targetResponseId
  )
    return;

  if (delta.phase === 'think' || delta.phase === 'thinking_summary') {
    processThinkingDelta(delta, state);
  } else if (delta.phase === 'answer') {
    processAnswerDelta(delta, state, ctx);
  } else if (delta.phase === 'local_tool') {
    // Qwen returns tool calls in the local_tool phase via extra.local_mcp["★"].
    // These may arrive with or without XML tool call blocks in the answer phase,
    // so we must extract them here to avoid losing tool calls.
    const localToolCalls = extractLocalMcpToolCalls(chunk);
    if (localToolCalls.length > 0) {
      processToolCallsThroughGuard(localToolCalls, state.toolCallsOut, {
        logId: ctx.logId,
        toolSpamGuard: state.toolSpamGuard,
        correctionPrompts: state.correctionPrompts,
        maxToolCalls: MAX_TOOL_CALLS_PER_TURN,
        logParsed: true,
      });
    }
  }
}

function flushAndDetectLoops(state: StreamProcessorState, logId: string): void {
  const { toolCalls } = parseXmlToolCalls(state.lastFullContent);
  if (toolCalls.length > 0) {
    const parsed = toolCalls.map((tc, i) => xmlToolCallToParsed(tc, i));
    // Filter out already-processed tool calls to avoid corrupting ToolSpamGuard state
    // Stable dedup: sort object keys so property order doesn't cause false negatives
    const stableArgs = (args: Record<string, unknown>): string => {
      const keys = Object.keys(args).sort();
      return '{' + keys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(args[k])}`).join(',') + '}';
    };
    const newCalls = parsed.filter((tc) => {
      const tcArgsStr = stableArgs(tc.arguments as Record<string, unknown>);
      return !state.toolCallsOut.some((existing) => {
        let existingArgs: Record<string, unknown> = {};
        try {
          existingArgs = JSON.parse(existing.function.arguments);
        } catch {
          /* ignore */
        }
        return existing.function.name === tc.name && stableArgs(existingArgs) === tcArgsStr;
      });
    });
    if (newCalls.length > 0) {
      processToolCallsThroughGuard(newCalls, state.toolCallsOut, {
        logId,
        toolSpamGuard: state.toolSpamGuard,
        correctionPrompts: state.correctionPrompts,
        maxToolCalls: MAX_TOOL_CALLS_PER_TURN,
        label: 'xml-flush',
        logParsed: true,
      });
    }
  }

  if (state.toolCallsOut.length < 3) return;

  const parsedForLoopCheck: ParsedToolCall[] = state.toolCallsOut.map((tc: any) => ({
    id: tc.id,
    name: tc.function.name,
    arguments: (() => {
      try {
        return JSON.parse(tc.function.arguments);
      } catch {
        return {};
      }
    })(),
  }));
  const loopCheck = detectParallelToolLoop(parsedForLoopCheck);
  if (!loopCheck.ok) {
    logStore.log('debug', 'chat', `[🔄 PARALLEL LOOP] ${loopCheck.errors[0]}`);
    state.correctionPrompts.push(loopCheck.correctionPrompt);
    logStore.addError(logId, `Parallel loop: ${loopCheck.errors[0]}`);
    // Filter out duplicate tool calls from the response
    if (loopCheck.valid && loopCheck.valid.length < parsedForLoopCheck.length) {
      const validIds = new Set(loopCheck.valid.map((v) => v.id));
      state.toolCallsOut = state.toolCallsOut.filter((tc) => validIds.has(tc.id));
    }
  }
}

function buildResponseFromState(state: StreamProcessorState, ctx: NonStreamingContext): Response {
  const { c, logId, completionId, body, session, cleanOutput } = ctx;

  const reasoningTokensEstimate = state.reasoningBuffer ? Math.ceil(state.reasoningBuffer.length / 4) : 0;
  const usage = {
    prompt_tokens: state.promptTokens,
    completion_tokens: state.completionTokens,
    total_tokens: state.promptTokens + state.completionTokens,
    completion_tokens_details: { reasoning_tokens: reasoningTokensEstimate },
    prompt_tokens_details: { cached_tokens: 0 },
  };

  const contentForUser = cleanTextOfXmlArtifacts(state.lastFullContent).cleanedText;
  state.lastFullContent = contentForUser;
  const { cleanText: baseFilteredContent, thinking: filteredReasoning } = cleanOutput
    ? filterContent(state.lastFullContent)
    : { cleanText: state.lastFullContent, thinking: '' };
  if (filteredReasoning) {
    state.reasoningBuffer = state.reasoningBuffer ? state.reasoningBuffer + '\n' + filteredReasoning : filteredReasoning;
  }

  const filteredContent = baseFilteredContent;

  const message: any = { role: 'assistant', content: state.toolCallsOut.length ? null : filteredContent };
  if (state.reasoningBuffer) message.reasoning_content = state.reasoningBuffer;
  if (state.toolCallsOut.length) {
    state.toolCallsOut.forEach((tc, idx) => (tc.index = idx));
    message.tool_calls = state.toolCallsOut;
  }

  logStore.updateEntry(logId, (entry) => {
    const now = Date.now();
    const startedAt = new Date(entry.timestamp).getTime();
    if (startedAt) entry.latency_ms = now - startedAt;
    entry.finalResponse = {
      finishReason: state.toolCallsOut.length ? 'tool_calls' : 'stop',
      toolCallCount: state.toolCallsOut.length,
      contentPreview: state.lastFullContent.length > 500 ? state.lastFullContent.substring(0, 500) + '...' : state.lastFullContent,
    };
    entry.rawFullContent = state.lastFullContent;
    entry.remainingText = state.lastFullContent;
  });

  for (const prompt of state.correctionPrompts) {
    logStore.addError(logId, prompt);
  }

  logStore.addProcessedOutput(logId, filteredContent);

  if (state.correctionPrompts.length > 0) {
    pendingCorrections.set(session.chatId, [...state.correctionPrompts]);
  }

  return c.json({
    id: completionId,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: body.model,
    system_fingerprint: 'fp_qwen_gate',
    service_tier: 'default',
    choices: [
      {
        index: 0,
        message,
        logprobs: null,
        finish_reason: state.toolCallsOut.length ? 'tool_calls' : 'stop',
      },
    ],
    usage,
  });
}

async function processContentChunks(state: StreamProcessorState, ctx: NonStreamingContext): Promise<Response> {
  const { c, logId } = ctx;

  const upstreamError = parseQwenErrorPayload(state.buffer);
  if (upstreamError) {
    logStore.finalizeRequest(logId);
    const cleanMessage = cleanTextOfXmlArtifacts(upstreamError.message).cleanedText || upstreamError.message;
    return c.json({ error: { message: cleanMessage } }, upstreamError.status);
  }

  flushAndDetectLoops(state, logId);
  const response = buildResponseFromState(state, ctx);
  logStore.finalizeRequest(logId);
  return response;
}

export async function handleNonStreamingRequest(ctx: NonStreamingContext): Promise<Response> {
  const { session, sessionHeaders, resolvedEmail } = ctx;
  const state = buildQwenRequest(ctx);
  let nonStreamReleased = false;
  let logFinalized = false;

  try {
    while (true) {
      const { done, value } = await state.reader.read();
      if (done) break;

      state.buffer += state.decoder.decode(value, { stream: true });
      const lines = state.buffer.split('\n');
      state.buffer = lines.pop() || '';

      for (const line of lines) {
        parseQwenResponse(line, state, ctx);
      }
    }

    nonStreamReleased = true;
    sessionPool.release(session.chatId, state.nextParentId, sessionHeaders, resolvedEmail);
    const result = await processContentChunks(state, ctx);
    logFinalized = true;
    return result;
  } finally {
    if (!logFinalized) logStore.finalizeRequest(ctx.logId);
    try {
      state.reader.cancel();
    } catch {
      /* reader already cancelled */
    }
    try {
      state.reader.releaseLock();
    } catch {
      /* reader already cancelled */
    }
    if (!nonStreamReleased) {
      sessionPool.release(session.chatId, state.nextParentId, sessionHeaders, resolvedEmail, false);
    }
  }
}
