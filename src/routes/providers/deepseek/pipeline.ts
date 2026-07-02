/*
 * File: providers/deepseek/pipeline.ts
 * DeepSeek web chat API pipeline — browserless, using wreqFetch for TLS.
 *
 * Full flow:
 *   1. Get hif-leim (global cache, 10 min TTL)
 *   2. Solve PoW via direct WASM (per-email cache, up to 2 min TTL)
 *   3. Create chat session (per-token cache, 30 min TTL)
 *   4. Send chat completion with all bypass headers
 *   5. Parse SSE → OpenAI format + content filtering
 *
 * ALL 4 requests include the full browser impersonation headers.
 * TLS impersonation via wreqFetch (Rust + BoringSSL, chrome_142).
 */

import type { Context } from 'hono';
import { getProviderState } from '../../../services/accountManager.ts';
import { logStore } from '../../../services/logStore.ts';
import { cleanTextOfXmlArtifacts } from '../../../tools/xmlToolParser.ts';
import type { OpenAIRequest } from '../../../types/openai.ts';
import { getHifLeim } from './leim.ts';
import { getPowResponseHeader } from './pow.ts';
import { getOrCreateChatSession } from './session.ts';
import { buildDeepSeekHeaders, createDeepSeekContext, DEEPSEEK_BASE_URL } from './spoofing.ts';
import { createStreamState, type DeepSeekStreamState, parseDeepSeekData } from './stream.ts';

const CHAT_ENDPOINT = '/api/v0/chat/completion';
const DEEPSEEK_FETCH_TIMEOUT = 60_000;

/**
 * Convert OpenAI messages to a single prompt string (DeepSeek web chat uses prompt, not messages).
 */
function messagesToPrompt(messages: Array<{ role: string; content: string | null | Array<any> }>): string {
  return messages
    .map(function (m) {
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
      if (m.role === 'assistant') return '<Assistant>' + contentStr + '</Assistant>';
      return '<user>' + contentStr + '</user>';
    })
    .join('\n');
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
  const prompt = messagesToPrompt(body.messages || []);
  const isPro = model === 'deepseek-v4-pro' || model === 'deepseek-reasoner';
  const modelType = isPro ? 'expert' : session.model_type || 'default';

  const deepseekBody: Record<string, any> = {
    chat_session_id: session.id,
    parent_message_id: null,
    model_type: modelType,
    prompt,
    ref_file_ids: [],
    thinking_enabled: true,
    search_enabled: false,
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

  // ── Non-streaming: buffer SSE, extract content, filter ──
  if (!isStream) {
    const text = await resp.text();
    logStore.log('debug', 'deepseek-raw', `len=${text.length} head=${text.slice(0, 1000)}`);
    const state: DeepSeekStreamState = createStreamState();
    const lines = text.split('\n').filter((l) => l.startsWith('data: '));
    for (const line of lines) {
      const data = line.slice(6);
      if (data === '[DONE]') continue;
      parseDeepSeekData(data, state, body.model, session.id);
    }

    const rawContent = state.content || ' ';
    const cleanedText = cleanTextOfXmlArtifacts(rawContent).cleanedText || ' ';

    logStore.addProcessedOutput(logId, cleanedText);
    if (state.thinkingContent) logStore.addProcessedOutput(logId, '[THINKING] ' + state.thinkingContent);

    return c.json(
      {
        id: session.id,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: cleanedText,
              ...(state.thinkingContent ? { reasoning_content: state.thinkingContent } : {}),
            },
            finish_reason: 'stop',
          },
        ],
        usage: state.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      },
      { headers: { 'content-type': 'application/json' } },
    );
  }

  // ── Streaming: convert DeepSeek SSE → OpenAI SSE ──
  if (!resp.body) {
    throw Object.assign(new Error('DeepSeek returned empty response body'), { upstreamStatus: 502 });
  }

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const reader = resp.body.getReader();
  const encoder = new TextEncoder();

  (async () => {
    let buffer = '';
    const state: DeepSeekStreamState = createStreamState();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const result = await reader.read();
        if (result.done) {
          if (buffer.trim()) {
            const dataMatch = buffer.match(/^data: (.+)$/m);
            if (dataMatch) {
              const pr = parseDeepSeekData(dataMatch[1], state, body.model, session.id);
              for (const chunk of pr.chunks) await writer.write(encoder.encode(chunk));
            }
          }
          await writer.write(encoder.encode('data: [DONE]\n\n'));
          await writer.close();
          break;
        }

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
              await writer.write(encoder.encode('data: [DONE]\n\n'));
              continue;
            }

            const parseResult = parseDeepSeekData(dataContent, state, body.model, session.id);
            for (const chunk of parseResult.chunks) {
              await writer.write(encoder.encode(chunk));
            }

            if (parseResult.done) {
              await writer.write(encoder.encode('data: [DONE]\n\n'));
              await writer.close();
              return;
            }
          }
        }
      }
    } catch (err: any) {
      logStore.log('error', 'deepseek-stream', 'Stream error: ' + err.message);
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
