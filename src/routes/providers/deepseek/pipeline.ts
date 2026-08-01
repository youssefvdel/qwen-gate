/*
 * File: providers/deepseek/pipeline.ts
 * DeepSeek web chat API pipeline — browserless, using wreqFetch for TLS.
 *
 * Full flow:
 *   1. Get hif-leim (global cache, 10 min TTL)
 *   2. Solve PoW via direct WASM (fresh per request — PoW solutions are single-use)
 *   3. Create chat session (per-token cache, 30 min TTL)
 *   4. Send chat completion with all bypass headers
 *   5. Parse SSE → OpenAI format + content filtering
 *
 * ALL 4 requests include the full browser impersonation headers.
 * TLS impersonation via wreqFetch (Rust + BoringSSL, chrome_142).
 */

import type { Context } from 'hono';
import { getProviderState } from '../../../services/accountManager.ts';
import { config } from '../../../services/configService.ts';
import { logStore } from '../../../services/logStore.ts';
import { cleanTextOfXmlArtifacts } from '../../../tools/xmlToolParser.ts';
import type { OpenAIRequest } from '../../../types/openai.ts';
import { compressToolResult } from '../../compressToolResult.ts';
import { getHifLeim } from './leim.ts';
import { getPowResponseHeader } from './pow.ts';
import { getOrCreateChatSession } from './session.ts';
import { buildDeepSeekHeaders, createDeepSeekContext, DEEPSEEK_BASE_URL } from './spoofing.ts';
import { createStreamState, type DeepSeekStreamState, parseDeepSeekData } from './stream.ts';
import { buildToolSystemPrompt, hasWebSearchTool, makeToolCallEntry, parseToolCalls } from './toolEmulation.ts';

const CHAT_ENDPOINT = '/api/v0/chat/completion';
const DEEPSEEK_FETCH_TIMEOUT = 60_000;

/**
 * Convert OpenAI messages to a single prompt string (DeepSeek web chat uses
 * prompt, not messages). Serializes FULL multi-turn tool history so agentic
 * loops keep context: assistant tool_calls from previous turns are echoed back
 * as "[Tool calls made: ...]", and role:tool results are rendered as
 * <tool_result> blocks resolved by tool_call_id (Hermes parallel tool loops).
 */
function messagesToPrompt(
  messages: Array<{
    role: string;
    content: string | null | Array<any>;
    tool_calls?: any[];
    tool_call_id?: string;
    name?: string;
    reasoning_content?: string;
  }>,
): string {
  return messages
    .map(function (m, i) {
      // Handle content arrays (OpenAI format: [{type:"text", text:"..."}])
      let contentStr = '';
      if (Array.isArray(m.content)) {
        contentStr = m.content.map((c: any) => c.text || JSON.stringify(c)).join('\n');
      } else if (typeof m.content === 'object' && m.content !== null) {
        contentStr = JSON.stringify(m.content);
      } else {
        contentStr = m.content ?? '';
      }
      if (m.role === 'system') return '<system>' + contentStr + '</system>';

      if (m.role === 'assistant') {
        let text = contentStr;
        // Prior tool_calls (the client echoes our synthesized calls back on
        // the next turn — content is null but tool_calls carries the calls).
        if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
          const calls = m.tool_calls
            .map((tc: any) => {
              const name = tc.function?.name || 'unknown';
              let args = tc.function?.arguments;
              if (typeof args === 'string') {
                try {
                  args = JSON.parse(args);
                } catch {
                  /* keep raw */
                }
              }
              const argsStr = typeof args === 'object' && args !== null ? JSON.stringify(args) : String(args ?? '');
              // Cap echoed arguments so large Hermes tool calls don't blow up
              // the prompt on every multi-turn round.
              const capped = argsStr.length > 300 ? argsStr.slice(0, 300) + '...' : argsStr;
              return `${name}(${capped})`;
            })
            .join(', ');
          // The client echoes our synthesized calls back together with the
          // role:tool results that follow — tell the model the results are
          // already in the <tool_result> blocks so it USES them instead of
          // re-issuing the same calls on the next turn (observed with huge
          // agent system prompts: the model re-calls read_file/list_dir
          // instead of summarizing what it found). Only add the note when
          // results actually follow, so a truncated history (assistant
          // tool_calls without results) stays truthful.
          const resultsFollow = messages.slice(i + 1).some((mm) => mm.role === 'tool' || mm.role === 'function');
          const note = resultsFollow
            ? '[Tool calls made: ' +
              calls +
              ' — results already received in the <tool_result> blocks below; do NOT call these functions again, use the results]'
            : '[Tool calls made: ' + calls + ']';
          text = text ? text + '\n' + note : note;
        }
        if (m.reasoning_content) text = '<thinking>\n' + m.reasoning_content + '\n</thinking>\n' + text;
        return '<Assistant>' + text + '</Assistant>';
      }

      if (m.role === 'tool' || m.role === 'function') {
        // Resolve the tool name from the preceding assistant tool_calls by id.
        let toolName = m.name;
        if (!toolName && m.tool_call_id) {
          for (let j = i - 1; j >= 0; j--) {
            const prev = messages[j];
            if (prev?.role === 'assistant' && Array.isArray(prev.tool_calls)) {
              const call = prev.tool_calls.find((tc: any) => tc.id === m.tool_call_id);
              if (call) {
                toolName = call.function?.name;
                break;
              }
            }
          }
        }
        const result = compressToolResult(contentStr || '');
        // Escape the semi-trusted tool output so it can't break out of the
        // <tool_result> block (file contents / terminal output may contain
        // XML-like text — treat it as data, not prompt).
        const escaped = result.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return (
          '<tool_result tool="' +
          (toolName || 'unknown').replace(/["<>&]/g, '') +
          '" tool_call_id="' +
          (m.tool_call_id || '') +
          '">\n' +
          escaped +
          '\n</tool_result>'
        );
      }

      return '<user>' + contentStr + '</user>';
    })
    .join('\n');
}

/**
 * Map a gateway model name to a DeepSeek web model_type.
 *
 * chat.deepseek.com currently exposes exactly three model_types
 * (verified against the live model_configs feature store, 2026-08):
 *   default ("Instant"), expert ("Expert"), vision ("Vision").
 * Legacy gateway aliases (deepseek-chat / deepseek-reasoner / deepseek-vl2)
 * and common client names are mapped onto these.
 */
function modelToModelType(model: string, sessionModelType?: string): string {
  const m = model.replace(/^deepseek\//, '').toLowerCase();
  if (
    m === 'deepseek-reasoner' ||
    m === 'deepseek-expert' ||
    m === 'deepseek-r1' ||
    m === 'r1' ||
    m === 'deepseek-v4-pro' ||
    m === 'expert' ||
    m === 'reasoner'
  ) {
    return 'expert';
  }
  if (m === 'deepseek-vl2' || m === 'deepseek-vision' || m === 'deepseek-vl' || m === 'vision') {
    return 'vision';
  }
  if (
    m === 'deepseek-chat' ||
    m === 'deepseek-instant' ||
    m === 'deepseek-v3' ||
    m === 'deepseek-v3.2' ||
    m === 'deepseek-v3-2' ||
    m === 'deepseek-v4' ||
    m === 'deepseek-v4-flash' ||
    m === 'default' ||
    m === 'instant' ||
    m === 'chat'
  ) {
    return 'default';
  }
  return sessionModelType || 'default';
}

/**
 * Detect a DeepSeek error delivered as an HTTP-200 JSON body.
 * DeepSeek returns `{"code":40301,"msg":"INVALID_POW_RESPONSE",...}` with
 * status 200 — the old code only checked HTTP status / X-Upstream-Status,
 * so these errors were silently swallowed and surfaced as empty responses.
 * Returns a normalized Error (with upstreamStatus) or null if the body is
 * valid SSE / not an error.
 */
function detectDeepSeekError(text: string): Error | null {
  const t = text.trim();
  if (!t || t.startsWith('data:') || t.startsWith('event:') || t.startsWith('[') || !t.startsWith('{')) {
    return null;
  }
  try {
    const j = JSON.parse(t);
    if (j && typeof j.code === 'number' && j.code !== 0) {
      let status: number;
      if (j.code === 40301)
        status = 408; // INVALID_POW_RESPONSE — transient, retry with a fresh PoW
      else if (j.code === 40002 || j.code === 40003)
        status = 401; // Missing Token / INVALID_TOKEN
      else if (j.code === 40004)
        status = 429; // quota/rate limiting
      else status = 400;
      const err = new Error('DeepSeek web chat API error (' + j.code + '): ' + (j.msg || JSON.stringify(j).slice(0, 300)));
      (err as any).upstreamStatus = status;
      (err as any).code = String(j.code);
      return err;
    }
  } catch {
    /* not JSON — treat as stream body */
  }
  return null;
}

/**
 * Estimate prompt tokens from an OpenAI request body (messages + tools +
 * system prompt). The DeepSeek web API only reports completion tokens
 * (accumulated_token_usage), never prompt tokens — so we approximate with a
 * chars-per-token heuristic (≈4 chars/token for ASCII, ≈1.5 for CJK/other).
 * Good enough for client context gauges (Hermes status bar).
 */
function estimatePromptTokens(body: OpenAIRequest): number {
  let ascii = 0;
  let other = 0;
  const scan = (s: unknown): void => {
    if (typeof s !== 'string') return;
    for (let i = 0; i < s.length; i++) {
      if (s.charCodeAt(i) < 128) ascii++;
      else other++;
    }
  };
  for (const m of body.messages ?? []) {
    if (typeof m.content === 'string') scan(m.content);
    else if (Array.isArray((m as any).content)) {
      for (const part of (m as any).content) {
        scan(part?.text);
        if (part?.type === 'image_url') other += 85; // rough image placeholder cost
      }
    }
  }
  for (const t of body.tools ?? []) scan(JSON.stringify(t));
  scan((body as any).system_prompt);
  return Math.ceil(ascii / 4) + Math.ceil(other / 1.5);
}

/**
 * Proxy a request through DeepSeek's web chat API via wreqFetch.
 * Browserless: PoW via direct WASM, leim via fetch, session via API.
 */
export async function proxyViaDeepSeekWebChat(
  c: Context,
  body: OpenAIRequest,
  email: string,
  bearerToken: string,
  model: string,
  isStream: boolean,
  logId: string,
): Promise<Response> {
  logStore.log('debug', 'deepseek-pipeline', `email=${email} model=${model} stream=${isStream}`);
  const reqStartTs = Date.now();

  // Tool-call emulation: chat.deepseek.com has no native function calling, so
  // when the client declares tools we inject the schemas into the prompt and
  // run the parser in accumulate-only mode (suppressOutput) — the synthesized
  // tool_calls response is built from the model's JSON text at the end.
  // Explicit `tool_choice: "none"` disables tool calling entirely — the client
  // wants a plain-text answer, so skip emulation and inject nothing.
  const toolCallMode = !!body.tools?.length && body.tool_choice !== 'none';
  // DeepSeek web models have native web search — enable it when the client
  // declares a search tool so the model can actually search the web.
  const searchTool = hasWebSearchTool(body.tools || []);

  // ── Step 1: Get hif-leim (global cache, 10 min) ──
  const leim = await getHifLeim();
  logStore.log('debug', 'deepseek-pipeline', `Leim: ${leim.slice(0, 20)}...`);

  // ── Step 2: Solve PoW challenge via direct WASM (per-email cache) ──
  const powHeader = await getPowResponseHeader(email, bearerToken, CHAT_ENDPOINT);
  logStore.log('debug', 'deepseek-pipeline', `PoW solved: ${powHeader.length} chars`);

  // ── Step 3: Get or create chat session (per-token cache, 30 min) ──
  const session = await getOrCreateChatSession(bearerToken, email, powHeader);
  if (!session) {
    logStore.log('warn', 'deepseek-session', 'Failed to create chat session');
    throw Object.assign(new Error('Failed to create DeepSeek chat session — token may be expired'), { upstreamStatus: 401 });
  }
  logStore.log('debug', 'deepseek-pipeline', `Session: ${session.id}`);

  // ── Step 4: Build the DeepSeek web chat request body ──
  // Tool-call emulation: APPEND the tool schemas + strict JSON output contract
  // at the END of the prompt (after the conversation). DeepSeek web models
  // carry a huge system prompt from agents like Hermes (20K+ tokens); a
  // contract prepended at position 0 gets buried and ignored — the model then
  // answers in plain text. Appending last maximizes recency: the model
  // generates immediately after reading the contract, so it follows the JSON
  // array format far more reliably.
  const prompt =
    messagesToPrompt(body.messages || []) + (toolCallMode ? buildToolSystemPrompt(body.tools || [], body.tool_choice as any) : '');
  const modelType = modelToModelType(model, session.model_type);
  const promptTokens = estimatePromptTokens(body);

  // Visibility: log exactly what we're sending upstream so dashboard log
  // detail view shows the real prompt (with injected tool contract).
  logStore.updateEntry(logId, (entry) => {
    entry.promptToDeepSeek = {
      totalLength: prompt.length,
      // The injected tool contract sits at the END of the prompt (recency),
      // so preview the TAIL — the head is the client's system prompt (up to
      // 23K tokens for agents like Hermes) and tells us nothing about the
      // contract placement that actually matters.
      preview: prompt.length > 2000 ? '...' + prompt.slice(-2000) : prompt,
    };
  });

  // Reasoning (thinking) is ON by default — tool calling works better when the
  // model reasons before emitting tool calls. Override with DEEPSEEK_THINKING=false.
  const thinkingEnabled = config.getBool('DEEPSEEK_THINKING', true);

  const deepseekBody: Record<string, any> = {
    chat_session_id: session.id,
    parent_message_id: null,
    model_type: modelType,
    prompt,
    ref_file_ids: [],
    thinking_enabled: thinkingEnabled,
    search_enabled: searchTool,
    action: null,
    preempt: false,
  };

  // ── Step 5: Build full browser headers with ALL bypass fields ──
  const ctx = createDeepSeekContext(bearerToken);
  const providerState = getProviderState(email, 'deepseek');
  const wafToken = providerState?.wafToken || undefined;
  const headers = buildDeepSeekHeaders(ctx, {
    powResponse: powHeader,
    hifLeim: leim,
    dsSessionId: session.id,
    wafToken,
  });

  logStore.log(
    'debug',
    'deepseek-pipeline',
    `Fetching ${DEEPSEEK_BASE_URL}${CHAT_ENDPOINT} via wreqFetch (pow=yes, leim=yes, waf=${wafToken ? 'yes' : 'no'})`,
  );

  // ── Step 6: Send chat completion via wreqFetch ──
  const { wreqFetch } = await import('../../../services/wreqFetch.ts');
  const resp = await wreqFetch(DEEPSEEK_BASE_URL + CHAT_ENDPOINT, {
    method: 'POST',
    headers: headers as unknown as Record<string, string>,
    body: JSON.stringify(deepseekBody),
    stream: isStream,
    timeout: Math.ceil(DEEPSEEK_FETCH_TIMEOUT / 1000),
    impersonate: 'chrome_142',
  });

  const upstreamStatus = parseInt(resp.headers.get('X-Upstream-Status') || '0', 10);
  logStore.log(
    'debug',
    'deepseek-pipeline',
    `Response: status=${upstreamStatus || resp.status} content-type=${resp.headers.get('content-type')}`,
  );

  if (!resp.ok || upstreamStatus >= 400) {
    const errText = await resp.text().catch(() => 'unknown error');
    const effectiveStatus = upstreamStatus || resp.status;
    const err = new Error('DeepSeek web chat API error (' + effectiveStatus + '): ' + errText.slice(0, 500));
    (err as any).upstreamStatus = effectiveStatus;
    throw err;
  }

  // DeepSeek sometimes returns errors with HTTP 200 and a JSON body
  // (e.g. {"code":40301,"msg":"INVALID_POW_RESPONSE"}). Detect and surface them
  // so the handler can retry instead of silently returning an empty response.
  if (!isStream) {
    const text = await resp.text();
    const errObj = detectDeepSeekError(text);
    if (errObj) {
      logStore.log('warn', 'deepseek-pipeline', 'Upstream JSON error on HTTP 200: ' + errObj.message);
      throw errObj;
    }
    logStore.log('debug', 'deepseek-raw', `len=${text.length} head=${text.slice(0, 1000)}`);
    const state: DeepSeekStreamState = createStreamState();
    if (toolCallMode) state.suppressOutput = true;
    const lines = text.split('\n').filter((l) => l.startsWith('data: '));
    for (const line of lines) {
      const data = line.slice(6);
      if (data === '[DONE]') continue;
      parseDeepSeekData(data, state, body.model, session.id);
    }

    const rawContent = state.content || ' ';
    const cleanedText = cleanTextOfXmlArtifacts(rawContent).cleanedText || ' ';
    // Parse from raw state.content (not the XML-cleaned text): parseToolCalls
    // already strips fences and extracts balanced JSON itself, and the cleaner
    // could otherwise mangle the model's JSON output. Matches the stream path.
    const toolCalls = toolCallMode ? parseToolCalls(state.content) : [];

    logStore.addProcessedOutput(logId, cleanedText);
    if (state.thinkingContent) logStore.addProcessedOutput(logId, '[THINKING] ' + state.thinkingContent);

    // Enrich the request log entry with real tokens/latency/content so the
    // dashboard log view and monitor store show deepseek data.
    const completionTokens = state.usage?.completion_tokens ?? Math.ceil(cleanedText.length / 4);
    logStore.updateEntry(logId, (entry) => {
      entry.latency_ms = Date.now() - reqStartTs;
      entry.tokens = { prompt: promptTokens, completion: completionTokens, total: promptTokens + completionTokens };
      entry.finalResponse = {
        finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
        toolCallCount: toolCalls.length,
        contentPreview: toolCalls.length > 0 ? `tool_calls(${toolCalls.map((tc) => tc.name).join(',')})` : cleanedText.slice(0, 300),
      };
      entry.rawFullContent = cleanedText;
      if (state.thinkingContent) entry.reasoningContent = state.thinkingContent;
      // Populate the shared parsedToolCalls field so the log/dashboard show
      // real tool calls (logStore derives tool_call_count/tool_calls from it).
      for (const tc of toolCalls) {
        entry.parsedToolCalls.push({ name: tc.name, args: tc.argsJson });
      }
    });

    return c.json(
      {
        id: session.id,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [
          {
            index: 0,
            message:
              toolCalls.length > 0
                ? {
                    role: 'assistant',
                    content: null,
                    tool_calls: toolCalls.map((tc) => makeToolCallEntry(tc, 'call_' + crypto.randomUUID(), true)),
                    // Reasoning is on by default (DEEPSEEK_THINKING) — surface the
                    // model's thinking alongside tool calls so agent clients
                    // (Hermes) can display/use it instead of dropping it.
                    ...(state.thinkingContent ? { reasoning_content: state.thinkingContent } : {}),
                  }
                : {
                    role: 'assistant',
                    content: cleanedText,
                    ...(state.thinkingContent ? { reasoning_content: state.thinkingContent } : {}),
                  },
            finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
          },
        ],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: state.usage?.completion_tokens ?? Math.ceil(cleanedText.length / 4),
          total_tokens: promptTokens + (state.usage?.completion_tokens ?? Math.ceil(cleanedText.length / 4)),
        },
      },
      { headers: { 'content-type': 'application/json' } },
    );
  }

  // ── Streaming: convert DeepSeek SSE → OpenAI SSE ──
  if (!resp.body) {
    throw Object.assign(new Error('DeepSeek returned empty response body'), { upstreamStatus: 502 });
  }

  // Peek the first chunk: if DeepSeek answered with an HTTP-200 JSON error
  // body, surface it now (as an upstream error) instead of streaming an
  // empty [DONE]-only response. Otherwise re-wrap the stream intact.
  const reader = resp.body.getReader();
  const firstRead = await reader.read();
  if (firstRead.done) {
    throw Object.assign(new Error('DeepSeek returned empty response body'), { upstreamStatus: 502 });
  }
  const firstText = new TextDecoder().decode(firstRead.value);
  const errObj = detectDeepSeekError(firstText);
  if (errObj) {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
    logStore.log('warn', 'deepseek-pipeline', 'Upstream JSON error on HTTP 200 (stream): ' + errObj.message);
    throw errObj;
  }
  const bodyStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(firstRead.value);
    },
    pull(controller) {
      return reader.read().then((r) => {
        if (r.done) {
          controller.close();
          return;
        }
        controller.enqueue(r.value);
      });
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  });

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const streamReader = bodyStream.getReader();
  const encoder = new TextEncoder();

  (async () => {
    let buffer = '';
    const state: DeepSeekStreamState = createStreamState();
    if (toolCallMode) state.suppressOutput = true;
    const decoder = new TextDecoder();
    const streamStartTs = Date.now();
    let finishSent = false;
    let upstreamFinished = false;
    // Tool-call emulation results — parsed once at stream end, shared by
    // emitFinish (the synthesized tool_calls deltas) and the log finalize.
    let toolCalls: Array<{ name: string; argsJson: string }> = [];

    // Emit a synthetic OpenAI finish chunk when the upstream ended without
    // delivering one (e.g. it sent response/status FINISHED but no
    // close/click_behavior event). OpenAI-compatible clients treat a stream
    // that ends without finish_reason as truncated and may loop on retries.
    const emitFinish = async (): Promise<void> => {
      if (finishSent) return;
      finishSent = true;
      const completionTokens = state.usage?.completion_tokens ?? Math.ceil((state.content.length + state.thinkingContent.length) / 4);
      let delta: Record<string, any> = {};
      let finishReason: string = 'stop';
      if (toolCallMode) {
        // In tool mode all content chunks are suppressed, so the deltas below
        // are the only ones the client sees — announce the assistant role on
        // the first chunk (OpenAI streaming convention).
        if (toolCalls.length > 0) {
          // Parallel tool calls: one indexed delta per call (OpenAI streaming
          // spec: index 0, 1, 2...), then a final chunk carrying finish_reason.
          for (let i = 0; i < toolCalls.length; i++) {
            await writer.write(
              encoder.encode(
                'data: ' +
                  JSON.stringify({
                    id: session.id,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: body.model,
                    choices: [
                      {
                        index: 0,
                        delta: {
                          ...(i === 0 ? { role: 'assistant' } : {}),
                          tool_calls: [makeToolCallEntry(toolCalls[i], 'call_' + crypto.randomUUID(), false, i)],
                        },
                        finish_reason: null,
                      },
                    ],
                  }) +
                  '\n\n',
              ),
            );
          }
          finishReason = 'tool_calls';
          delta = {};
        } else if (state.content) {
          // Tool mode but the model answered in plain text — flush it.
          delta.role = 'assistant';
          delta.content = state.content;
        } else {
          delta.role = 'assistant';
        }
      }
      await writer.write(
        encoder.encode(
          'data: ' +
            JSON.stringify({
              id: session.id,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: body.model,
              choices: [{ index: 0, delta, finish_reason: finishReason }],
              usage: {
                prompt_tokens: promptTokens,
                completion_tokens: completionTokens,
                total_tokens: promptTokens + completionTokens,
              },
            }) +
            '\n\n',
        ),
      );
    };

    try {
      while (true) {
        const result = await streamReader.read();
        if (result.done) break;

        const chunkStr = decoder.decode(result.value, { stream: true });
        logStore.addRawChunk(logId, chunkStr);
        buffer += chunkStr;
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          if (trimmed.startsWith('event: ')) {
            state._pendingEvent = trimmed.slice(7).trim();
            continue;
          }

          if (trimmed.startsWith('data: ')) {
            const dataContent = trimmed.slice(6).trim();
            if (dataContent === '[DONE]') {
              // Upstream sent its own [DONE] — defer to the unified exit path
              // so finish_reason always precedes our [DONE] exactly once.
              upstreamFinished = true;
              continue;
            }

            const parseResult = parseDeepSeekData(dataContent, state, body.model, session.id, promptTokens);
            for (const chunk of parseResult.chunks) {
              await writer.write(encoder.encode(chunk));
              logStore.addRawChunk(logId, chunk);
              // In tool mode (suppressOutput) the only finish_reason comes from
              // the synthesized emitFinish — ignore any upstream finish marker
              // so a stray thinking fragment can't suppress the tool_calls delta.
              if (!state.suppressOutput && chunk.includes('"finish_reason":"stop"')) finishSent = true;
            }

            // Do NOT return here: the FINISHED status patch sets done without
            // emitting a finish chunk, and the close/click_behavior lines that
            // carry it may follow in the same chunk. Keep draining the buffer.
            if (parseResult.done) upstreamFinished = true;
          }
        }

        if (upstreamFinished) break;
      }

      // Upstream stream ended. Flush any trailing complete line still buffered
      // (e.g. the final click_behavior line arriving without a trailing \n).
      if (buffer.trim()) {
        const dataMatch = buffer.match(/^data: (.+)$/m);
        if (dataMatch) {
          const pr = parseDeepSeekData(dataMatch[1], state, body.model, session.id, promptTokens);
          for (const chunk of pr.chunks) {
            await writer.write(encoder.encode(chunk));
            logStore.addRawChunk(logId, chunk);
            if (!state.suppressOutput && chunk.includes('"finish_reason":"stop"')) finishSent = true;
          }
        }
      }

      toolCalls = toolCallMode ? parseToolCalls(state.content) : [];
      await emitFinish();
      await writer.write(encoder.encode('data: [DONE]\n\n'));

      // Stream complete — this is the single finalize point for streaming
      // requests (the handler defers finalize for streams). Record tokens,
      // latency and content so the dashboard log/monitor show deepseek data.
      logStore.updateEntry(logId, (entry) => {
        entry.rawFullContent = state.content;
        if (state.thinkingContent) entry.reasoningContent = state.thinkingContent;
        entry.finalResponse = {
          finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
          toolCallCount: toolCalls.length,
          contentPreview: toolCalls.length > 0 ? `tool_calls(${toolCalls.map((tc) => tc.name).join(',')})` : state.content.slice(0, 300),
        };
        // Populate the shared parsedToolCalls field so the log/dashboard show
        // real tool calls (logStore derives tool_call_count/tool_calls from it).
        for (const tc of toolCalls) {
          entry.parsedToolCalls.push({ name: tc.name, args: tc.argsJson });
        }
      });
      const finalCompletion = state.usage?.completion_tokens ?? Math.ceil((state.content.length + state.thinkingContent.length) / 4);
      logStore.finalizeRequest(logId, {
        latencyMs: Date.now() - streamStartTs,
        tokens: { prompt: promptTokens, completion: finalCompletion, total: promptTokens + finalCompletion },
        // Mirror the response's actual finish reason (tool_calls vs stop) so
        // the log file / dashboard don't clobber it to 'stop'.
        finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
      });
      await writer.close();
    } catch (err: any) {
      // Rejection values are not always Error instances (client disconnects can
      // reject with undefined) — never let this handler itself throw, or the
      // unhandled rejection kills the whole process.
      const errMsg = err instanceof Error ? err.message : err === undefined ? 'stream aborted (client disconnected)' : String(err);
      logStore.log('error', 'deepseek-stream', 'Stream error: ' + errMsg);
      logStore.addError(logId, errMsg);
      const errCompletion = state.usage?.completion_tokens ?? 0;
      logStore.finalizeRequest(logId, {
        latencyMs: Date.now() - streamStartTs,
        tokens: { prompt: promptTokens, completion: errCompletion, total: promptTokens + errCompletion },
        finishReason: 'error',
      });
      try {
        await writer.write(encoder.encode('data: [DONE]\n\n'));
        await writer.close();
      } catch {
        /* writer may already be closed */
      }
    }
  })();

  return new Response(readable, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
