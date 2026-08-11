import crypto from 'node:crypto';
import { Context } from 'hono';
import { stream as honoStream } from 'hono/streaming';
import { pickAccount, throttleAccount } from '../services/auth.ts';
import { config } from '../services/configService.ts';
import { logStore } from '../services/logStore.ts';
import { modelRouter } from '../services/modelRouter.ts';
import { RetryableQwenStreamError } from '../services/qwen.ts';
import type { QwenFileAttachment } from '../services/qwenFileUpload.ts';
import { uploadImageAsFile, uploadLargeTextAsFile } from '../services/qwenFileUpload.ts';
import { sessionPool } from '../services/sessionPool.ts';
import { cleanTextOfXmlArtifacts, parseXmlToolCalls, xmlToolCallToParsed } from '../tools/xmlToolParser.ts';
import type { OpenAIRequest, ParsedToolCall } from '../types/openai.ts';
import { resolveThinkingLevel } from '../utils/thinkingLevel.ts';
import { checkContextWindow, estimateTokens } from '../utils/tokenEstimator.ts';
import {
  acquireSessionWithCorrections,
  buildQwenMessages,
  createQwenStreamWithRetry,
  extractDeltaContent,
  getModelSpecs,
  handleImageModelFallback,
} from './chatHelpers.ts';
import type { NonStreamingContext } from './chatNonStreaming.ts';
import { handleNonStreamingRequest } from './chatNonStreaming.ts';
import { extractLocalMcpToolCalls } from './chatStreamingHelpers.ts';

// ── Anthropic → Qwen model map ─────────────────────────────────────

// ponytail: use dotted model names matching the Qwen API (/v1/models response).
// Routing matches the family keyword anywhere in the name so both current
// (claude-sonnet-4-…) and legacy (claude-3-5-sonnet-20241022) spellings work:
//   Opus   → qwen3.8-max  (flagship)
//   Sonnet → qwen3.7-max  (workhorse)
//   Haiku  → qwen3.7-plus (fast/vision)
const QWEN_MODEL_BY_TIER: Array<[pattern: RegExp, model: string]> = [
  [/\bopus\b/i, 'qwen3.8-max'],
  [/\bsonnet\b/i, 'qwen3.7-max'],
  [/\bhaiku\b/i, 'qwen3.7-plus'],
];
const DEFAULT_QWEN_MODEL = 'qwen3.8-max';

function mapModel(anthropicModel: string): string {
  for (const [pattern, model] of QWEN_MODEL_BY_TIER) {
    if (pattern.test(anthropicModel)) return model;
  }
  return DEFAULT_QWEN_MODEL;
}

// ── Request conversion ─────────────────────────────────────────────

interface AnthropicContentBlock {
  type: string;
  text?: string;
  source?: { type: string; media_type?: string; data?: string };
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string | AnthropicContentBlock[];
}

interface AnthropicMessage {
  role: string;
  content: string | AnthropicContentBlock[];
}

function anthropicMessagesToOpenAI(messages: AnthropicMessage[], system?: string): any[] {
  const out: any[] = [];
  if (system) {
    out.push({ role: 'system', content: system });
  }
  for (const msg of messages) {
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        out.push({ role: 'user', content: msg.content });
      } else if (Array.isArray(msg.content)) {
        const textParts: string[] = [];
        const imageParts: any[] = [];
        let hasToolResult = false;
        for (const block of msg.content) {
          if (block.type === 'text') {
            textParts.push(block.text || '');
          } else if (block.type === 'image') {
            const src = block.source;
            if (src?.type === 'base64' && src.media_type && src.data) {
              imageParts.push({ type: 'image_url', image_url: { url: `data:${src.media_type};base64,${src.data}` } });
            } else if (src?.type === 'url' && src.data) {
              imageParts.push({ type: 'image_url', image_url: { url: src.data } });
            }
          } else if (block.type === 'tool_result') {
            hasToolResult = true;
            const tc = typeof block.content === 'string' ? block.content : '';
            out.push({ role: 'tool', tool_call_id: block.tool_use_id, content: tc });
          } else {
            console.warn(`[Anthropic] Unknown content block: ${block.type}`);
          }
        }
        if (!hasToolResult) {
          if (imageParts.length > 0) {
            const content: any[] = [];
            if (textParts.length > 0) content.push({ type: 'text', text: textParts.join('\n') });
            content.push(...imageParts);
            out.push({ role: 'user', content });
          } else {
            out.push({ role: 'user', content: textParts.join('\n') });
          }
        }
      }
    } else if (msg.role === 'assistant') {
      if (typeof msg.content === 'string') {
        out.push({ role: 'assistant', content: msg.content });
      } else if (Array.isArray(msg.content)) {
        const textParts: string[] = [];
        const toolCalls: any[] = [];
        for (const block of msg.content) {
          if (block.type === 'text') {
            textParts.push(block.text || '');
          } else if (block.type === 'tool_use') {
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: { name: block.name, arguments: JSON.stringify(block.input || {}) },
            });
          } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
            // ponytail: skip thinking blocks — model reasoning, not input to Qwen
          } else {
            console.warn(`[Anthropic] Unknown assistant block: ${block.type}`);
          }
        }
        const text = textParts.join('\n');
        if (toolCalls.length > 0) {
          out.push({ role: 'assistant', content: text || null, tool_calls: toolCalls });
        } else {
          out.push({ role: 'assistant', content: text });
        }
      }
    }
  }
  return out;
}

function anthropicToolsToOpenAI(tools?: any[]): any[] {
  if (!tools?.length) return [];
  return tools.map((t: any) => ({
    type: 'function',
    function: { name: t.name, description: t.description || '', parameters: t.input_schema || { type: 'object', properties: {} } },
  }));
}

// ── Response conversion ────────────────────────────────────────────

function finishReasonToAnthropic(reason: string): string {
  if (reason === 'stop') return 'end_turn';
  if (reason === 'tool_calls') return 'tool_use';
  if (reason === 'length') return 'max_tokens';
  return 'end_turn';
}

// ponytail: normalize Qwen tool name case to match Claude Code conventions
function normalizeToolName(name: string): string {
  const CASE_MAP: Record<string, string> = {
    bash: 'Bash',
    read: 'Read',
    edit: 'Edit',
    write: 'Write',
    websearch: 'WebSearch',
    web_search: 'WebSearch',
  };
  return CASE_MAP[name] || name;
}

// ponytail: simple formatter for Anthropic content blocks in log display
function formatContent(content: any): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content);
  return content
    .map((b: any) => {
      if (b.type === 'text') return b.text || '';
      if (b.type === 'tool_use') return `[Tool: ${b.name}]`;
      if (b.type === 'tool_result') {
        const r = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
        return `[Result: ${r}]`;
      }
      if (b.type === 'thinking') return '';
      return JSON.stringify(b);
    })
    .filter(Boolean)
    .join('\n');
}

function convertOpenAIResponseToAnthropic(openAIResp: any, requestModel: string): any {
  const choice = openAIResp.choices?.[0];
  const message = choice?.message || {};
  const content: any[] = [];
  if (message.content) {
    content.push({ type: 'text', text: message.content });
  }

  // ponytail: static Claude Code required param map — adapt if tools vary
  const REQUIRED_PARAMS: Record<string, string[]> = {
    Bash: ['command'],
    Read: ['filePath'],
    Edit: ['filePath', 'oldString', 'newString'],
    Write: ['filePath', 'content'],
  };

  function mapParamName(paramName: string): string {
    const SNAKE_TO_CAMEL: Record<string, string> = {
      file_path: 'filePath',
      old_string: 'oldString',
      new_string: 'newString',
    };
    return SNAKE_TO_CAMEL[paramName] || paramName;
  }

  function isValidToolCall(name: string, args: any): boolean {
    const required = REQUIRED_PARAMS[name];
    if (required) {
      const missing = required.filter((p) => args[p] === undefined || args[p] === null || args[p] === '');
      if (missing.length > 0) return false;
    } else if (!args || typeof args !== 'object' || Object.keys(args).length === 0) {
      return false;
    }
    return true;
  }

  if (message.tool_calls) {
    for (const tc of message.tool_calls) {
      let args: any = {};
      try {
        args = JSON.parse(tc.function.arguments);
      } catch {
        /* ignore */
      }
      if (!args || typeof args !== 'object') continue;
      // Map snake_case to camelCase
      const mapped: any = {};
      for (const [k, v] of Object.entries(args)) {
        mapped[mapParamName(k)] = v;
      }
      const normalizedName = normalizeToolName(tc.function.name);
      if (!isValidToolCall(normalizedName, mapped)) {
        logStore.log(
          'debug',
          'chat',
          `[Anthropic] Skipped invalid tool call in non-streaming: ${tc.function?.name} args=${JSON.stringify(mapped)}`,
        );
        continue;
      }
      content.push({ type: 'tool_use', id: tc.id, name: normalizedName, input: mapped });
    }
  }
  // Anthropic doesn't send text + tool_use together — prefer tool_use
  if (content.length > 1 && content.some((c: any) => c.type === 'tool_use')) {
    const toolBlocks = content.filter((c: any) => c.type === 'tool_use');
    content.length = 0;
    content.push(...toolBlocks);
  }
  return {
    id: 'msg_' + crypto.randomUUID(),
    type: 'message',
    role: 'assistant',
    content,
    model: requestModel,
    stop_reason: finishReasonToAnthropic(choice?.finish_reason),
    stop_sequence: null,
    usage: { input_tokens: openAIResp.usage?.prompt_tokens || 0, output_tokens: openAIResp.usage?.completion_tokens || 0 },
  };
}

// ── Session setup (mirrors chat.ts setupSession) ───────────────────

const MAX_ACCOUNT_RETRIES = 5;

async function setupAnthropicSession(
  messages: any[],
  body: OpenAIRequest,
  availableTokens: number,
  toolCalling: boolean,
  logId: string,
): Promise<{
  sessionMessages: any[];
  session: { chatId: string; parentId: string | null; cachedHeaders: any; accountEmail?: string };
  nextParentId: string | null;
  sessionHeaders: any;
  resolvedEmail: string;
  stream: ReadableStream;
  qwenAbortController: AbortController;
}> {
  let hasImages = false;
  const imageUrls: string[] = [];
  const lastMsg = messages[messages.length - 1];
  if (lastMsg && Array.isArray(lastMsg.content)) {
    for (const part of lastMsg.content) {
      if (part?.type === 'image_url' && part?.image_url?.url) {
        hasImages = true;
        imageUrls.push(part.image_url.url);
      }
    }
  }
  let cleanedMessages = messages;
  if (hasImages) {
    cleanedMessages = messages.map((msg: any, idx: number) => {
      if (idx !== messages.length - 1) return msg;
      if (!Array.isArray(msg.content)) return msg;
      const textParts = msg.content.filter((c: any) => c.type !== 'image_url');
      return { ...msg, content: textParts.length > 0 ? textParts : [{ type: 'text', text: '[Image]' }] };
    });
  }

  const { qwenMessages: processedMessages, toolResultsContent } = buildQwenMessages(cleanedMessages, body, availableTokens, toolCalling);

  const MAX_INLINE_CHARS = 50000;
  let inlineContent = processedMessages[0].content as string;
  let chatHistoryContent = '';
  if (typeof inlineContent === 'string' && inlineContent.length > MAX_INLINE_CHARS) {
    const parts = inlineContent.split(/\n\n(?=<user>|<assist>)/);
    let keptLen = 0;
    let splitIdx = parts.length;
    for (let i = parts.length - 1; i >= 0; i--) {
      const addLen = parts[i].length + (keptLen > 0 ? 2 : 0);
      if (keptLen + addLen <= MAX_INLINE_CHARS) {
        keptLen += addLen;
        splitIdx = i;
      } else break;
    }
    if (splitIdx > 0) {
      chatHistoryContent = parts.slice(0, splitIdx).join('\n\n');
      inlineContent = parts.slice(splitIdx).join('\n\n');
      processedMessages[0] = { ...processedMessages[0], content: inlineContent };
    }
  }

  let lastFailedEmail: string | undefined;
  const isThinkingModel = body.thinkingLevel !== 'off' && !body.model.includes('no-thinking');
  let lastError: any;

  for (let attempt = 0; attempt < MAX_ACCOUNT_RETRIES; attempt++) {
    const selectedAccount = await pickAccount(lastFailedEmail);
    const accountEmail = selectedAccount?.email;
    logStore.log(
      'debug',
      'chat',
      `[Anthropic] Attempt ${attempt + 1}/${MAX_ACCOUNT_RETRIES} picked=${accountEmail || 'NONE'} lastFailed=${lastFailedEmail || 'none'}`,
    );
    if (!selectedAccount && attempt > 0) {
      logStore.log(
        'error',
        'chat',
        `[Anthropic] All ${MAX_ACCOUNT_RETRIES} attempts exhausted — last error: ${lastError?.message || lastError || 'unknown'}`,
      );
      throw lastError || new Error('All accounts are rate-limited. Please wait and try again later.');
    }

    let imageFiles: QwenFileAttachment[] = [];
    if (hasImages && accountEmail) {
      const MAX_CONCURRENT = 2;
      for (let i = 0; i < imageUrls.length; i += MAX_CONCURRENT) {
        const batch = imageUrls.slice(i, i + MAX_CONCURRENT);
        const results = await Promise.all(
          batch.map((url) =>
            uploadImageAsFile(accountEmail, url).catch((err: any) => {
              logStore.log('warn', 'chat', `[Anthropic] Image upload failed: ${err.message}`);
              return null;
            }),
          ),
        );
        imageFiles.push(...results.filter((f): f is QwenFileAttachment => f !== null));
      }
      if (imageFiles.length === 0) {
        throw new Error('Failed to upload images — none could be uploaded');
      }
    }

    if (accountEmail && (toolResultsContent || chatHistoryContent)) {
      const parts: string[] = [];
      parts.push(
        `<REFERENCE_CONTEXT>\nThe following are older tool results and chat history from this conversation.\nThey are background reference — the actual current request appears inline above.\nRead them only if you need details not present inline.\n</REFERENCE_CONTEXT>`,
      );
      if (toolResultsContent) parts.push(`<tool-results>\n${toolResultsContent}\n</tool-results>`);
      if (chatHistoryContent) parts.push(`<chat_history>\n${chatHistoryContent}\n</chat_history>`);
      try {
        const file = await uploadLargeTextAsFile(accountEmail, parts.join('\n\n'), 'context.txt');
        processedMessages[0] = { ...processedMessages[0], files: [file] };
      } catch (err: any) {
        logStore.log('debug', 'chat', '[Anthropic] Failed to upload context file: ' + (err.message || err));
      }
    }

    if (imageFiles.length > 0) {
      processedMessages[0] = {
        ...processedMessages[0],
        files: [...(processedMessages[0].files || []), ...imageFiles],
      };
    }

    let sessionResult;
    try {
      sessionResult = await acquireSessionWithCorrections(accountEmail, processedMessages);
    } catch (err) {
      lastFailedEmail = accountEmail;
      lastError = err;
      logStore.log(
        'warn',
        'chat',
        `[Anthropic] Session acquire failed for ${accountEmail || '?'}: ${err instanceof Error ? err.message : String(err)}`,
      );
      logStore.addError(logId, `Session acquire failed for ${accountEmail || '?'}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const { session, qwenMessages: sessionMessages, nextParentId, sessionHeaders, resolvedEmail } = sessionResult;
    logStore.log('debug', 'chat', `[Anthropic] Session acquired: ${resolvedEmail} chatId=${session.chatId}`);
    logStore.updateEntry(logId, (entry) => {
      entry.accountEmail = resolvedEmail;
    });

    let streamResult;
    try {
      const routedModel = await modelRouter.route(body.model);
      streamResult = await createQwenStreamWithRetry(
        sessionMessages,
        isThinkingModel,
        routedModel,
        session.chatId,
        nextParentId,
        resolvedEmail,
        body.tools,
        body.tool_choice,
      );
    } catch (err: any) {
      sessionPool.release(session.chatId, nextParentId, sessionHeaders, resolvedEmail, false);
      logStore.log(
        'warn',
        'chat',
        `[Anthropic] Stream failed on ${resolvedEmail}: ${err.message || err} (attempt ${attempt + 1}/${MAX_ACCOUNT_RETRIES}) upstreamStatus=${err.upstreamStatus || 'none'} name=${err.name || 'Error'}`,
      );
      logStore.addError(logId, `Stream creation failed for ${resolvedEmail}: ${err.message || String(err)}`);
      if (err.upstreamStatus === 429 || /RateLimited|daily usage limit/i.test(err.message || '')) {
        logStore.log('warn', 'chat', `[Anthropic]   -> rate-limited, trying next account`);
        lastFailedEmail = resolvedEmail;
        lastError = err;
        continue;
      }
      if (
        (err.message || '').includes('FAIL_SYS_USER_VALIDATE') ||
        (err.message || '').includes('CAPTCHA') ||
        err instanceof RetryableQwenStreamError
      ) {
        logStore.log('warn', 'chat', `[Anthropic]   -> CAPTCHA/validation, throttling + trying next`);
        lastFailedEmail = resolvedEmail;
        lastError = err;
        if (resolvedEmail) throttleAccount(resolvedEmail, 5 * 60 * 1000);
        continue;
      }
      if (
        err.name === 'AbortError' ||
        (err.message || '').includes('timed out') ||
        (err.message || '').includes('timeout') ||
        (err.message || '').includes('ETIMEDOUT') ||
        err.upstreamStatus === 408 ||
        err.upstreamStatus === 504
      ) {
        logStore.log('warn', 'chat', `[Anthropic]   -> timeout, trying next account`);
        lastFailedEmail = resolvedEmail;
        lastError = err;
        continue;
      }
      logStore.log('error', 'chat', `[Anthropic]   -> non-retryable error, throwing`);
      throw err;
    }
    let { stream, abortController: qwenAbortController } = streamResult;

    const FIRST_CHUNK_MS = 60_000;
    const streamReader = stream.getReader();
    let firstChunk: any;
    let firstChunkTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      firstChunk = await Promise.race([
        streamReader.read(),
        new Promise<never>((_, reject) => {
          firstChunkTimer = setTimeout(
            () => reject(new Error(`No first chunk from ${resolvedEmail} within ${FIRST_CHUNK_MS / 1000}s`)),
            FIRST_CHUNK_MS,
          );
        }),
      ]);
    } catch (timeoutErr) {
      clearTimeout(firstChunkTimer);
      logStore.log('warn', 'chat', `[Anthropic] First-chunk timeout for ${resolvedEmail} (attempt ${attempt + 1})`);
      logStore.addError(logId, `First-chunk timeout for ${resolvedEmail}`);
      streamReader.cancel().catch(() => {});
      qwenAbortController?.abort();
      sessionPool.release(session.chatId, nextParentId, sessionHeaders, resolvedEmail, false);
      lastFailedEmail = resolvedEmail;
      lastError = timeoutErr as Error;
      continue;
    }
    clearTimeout(firstChunkTimer);

    stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        if (!firstChunk.done && firstChunk.value) controller.enqueue(firstChunk.value);
        try {
          while (true) {
            const { done, value } = await streamReader.read();
            if (done) break;
            controller.enqueue(value);
          }
          controller.close();
        } catch (err) {
          controller.error(err);
        }
      },
    });

    const finalPrompt = sessionMessages
      .map((m: any) => {
        const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
        return `${m.role}: ${content}`;
      })
      .join('\n\n');
    logStore.updateEntry(logId, (entry) => {
      entry.promptToQwen = {
        systemPromptLength: 0,
        totalLength: finalPrompt.length,
        preview: finalPrompt.length > 1000 ? finalPrompt.substring(0, 1000) + '...' : finalPrompt,
      };
    });
    logStore.log('debug', 'chat', `[Anthropic] Request routed to ${resolvedEmail} — stream ready (attempt ${attempt + 1})`);

    return { sessionMessages, session, nextParentId, sessionHeaders, resolvedEmail, stream, qwenAbortController };
  }

  throw lastError || new Error('All accounts are rate-limited. Please wait and try again later.');
}

// ── Anthropic SSE streaming ────────────────────────────────────────

async function handleAnthropicStream(
  c: Context,
  anthropicModel: string,
  logId: string,
  session: { chatId: string; parentId: string | null; cachedHeaders: any; accountEmail?: string },
  stream: ReadableStream,
  qwenAbortController: AbortController,
  resolvedEmail: string,
  nextParentId: string | null,
  sessionHeaders: any,
  promptTokenEstimate: number = 0,
): Promise<Response> {
  c.header('Content-Type', 'text/event-stream');
  c.header('Cache-Control', 'no-cache');
  c.header('Connection', 'close');

  return honoStream(c, async (streamWriter: any) => {
    // Ping keepalive every 10s (issue 5)
    const pingInterval = setInterval(() => {
      if (streamWriter.aborted || streamWriter.closed) {
        clearInterval(pingInterval);
        return;
      }
      streamWriter.write('event: ping\ndata: {"type":"ping"}\n\n').catch(() => clearInterval(pingInterval));
    }, 10_000);

    // Clean up ping on abort
    streamWriter.onAbort(() => clearInterval(pingInterval));

    let streamReleased = false;
    let streamReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    try {
      streamReader = stream.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let emittedMessageStart = false;
      let emittedThinkingBlock = false;
      let emittedTextBlock = false;
      let lastFullContent = '';
      let targetResponseId: string | null = null;
      let currentThoughtIndex = 0;
      let reasoningBuffer = '';
      let completionTokens = 0;
      let promptTokensFromChunks = 0;
      let localToolCallsAccum: any[] = [];
      let hasEmittedContent = false;
      let textBlockIndex = 0;

      const STREAM_IDLE_TIMEOUT = Math.max(10_000, config.getInt('STREAM_IDLE_TIMEOUT_MS', 60_000));

      while (true) {
        let idleTimer: ReturnType<typeof setTimeout> | undefined;
        let readResult: { done: boolean; value?: Uint8Array };
        try {
          readResult = await Promise.race([
            streamReader.read(),
            new Promise<any>((_, reject) => {
              idleTimer = setTimeout(
                () => reject(new Error(`Stream idle timeout — no data for ${STREAM_IDLE_TIMEOUT / 1000}s`)),
                STREAM_IDLE_TIMEOUT,
              );
            }),
          ]);
        } catch (streamErr: any) {
          logStore.log('warn', 'chat', `[Anthropic] ${streamErr.message || 'Stream read error'} (logId=${logId})`);
          break;
        } finally {
          if (idleTimer) clearTimeout(idleTimer);
        }
        if (readResult.done) break;
        if (readResult.value) {
          buffer += decoder.decode(readResult.value, { stream: true });
        } else {
          continue;
        }
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          const dataStr = trimmed.slice(6);
          if (dataStr === '[DONE]') continue;
          let chunk: any;
          try {
            chunk = JSON.parse(dataStr);
          } catch {
            continue;
          }
          // ponytail: qwenRawChunks stores text content, not raw SSE JSON
          // raw SSE is not stored — qwenRawChunks tracks each content delta

          if (chunk['response.created']?.response_id) {
            if (!targetResponseId) targetResponseId = chunk['response.created'].response_id;
          } else if (chunk.response_id && !targetResponseId) {
            targetResponseId = chunk.response_id;
          }

          if (chunk.usage) {
            if (chunk.usage.output_tokens) completionTokens = chunk.usage.output_tokens;
            if (chunk.usage.input_tokens) promptTokensFromChunks = chunk.usage.input_tokens;
          }

          // Extract local MCP tool calls
          const deltaStatus = chunk.choices?.[0]?.delta?.status;
          const deltaPhase = chunk.choices?.[0]?.delta?.phase;
          if (deltaStatus === 'finished' && deltaPhase === 'local_tool') {
            const calls = extractLocalMcpToolCalls(chunk);
            logStore.log('debug', 'chat', `[Anthropic] local_mcp SSE chunk: extracted ${calls.length} tool calls`);
            for (const c of calls) {
              logStore.log('debug', 'chat', `[Anthropic] local_mcp tool: name=${c.name} id=${c.id} args=${JSON.stringify(c.arguments)}`);
              if (!localToolCallsAccum.some((e) => e.id === c.id)) localToolCallsAccum.push(c);
            }
          }

          const deltaResult = extractDeltaContent(chunk, targetResponseId, currentThoughtIndex, reasoningBuffer);
          if (!deltaResult.foundStr || !deltaResult.vStr) continue;

          currentThoughtIndex = deltaResult.currentThoughtIndex;

          // Handle thinking chunks — emit Anthropic thinking blocks
          if (deltaResult.isThinkingChunk) {
            if (reasoningBuffer.length < 20000) reasoningBuffer += deltaResult.vStr;

            // Emit message_start if not yet done
            if (!emittedMessageStart) {
              const msgId = 'msg_' + crypto.randomUUID();
              await streamWriter.write(
                `event: message_start\ndata: ${JSON.stringify({
                  type: 'message_start',
                  message: {
                    id: msgId,
                    type: 'message',
                    role: 'assistant',
                    content: [],
                    model: anthropicModel,
                    stop_reason: null,
                    stop_sequence: null,
                    usage: { input_tokens: promptTokenEstimate, output_tokens: 0 },
                  },
                })}\n\n`,
              );
              emittedMessageStart = true;
            }

            // Emit thinking content_block_start on first thinking delta
            if (!emittedThinkingBlock) {
              await streamWriter.write(
                `event: content_block_start\ndata: ${JSON.stringify({
                  type: 'content_block_start',
                  index: 0,
                  content_block: { type: 'thinking', thinking: '' },
                })}\n\n`,
              );
              emittedThinkingBlock = true;
              textBlockIndex = 1;
            }

            // Emit thinking delta
            await streamWriter.write(
              `event: content_block_delta\ndata: ${JSON.stringify({
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'thinking_delta', thinking: deltaResult.vStr },
              })}\n\n`,
            );

            continue; // skip text block handling below
          }

          // ── Text/answer chunks ──────────────────────────────────

          // Emit message_start on first text delta if not already emitted (no thinking)
          if (!emittedMessageStart) {
            const msgId = 'msg_' + crypto.randomUUID();
            await streamWriter.write(
              `event: message_start\ndata: ${JSON.stringify({
                type: 'message_start',
                message: {
                  id: msgId,
                  type: 'message',
                  role: 'assistant',
                  content: [],
                  model: anthropicModel,
                  stop_reason: null,
                  stop_sequence: null,
                  usage: { input_tokens: promptTokenEstimate, output_tokens: 0 },
                },
              })}\n\n`,
            );
            emittedMessageStart = true;
          }

          // Close thinking block if it was started (now transitioning to text)
          if (emittedThinkingBlock && !emittedTextBlock) {
            await streamWriter.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
          }

          // Emit text content_block_start on first text delta
          if (!emittedTextBlock) {
            await streamWriter.write(
              `event: content_block_start\ndata: ${JSON.stringify({
                type: 'content_block_start',
                index: textBlockIndex,
                content_block: { type: 'text', text: '' },
              })}\n\n`,
            );
            emittedTextBlock = true;
          }

          // Strip XML tool call artifacts from emitted text (Claude Code may
          // fall back to parsing tool calls from text content, and XML artifacts
          // can produce spurious tool calls or confuse the client).
          const cleanedText = cleanTextOfXmlArtifacts(deltaResult.vStr).cleanedText || '';

          // Emit cleaned text delta to Claude Code
          await streamWriter.write(
            `event: content_block_delta\ndata: ${JSON.stringify({
              type: 'content_block_delta',
              index: textBlockIndex,
              delta: { type: 'text_delta', text: cleanedText },
            })}\n\n`,
          );

          // Accumulate RAW text (with XML) for XML fallback tool call parsing
          lastFullContent += deltaResult.vStr;
          logStore.addProcessedOutput(logId, cleanedText);
          logStore.addRawChunk(logId, deltaResult.vStr);
          hasEmittedContent = true;
        }
      }

      // Stream ended — emit close events
      logStore.log(
        'debug',
        'chat',
        `[Anthropic] Stream ended. lastFullContent length=${lastFullContent.length}, localToolCallsAccum=${localToolCallsAccum.length}`,
      );

      const { toolCalls: xmlToolCalls } = parseXmlToolCalls(lastFullContent);
      const xmlParsedCalls = xmlToolCalls.map((tc, i) => xmlToolCallToParsed(tc, i));
      logStore.log('debug', 'chat', `[Anthropic] XML parsed from text: ${xmlParsedCalls.length} tool calls`);
      for (const tc of xmlParsedCalls) {
        logStore.log('debug', 'chat', `[Anthropic] XML tool: name=${tc.name} id=${tc.id} args=${JSON.stringify(tc.arguments)}`);
      }

      const allToolCalls = [...xmlParsedCalls];
      for (const ltc of localToolCallsAccum) {
        if (!allToolCalls.some((e) => e.id === ltc.id)) {
          logStore.log('debug', 'chat', `[Anthropic] Merging local_mcp tool: name=${ltc.name} id=${ltc.id}`);
          allToolCalls.push(ltc);
        } else {
          logStore.log('debug', 'chat', `[Anthropic] Skipping duplicate local_mcp tool (already in XML): name=${ltc.name} id=${ltc.id}`);
        }
      }
      logStore.log(
        'debug',
        'chat',
        `[Anthropic] Merged tool calls: ${allToolCalls.length} total (${xmlParsedCalls.length} XML + ${localToolCallsAccum.length} local_mcp)`,
      );

      // Log raw tool calls from Qwen before filtering
      for (const tc of allToolCalls) {
        logStore.log(
          'debug',
          'chat',
          `[Anthropic] Raw tool call from Qwen: name=${tc.name} id=${tc.id} args=${JSON.stringify(tc.arguments)} source=${tc.id.startsWith('call_xml') ? 'xml' : 'local_mcp'}`,
        );
      }

      // Validate and filter tool calls
      // ponytail: static Claude Code required param map — upgrade if tools vary
      const REQUIRED_PARAMS: Record<string, string[]> = {
        Bash: ['command'],
        Read: ['filePath'],
        Edit: ['filePath', 'oldString', 'newString'],
        Write: ['filePath', 'content'],
      };

      // ponytail: snake_case → camelCase mapping for Qwen param names
      function mapParamName(toolName: string, paramName: string): string {
        const SNAKE_TO_CAMEL: Record<string, string> = {
          file_path: 'filePath',
          old_string: 'oldString',
          new_string: 'newString',
          tool_call_id: 'toolCallId',
        };
        return SNAKE_TO_CAMEL[paramName] || paramName;
      }

      function validateToolCall(tc: ParsedToolCall): { valid: boolean; fixedArgs: any } {
        let args: any = {};
        try {
          args = typeof tc.arguments === 'string' ? JSON.parse(tc.arguments) : tc.arguments;
        } catch {
          /* ignore */
        }
        if (!args || typeof args !== 'object') return { valid: false, fixedArgs: {} };

        // Map snake_case to camelCase
        const mapped: any = {};
        for (const [k, v] of Object.entries(args)) {
          mapped[mapParamName(tc.name, k)] = v;
        }
        args = mapped;

        const toolName = normalizeToolName(tc.name);
        const required = REQUIRED_PARAMS[toolName];
        if (required) {
          const missing = required.filter((p) => args[p] === undefined || args[p] === null || args[p] === '');
          if (missing.length > 0) {
            logStore.log(
              'debug',
              'chat',
              `[Anthropic] Skipped tool call: ${tc.name} missing required params: ${missing.join(', ')} (had: ${JSON.stringify(args)})`,
            );
            return { valid: false, fixedArgs: args };
          }
        } else if (Object.keys(args).length === 0) {
          logStore.log('debug', 'chat', `[Anthropic] Skipped tool call: ${tc.name} (no params)`);
          return { valid: false, fixedArgs: {} };
        }

        return { valid: true, fixedArgs: args };
      }

      const validToolCalls: ParsedToolCall[] = [];
      const validArgs: any[] = [];
      for (const tc of allToolCalls) {
        const result = validateToolCall(tc);
        if (result.valid) {
          const normalizedName = normalizeToolName(tc.name);
          logStore.log(
            'debug',
            'chat',
            `[Anthropic] VALID tool call: original_name=${tc.name} normalized_name=${normalizedName} id=${tc.id} args=${JSON.stringify(result.fixedArgs)}`,
          );
          validToolCalls.push({ ...tc, name: normalizedName });
          validArgs.push(result.fixedArgs);
        } else {
          logStore.log(
            'debug',
            'chat',
            `[Anthropic] SKIPPED tool call (invalid): name=${tc.name} id=${tc.id} args=${JSON.stringify(tc.arguments)} reason=missing_required_params`,
          );
        }
      }

      logStore.log(
        'debug',
        'chat',
        `[Anthropic] Tool call summary: ${allToolCalls.length} raw → ${validToolCalls.length} valid → emitting ${validToolCalls.length} tool_use blocks`,
      );
      // Close text or thinking block
      if (emittedTextBlock) {
        await streamWriter.write(
          `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: textBlockIndex })}\n\n`,
        );
      } else if (emittedThinkingBlock && !emittedTextBlock) {
        await streamWriter.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
      }

      // Emit tool_use content blocks using pre-validated calls
      // ponytail: full args JSON in one delta since we know it upfront (local_mcp/XML)
      let blockIndex = emittedTextBlock ? textBlockIndex + 1 : emittedThinkingBlock ? 1 : 0;
      for (let i = 0; i < validToolCalls.length; i++) {
        const tc = validToolCalls[i];
        const args = validArgs[i];
        // content_block_start with empty input per spec
        await streamWriter.write(
          `event: content_block_start\ndata: ${JSON.stringify({
            type: 'content_block_start',
            index: blockIndex,
            content_block: { type: 'tool_use', id: tc.id, name: tc.name, input: {} },
          })}\n\n`,
        );
        // input_json_delta with full args JSON
        await streamWriter.write(
          `event: content_block_delta\ndata: ${JSON.stringify({
            type: 'content_block_delta',
            index: blockIndex,
            delta: { type: 'input_json_delta', partial_json: JSON.stringify(args) },
          })}\n\n`,
        );
        await streamWriter.write(
          `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: blockIndex })}\n\n`,
        );
        blockIndex++;
      }

      // Emit message_delta
      const stopReason = validToolCalls.length > 0 ? 'tool_use' : emittedThinkingBlock && !emittedTextBlock ? 'end_turn' : 'end_turn';
      await streamWriter.write(
        `event: message_delta\ndata: ${JSON.stringify({
          type: 'message_delta',
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: { output_tokens: completionTokens, input_tokens: promptTokensFromChunks || promptTokenEstimate },
        })}\n\n`,
      );

      // Emit message_stop
      await streamWriter.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);

      // Populate log entry fields before finalizing
      logStore.updateEntry(logId, (entry) => {
        entry.reasoningContent = reasoningBuffer || undefined;
        entry.rawFullContent = lastFullContent || reasoningBuffer;
        entry.processedApiOutput = lastFullContent || reasoningBuffer;
        entry.parsedToolCalls = validToolCalls.map((tc) => ({
          name: tc.name,
          args: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments),
        }));
        entry.finalResponse = {
          finishReason: stopReason,
          toolCallCount: validToolCalls.length,
          contentPreview: (lastFullContent || reasoningBuffer).substring(0, 500),
        };
      });

      streamReleased = true;
      logStore.finalizeRequest(logId, {
        latencyMs: undefined, // rely on entry timestamp
        tokens: {
          prompt: promptTokensFromChunks || promptTokenEstimate,
          completion: completionTokens,
          total: (promptTokensFromChunks || promptTokenEstimate) + completionTokens,
        },
        finishReason: stopReason,
      });
      sessionPool.release(session.chatId, nextParentId, sessionHeaders, resolvedEmail);
    } catch (streamErr: any) {
      logStore.addError(logId, streamErr.message || String(streamErr));
    } finally {
      clearInterval(pingInterval);
      if (!streamReleased) {
        logStore.finalizeRequest(logId, {
          finishReason: 'error',
        });
        try {
          sessionPool.release(session.chatId, nextParentId, sessionHeaders, resolvedEmail, false);
        } catch {
          /* ignore */
        }
      }
    }
  });
}

// ── Main handler ───────────────────────────────────────────────────

export async function anthropicMessages(c: Context) {
  const logId = crypto.randomUUID();
  const _requestStartTime = Date.now();

  // Watchdog: log if request hangs without response
  const watchdogTimer = setTimeout(() => {
    const elapsed = Date.now() - _requestStartTime;
    logStore.log('warn', 'chat', `[Anthropic] WATCHDOG: request still in-flight after ${elapsed}ms (logId=${logId})`);
  }, 15_000);
  const cancelWatchdog = () => {
    clearTimeout(watchdogTimer);
  };

  let anthropicVersion: string | undefined;
  let anthropicBeta: string | undefined;

  try {
    const rawBody = await c.req.json();

    // Read Anthropic-specific headers (issue 4)
    anthropicVersion = c.req.header('anthropic-version');
    anthropicBeta = c.req.header('anthropic-beta');
    if (anthropicVersion) logStore.log('debug', 'chat', `[Anthropic] anthropic-version: ${anthropicVersion}`);
    if (anthropicBeta) logStore.log('debug', 'chat', `[Anthropic] anthropic-beta: ${anthropicBeta}`);

    // Extract Anthropic-format parameters
    const anthropicModel: string = rawBody.model || '';
    const system: string | undefined = rawBody.system;
    const maxTokens: number | undefined = rawBody.max_tokens;
    const messages: AnthropicMessage[] = rawBody.messages || [];
    const tools: any[] | undefined = rawBody.tools;
    const isStream = rawBody.stream ?? false;
    const toolCalling = config.getBool('TOOL_CALLING', true);
    const stopSequences: string[] | undefined = rawBody.stop_sequences;
    const metadata: Record<string, string> | undefined = rawBody.metadata;
    if (stopSequences?.length)
      logStore.log('debug', 'chat', `[Anthropic] stop_sequences received: ${stopSequences.join(', ')} — not supported by Qwen, ignoring`);
    if (metadata) logStore.log('debug', 'chat', `[Anthropic] metadata received: ${JSON.stringify(metadata)}`);
    const cleanOutput = config.getBool('CLEAN_OUTPUT', true);

    // Convert Anthropic tool_choice to OpenAI format (issue 8)
    // NOTE: Qwen doesn't enforce tool_choice — tools via feature_config.local_mcp always allow free choice.
    const rawToolChoice = rawBody.tool_choice;
    let toolChoice: any = undefined;
    if (rawToolChoice === 'any') {
      toolChoice = 'required';
      logStore.log('debug', 'chat', `[Anthropic] tool_choice='any' → 'required' (informational — Qwen ignores it)`);
    } else if (rawToolChoice === 'auto') {
      toolChoice = 'auto';
    } else if (rawToolChoice && typeof rawToolChoice === 'object' && rawToolChoice.type === 'tool') {
      toolChoice = { type: 'function', function: { name: rawToolChoice.name } };
      logStore.log(
        'warn',
        'chat',
        `[Anthropic] tool_choice={type:"tool", name:"${rawToolChoice.name}"} — Qwen does not restrict tools, all tools may be called`,
      );
    }

    // Map model
    const mappedModel = mapModel(anthropicModel);

    // Resolve thinking level from Claude Code's `thinking` block (budget_tokens)
    // + THINKING_MODE config. Levels: off / summary / full.
    const thinkingLevel = resolveThinkingLevel({
      mode: config.get('THINKING_MODE', 'auto'),
      model: mappedModel,
      intent: rawBody.thinking ? { ...rawBody.thinking } : undefined,
    });
    if (rawBody.thinking) {
      logStore.log('debug', 'chat', `[Anthropic] thinking=${JSON.stringify(rawBody.thinking)} → level=${thinkingLevel}`);
    }

    // Convert messages and tools to OpenAI format
    const openaiMessages = anthropicMessagesToOpenAI(messages, system);
    const convertedTools = anthropicToolsToOpenAI(tools);

    // Build synthetic OpenAIRequest
    const body: OpenAIRequest = {
      model: mappedModel,
      messages: openaiMessages,
      stream: false,
      thinkingLevel,
      ...(convertedTools.length > 0 && { tools: convertedTools }),
      ...(toolChoice && { tool_choice: toolChoice }),
    };

    logStore.log(
      'debug',
      'chat',
      `[Anthropic] Request: model=${mappedModel} stream=${isStream} msgs=${openaiMessages.length} tools=${convertedTools.length} max_tokens=${maxTokens}`,
    );
    logStore.log(
      'debug',
      'chat',
      `[Anthropic] Raw model=${anthropicModel} mapped=${mappedModel} ${messages.length} messages, last_role=${messages[messages.length - 1]?.role} msg0_content_type=${typeof messages[0]?.content} ${Array.isArray(messages[0]?.content) ? 'array[' + messages[0].content.length + ']' : 'string'}`,
    );
    logStore.createEntry(logId, mappedModel, isStream);
    logStore.updateEntry(logId, (entry) => {
      entry.apiType = 'anthropic';
      const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
      const lastContent = lastMsg?.content;
      const lastStr = formatContent(lastContent);
      entry.clientRequest = {
        messageCount: messages.length,
        roles: messages.map((m: any) => m.role),
        hasTools: !!body.tools?.length,
        toolNames: body.tools?.map((t: any) => t.function?.name || t.name) || [],
        tool_choice: body.tool_choice ? (typeof body.tool_choice === 'string' ? body.tool_choice : JSON.stringify(body.tool_choice)) : null,
        lastMessage: lastStr.substring(0, 300),
        messages: messages.map((m: any) => ({
          role: m.role,
          content: formatContent(m.content).substring(0, 2000),
        })),
      };
    });

    handleImageModelFallback(body, openaiMessages);
    const { maxContext, maxOutput } = getModelSpecs(body);

    const formattedMessages = openaiMessages.map((m: any) => ({
      role: m.role,
      content: Array.isArray(m.content) ? m.content.map((c: any) => c.text || JSON.stringify(c)).join('\n') : String(m.content ?? ''),
    }));
    const estimatedTokens = estimateTokens(formattedMessages.map((m: any) => m.content).join('\n'));
    const contextCheck = checkContextWindow(estimatedTokens, maxContext, maxOutput, body.model, formattedMessages);
    const promptTokenEstimate = Math.ceil(formattedMessages.reduce((sum: number, m: any) => sum + m.content.length, 0) / 3.5);

    if (!contextCheck.ok) {
      logStore.finalizeRequest(logId);
      cancelWatchdog();
      return c.json(
        {
          error: { message: contextCheck.message, type: 'invalid_request_error', param: 'messages', code: 'context_window_exceeded' },
        },
        400,
      );
    }

    const { session, nextParentId, sessionHeaders, resolvedEmail, stream, qwenAbortController } = await setupAnthropicSession(
      openaiMessages,
      body,
      contextCheck.availableTokens!,
      toolCalling,
      logId,
    );

    if (!isStream) {
      // Non-streaming: reuse handleNonStreamingRequest then convert response
      const nonStreamingCtx: NonStreamingContext = {
        c,
        logId,
        completionId: 'chatcmpl-' + crypto.randomUUID(),
        body,
        session,
        stream,
        resolvedEmail,
        initialParentId: nextParentId,
        sessionHeaders,
        toolCalling,
        cleanOutput,
      };
      logStore.log('debug', 'chat', `[Anthropic] Processing non-streaming via handleNonStreamingRequest`);
      const openAIResponse = await handleNonStreamingRequest(nonStreamingCtx);
      const openAIResp = await openAIResponse.json();
      logStore.log(
        'debug',
        'chat',
        `[Anthropic] Non-streaming response status=${openAIResponse.status} hasError=${!!openAIResp.error} choices=${openAIResp.choices?.length || 0} contentLen=${openAIResp.choices?.[0]?.message?.content?.length || 0} toolCalls=${openAIResp.choices?.[0]?.message?.tool_calls?.length || 0}`,
      );
      if (openAIResp.error) {
        logStore.log('error', 'chat', `[Anthropic] OpenAI endpoint returned error: ${JSON.stringify(openAIResp.error)}`);
        return c.json(
          {
            error: {
              message: openAIResp.error.message,
              type: openAIResp.error.type || 'server_error',
              code: openAIResp.error.code || undefined,
            },
          },
          <any>openAIResponse.status,
        );
      }
      const anthropicResp = convertOpenAIResponseToAnthropic(openAIResp, anthropicModel);
      logStore.log(
        'debug',
        'chat',
        `[Anthropic] Response sent: id=${anthropicResp.id} contentBlocks=${anthropicResp.content?.length} stop=${anthropicResp.stop_reason} latency=${Date.now() - _requestStartTime}ms`,
      );
      cancelWatchdog();
      if (anthropicVersion) c.header('anthropic-version', anthropicVersion);
      return c.json(anthropicResp);
    }

    logStore.log('debug', 'chat', `[Anthropic] Processing streaming response`);
    const result = await handleAnthropicStream(
      c,
      anthropicModel,
      logId,
      session,
      stream,
      qwenAbortController,
      resolvedEmail,
      nextParentId,
      sessionHeaders,
      promptTokenEstimate,
    );
    logStore.log('debug', 'chat', `[Anthropic] Streaming completed latency=${Date.now() - _requestStartTime}ms`);
    cancelWatchdog();
    if (anthropicVersion) c.header('anthropic-version', anthropicVersion);
    return result;
  } catch (err: any) {
    console.error(`[Anthropic] <<< Request failed after ${Date.now() - _requestStartTime}ms: ${err?.message || err}`);
    logStore.addError(logId, err.message || String(err));
    logStore.finalizeRequest(logId);

    if (err.upstreamStatus === 429 || /RateLimited|daily usage limit/i.test(err.message || '')) {
      logStore.log('error', 'chat', `[Anthropic] Returning 429 rate_limit_error`);
      return c.json(
        {
          error: {
            message: 'All accounts have reached their daily usage limit. Please try again later.',
            type: 'rate_limit_error',
            code: 'rate_limit_exceeded',
          },
        },
        429,
      );
    }
    const status = err.upstreamStatus || 500;
    const cleanMessage = cleanTextOfXmlArtifacts(err.message || String(err)).cleanedText || err.message || 'Internal error';
    logStore.log('error', 'chat', `[Anthropic] Returning ${status}: ${cleanMessage}`);
    cancelWatchdog();
    if (anthropicVersion) c.header('anthropic-version', anthropicVersion);
    return c.json({ error: { message: cleanMessage, type: err.type || 'server_error', code: err.code || undefined } }, <any>status);
  }
}
