/*
 * File: providers/glm/pipeline.ts
 * GLM proxy pipeline — uses wreqFetch (Rust + BoringSSL) for TLS/HTTP2
 * fingerprint impersonation to bypass GLM anti-bot detection.
 *
 * Full flow: validate user → get session → build spoofed request → send via wreqFetch → parse SSE → content filter.
 */

import type { Context } from 'hono';
import { getProviderState } from '../../../services/accountManager.ts';
import { logStore } from '../../../services/logStore.ts';
import { cleanTextOfXmlArtifacts } from '../../../tools/xmlToolParser.ts';
import type { OpenAIRequest } from '../../../types/openai.ts';
import { filterContent } from '../../../utils/contentFilter.ts';
import { getCaptchaVerifyParam, invalidateCaptchaToken } from './captcha-solver.ts';
import { getCurrentUser, getOrCreateChatSession } from './session.ts';
import { buildFingerprintParams, buildGlmHeaders, buildGlmVariables, computeSignature, GLM_BASE_URL } from './spoofing.ts';
import { createGlmStreamState, type GlmStreamState, parseGlmSseLine } from './stream.ts';

const GLM_FETCH_TIMEOUT = 60_000;

/**
 * Convert OpenAI messages to GLM history format.
 */
function messagesToGlmFormat(messages: Array<{ role: string; content: string | null | Array<any> }>): {
  messages: Record<string, any>;
  currentId: string | null;
} {
  const result: Record<string, any> = {};
  let prevId: string | null = null;
  let currentId: string | null = null;

  for (const msg of messages) {
    // Handle content arrays (OpenAI format: [{type:"text", text:"..."}])
    let contentStr = '';
    if (Array.isArray(msg.content)) {
      contentStr = msg.content.map((c: any) => c.text || JSON.stringify(c)).join('\n');
    } else if (typeof msg.content === 'object' && msg.content !== null) {
      contentStr = JSON.stringify(msg.content);
    } else {
      contentStr = msg.content ?? '';
    }

    const id = crypto.randomUUID();
    currentId = id;
    result[id] = {
      id,
      parentId: prevId,
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content: contentStr,
      timestamp: Date.now(),
      done: true,
    };
    prevId = id;
  }

  return { messages: result, currentId };
}

/**
 * Proxy a request through GLM's chat completions API via wreqFetch.
 */
export async function proxyViaGlmWebChat(
  c: Context,
  body: OpenAIRequest,
  email: string,
  jwt: string,
  model: string,
  isStream: boolean,
  logId: string,
): Promise<Response> {
  const { wreqFetch } = await import('../../../services/wreqFetch.ts');

  // 1. Validate JWT and get user info via wreqFetch
  const user = await getCurrentUser(jwt);
  if (!user) {
    throw Object.assign(new Error('Cannot validate GLM account. Login via dashboard first.'), { upstreamStatus: 401 });
  }

  const providerState = getProviderState(email, 'glm');
  const ctx = {
    jwt,
    userId: user.id,
    userName: user.name,
  };

  // 2. Get or create chat session via wreqFetch
  const session = await getOrCreateChatSession(jwt, model);
  if (!session) {
    throw Object.assign(new Error('Cannot create GLM chat session. Login via dashboard first.'), { upstreamStatus: 503 });
  }

  // 3. Convert messages to GLM format
  // Keep all messages including system prompts — wrap system in <system> tag
  const chatMessages = body.messages || [];
  const history = messagesToGlmFormat(chatMessages);
  const variables = buildGlmVariables(ctx);

  const glmFeatures: Record<string, any> = {
    image_generation: false,
    web_search: false,
    auto_web_search: false,
    preview_mode: true,
    flags: [],
    vlm_tools_enable: false,
    vlm_web_search_enable: false,
    vlm_website_mode: false,
    enable_thinking: !!ctx.jwt,
    reasoning_effort: model.includes('glm-5') ? 'max' : '',
  };

  const glmBody: Record<string, any> = {
    stream: true,
    model,
    messages: chatMessages,
    signature_prompt:
      chatMessages
        .map((m: any) => m.content || '')
        .join('\n')
        .slice(0, 500) || '',
    params: {},
    extra: {},
    features: glmFeatures,
    variables,
    chat_id: session.id,
    id: crypto.randomUUID(),
    current_user_message_id: history.currentId,
    current_user_message_parent_id: null,
    background_tasks: { title_generation: true, tags_generation: true },
    captcha_verify_param: await getCaptchaVerifyParam(),
  };

  // 4. Build fingerprint query string
  const params = buildFingerprintParams(ctx);
  const url = `${GLM_BASE_URL}/api/v2/chat/completions?${params.toString()}`;

  // 5. Build spoofed headers with x-signature
  const bodyStr = JSON.stringify(glmBody);
  const requestId = params.get('requestId') || crypto.randomUUID();
  const signature = computeSignature(requestId, params.get('timestamp') || String(Date.now()), ctx.userId, ctx.jwt);
  const headers = await buildGlmHeaders(ctx, bodyStr, requestId, signature);

  // 6. Send request to GLM via wreqFetch
  logStore.log('debug', 'glm-pipeline', `Fetching ${url.slice(0, 100)} via wreqFetch`);
  const resp = await wreqFetch(url, {
    method: 'POST',
    headers,
    body: bodyStr,
    stream: isStream,
    timeout: Math.ceil(GLM_FETCH_TIMEOUT / 1000),
    impersonate: 'chrome_142',
  });

  const upstreamStatus = parseInt(resp.headers.get('X-Upstream-Status') || '0', 10);
  logStore.log('debug', 'glm-pipeline', `Response: status=${upstreamStatus || resp.status}`);

  if (!resp.ok || upstreamStatus >= 400) {
    const errText = await resp.text().catch(() => 'unknown error');
    const effStatus = upstreamStatus || resp.status;

    // Detect captcha errors in response body
    if (errText.includes('FRONTEND_CAPTCHA') || errText.includes('captcha') || effStatus === 403) {
      invalidateCaptchaToken();
      const err = new Error('GLM requires CAPTCHA verification. Login via dashboard → GLM → Login.');
      (err as any).upstreamStatus = 403;
      throw err;
    }

    const err = new Error(`GLM API error (${effStatus}): ${errText.slice(0, 500)}`);
    (err as any).upstreamStatus = effStatus;
    throw err;
  }

  // Non-streaming: buffer entire SSE response, extract content, filter
  if (!isStream) {
    const text = await resp.text();
    logStore.log('debug', 'glm-raw', `len=${text.length} head=${text.slice(0, 1000)}`);

    const lines = text.split('\n').filter((l) => l.startsWith('data: '));
    let fullContent = '';
    let fullThinking = '';
    let usage: any = null;

    for (const line of lines) {
      try {
        const raw = line.slice(6);
        if (raw === '[DONE]') continue;
        const parsed = JSON.parse(raw);
        const data = parsed.data || parsed;

        if (data.error?.code === 'FRONTEND_CAPTCHA_REQUIRED') {
          invalidateCaptchaToken();
          const err = new Error('GLM requires CAPTCHA verification: ' + (data.error.detail || 'CAPTCHA required'));
          (err as any).upstreamStatus = 403;
          throw err;
        }

        if (data.phase === 'thinking') {
          fullThinking += data.delta_content || '';
        } else if (data.phase === 'answer') {
          fullContent += data.delta_content || '';
        } else if (data.phase === 'other' && data.usage) {
          usage = data.usage;
        }
      } catch (e: any) {
        if ((e as any)?.upstreamStatus) throw e;
      }
    }

    // Content filter pipeline (same as Qwen — strip thinking tags, XML artifacts)
    const rawContent = fullContent || ' ';
    const filtered = filterContent(rawContent);
    const cleanedText = cleanTextOfXmlArtifacts(filtered.cleanText).cleanedText || ' ';

    logStore.addProcessedOutput(logId, cleanedText);
    if (fullThinking || filtered.thinking) logStore.addProcessedOutput(logId, '[THINKING] ' + (fullThinking || filtered.thinking));

    const responseMsg: Record<string, any> = {
      role: 'assistant',
      content: cleanedText,
    };
    if (fullThinking || filtered.thinking) {
      responseMsg.reasoning_content = fullThinking || filtered.thinking;
    }

    return c.json(
      {
        id: session.id,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{ index: 0, message: responseMsg, finish_reason: 'stop' }],
        usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      },
      { headers: { 'content-type': 'application/json' } },
    );
  }

  // ── Streaming: convert GLM three-phase SSE to OpenAI format ──
  if (!resp.body) {
    throw Object.assign(new Error('GLM returned empty response body'), { upstreamStatus: 502 });
  }

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const state: GlmStreamState = createGlmStreamState();

  (async () => {
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          if (!state.isFinished) {
            await writer.write(encoder.encode('data: [DONE]\n\n'));
          }
          await writer.close();
          break;
        }
        const chunkStr = decoder.decode(value, { stream: true });
        logStore.addRawChunk(logId, chunkStr);
        buffer += chunkStr;

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const { chunks, done: streamDone } = parseGlmSseLine(line, state, model, session.id);
          for (const chunk of chunks) {
            await writer.write(encoder.encode(chunk));
          }
          if (streamDone) {
            await writer.close();
            return;
          }
        }
      }
    } catch (err: any) {
      logStore.log('error', 'glm-stream', `Stream error: ${err.message}`);
      try {
        await writer.write(encoder.encode('data: [DONE]\n\n'));
        await writer.close();
      } catch {}
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
