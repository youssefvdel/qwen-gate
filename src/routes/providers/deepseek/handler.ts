/*
 * File: providers/deepseek/handler.ts
 * DeepSeek provider — account rotation, TLS fingerprint impersonation, retry logic.
 *
 * Uses wreqFetch (Rust + BoringSSL) for TLS/HTTP2 fingerprint impersonation
 * to bypass DeepSeek's WAF, with per-account PoW solving.
 */

import crypto from 'node:crypto';
import type { Context } from 'hono';
import { logStore } from '../../../services/logStore.ts';
import type { OpenAIRequest } from '../../../types/openai.ts';
import { registerProvider } from '../../providerRegistry.ts';

const MAX_RETRIES = 5;

export async function deepseekHandler(c: Context, body: OpenAIRequest): Promise<Response> {
  const model = body.model.replace(/^deepseek\//, '');
  const isStream = body.stream === true;
  let lastFailedEmail: string | undefined;
  let lastError: unknown;

  const startTs = Date.now();
  const logId = crypto.randomUUID();
  logStore.createEntry(logId, body.model, isStream);
  logStore.updateEntry(logId, (entry) => {
    entry.apiType = 'openai';
  });

  // Client request logging (mirrors the Qwen handler so the dashboard log
  // detail view and .logs/*.json files show real request data for deepseek).
  const msgs = body.messages || [];
  const rawLast = msgs.length > 0 ? msgs[msgs.length - 1].content : '';
  const lastMsg = typeof rawLast === 'string' ? rawLast : rawLast !== undefined ? JSON.stringify(rawLast) : '';
  logStore.updateEntry(logId, (entry) => {
    entry.clientRequest = {
      messageCount: msgs.length,
      roles: msgs.map((m: any) => m.role),
      hasTools: !!body.tools?.length,
      toolNames: body.tools?.map((t: any) => t.function?.name || t.name) || [],
      tool_choice: body.tool_choice ? (typeof body.tool_choice === 'string' ? body.tool_choice : JSON.stringify(body.tool_choice)) : null,
      lastMessage: lastMsg.substring(0, 300),
      messages: msgs.map((m: any) => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      })),
    };
  });

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const { pickAccountForProvider, decrementInFlight, incrementTotalRequests } = await import('../../../services/auth.ts');
    const acct = await pickAccountForProvider('deepseek', lastFailedEmail);
    const email = acct?.email || '';

    logStore.log(
      'debug',
      'deepseek-handler',
      `Attempt ${attempt + 1}/${MAX_RETRIES} picked=${email || 'NONE'} lastFailed=${lastFailedEmail || 'none'}`,
    );

    if (!acct) {
      if (attempt > 0) {
        logStore.log(
          'error',
          'deepseek-handler',
          `All ${MAX_RETRIES} attempts exhausted — ${lastError instanceof Error ? lastError.message : String(lastError || 'unknown error')}`,
        );
        return c.json(
          {
            error: {
              message: lastError instanceof Error ? lastError.message : 'All DeepSeek accounts rate-limited. Please try again later.',
              type: 'rate_limit_error',
            },
          },
          { status: 503, headers: { 'content-type': 'application/json' } },
        );
      }
      return c.json(
        {
          error: {
            message: 'No DeepSeek account logged in. Login via dashboard first.',
            type: 'auth_error',
          },
        },
        { status: 503, headers: { 'content-type': 'application/json' } },
      );
    }

    const bearerToken = acct.providerStates.deepseek?.token;
    if (!bearerToken) {
      decrementInFlight(email);
      lastFailedEmail = email;
      continue;
    }

    // Account telemetry — feeds the dashboard KPIs (total requests), the
    // per-account stats on the providers page, and the monitor store.
    // NOTE: pickAccountForProvider already incremented inFlight — do NOT
    // increment again here or the counter leaks +1 per request.
    incrementTotalRequests(email);
    logStore.updateEntry(logId, (entry) => {
      entry.accountEmail = email;
    });

    try {
      const { proxyViaDeepSeekWebChat } = await import('./pipeline.ts');
      const result = await proxyViaDeepSeekWebChat(c, body, email, bearerToken, model, isStream, logId);

      // For non-streaming, decrement inFlight immediately (response is complete).
      // For streaming, the response body reader holds the stream open; decrement
      // is a load-balancing heuristic, so slight over-counting is harmless
      // (safety valve at 20, auto-correction on next request from same account).
      decrementInFlight(email);
      if (!isStream) {
        // Non-stream responses are complete here — record health + finalize.
        logStore.recordModelSuccess(body.model);
        logStore.finalizeRequest(logId, { latencyMs: Date.now() - startTs });
      }
      // Streaming: health + finalize are handled by the pipeline when the
      // stream actually completes (success OR mid-stream error) — recording
      // success here would count a later upstream rejection (e.g. a late
      // "Content is too long" hint) as a healthy request in Model Health.
      return result;
    } catch (err: any) {
      // Decrement inFlight since we're failing this account
      const { decrementInFlight: dec, throttleAccount, setProviderStateLastError } = await import('../../../services/auth.ts');
      dec(email);

      // Classify error and decide whether to retry
      const errMsg = err.message || String(err);

      if (err.upstreamStatus === 429 || /rate.?limit|too many requests|quota/i.test(errMsg)) {
        logStore.log('warn', 'deepseek-handler', `Rate limited on ${email} — throttling + retrying`);
        throttleAccount(email, 2 * 60 * 60 * 1000);
        setProviderStateLastError(email, 'deepseek', `rate_limited: ${errMsg}`);
        lastFailedEmail = email;
        lastError = err;
        continue;
      }

      if (/CAPTCHA|FAIL_SYS_USER_VALIDATE|bot.?detect|waf|blocked/i.test(errMsg)) {
        logStore.log('warn', 'deepseek-handler', `Bot detection on ${email} — throttling + switching`);
        throttleAccount(email, 5 * 60 * 1000);
        setProviderStateLastError(email, 'deepseek', `bot_detection: ${errMsg}`);
        lastFailedEmail = email;
        lastError = err;
        continue;
      }

      if (err.upstreamStatus === 401 || /token.*expired|unauthorized|invalid.*token|403/i.test(errMsg)) {
        logStore.log('warn', 'deepseek-handler', `Token invalid for ${email} — trying next account`);
        setProviderStateLastError(email, 'deepseek', `auth_failed: ${errMsg}`);
        lastFailedEmail = email;
        lastError = err;
        continue;
      }

      if (err.upstreamStatus === 408 || err.upstreamStatus === 504 || /timeout|timed.?out|etimedout/i.test(errMsg)) {
        logStore.log('warn', 'deepseek-handler', `Timeout on ${email} — trying next account`);
        lastFailedEmail = email;
        lastError = err;
        continue;
      }

      // Non-retryable — propagate immediately
      logStore.log('error', 'deepseek-handler', `Non-retryable error on ${email}: ${errMsg}`);
      logStore.recordModelError(body.model);
      logStore.addError(logId, errMsg);
      logStore.finalizeRequest(logId, { latencyMs: Date.now() - startTs, finishReason: 'error' });
      throw err;
    }
  }

  const exhaustedErr = lastError instanceof Error ? lastError.message : 'DeepSeek request failed after retries';
  logStore.recordModelError(body.model);
  logStore.addError(logId, exhaustedErr);
  logStore.finalizeRequest(logId, { latencyMs: Date.now() - startTs, finishReason: 'error' });
  return c.json(
    {
      error: {
        message: exhaustedErr,
        type: 'server_error',
      },
    },
    { status: 500, headers: { 'content-type': 'application/json' } },
  );
}

registerProvider('deepseek/', deepseekHandler);
