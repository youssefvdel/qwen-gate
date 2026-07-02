/*
 * File: providers/glm/handler.ts
 * GLM provider — account rotation, TLS fingerprint impersonation, retry logic.
 *
 * Uses wreqFetch (Rust + BoringSSL) for TLS/HTTP2 fingerprint impersonation
 * to bypass GLM's anti-bot detection, with per-account captcha handling.
 */

import crypto from 'node:crypto';
import type { Context } from 'hono';
import { logStore } from '../../../services/logStore.ts';
import type { OpenAIRequest } from '../../../types/openai.ts';
import { registerProvider } from '../../providerRegistry.ts';

const MAX_RETRIES = 5;

export async function glmHandler(c: Context, body: OpenAIRequest): Promise<Response> {
  const model = body.model.replace(/^glm\//, '');
  const isStream = body.stream === true;
  let lastFailedEmail: string | undefined;
  let lastError: unknown;

  const logId = crypto.randomUUID();
  logStore.createEntry(logId, body.model, isStream);
  logStore.updateEntry(logId, (entry) => {
    entry.apiType = 'openai';
  });

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const { pickAccountForProvider, decrementInFlight } = await import('../../../services/auth.ts');
    const acct = await pickAccountForProvider('glm', lastFailedEmail);
    const email = acct?.email || '';

    logStore.log(
      'debug',
      'glm-handler',
      `Attempt ${attempt + 1}/${MAX_RETRIES} picked=${email || 'NONE'} lastFailed=${lastFailedEmail || 'none'}`,
    );

    if (!acct) {
      if (attempt > 0) {
        logStore.log(
          'error',
          'glm-handler',
          `All ${MAX_RETRIES} attempts exhausted — ${lastError instanceof Error ? lastError.message : String(lastError || 'unknown error')}`,
        );
        return c.json(
          {
            error: {
              message: lastError instanceof Error ? lastError.message : 'All GLM accounts rate-limited. Please try again later.',
              type: 'rate_limit_error',
            },
          },
          { status: 503, headers: { 'content-type': 'application/json' } },
        );
      }
      return c.json(
        {
          error: {
            message: 'No GLM account logged in. Login via dashboard first.',
            type: 'auth_error',
          },
        },
        { status: 503, headers: { 'content-type': 'application/json' } },
      );
    }

    const jwt = acct.providerStates.glm?.token;
    if (!jwt) {
      decrementInFlight(email);
      lastFailedEmail = email;
      continue;
    }

    try {
      const { proxyViaGlmWebChat } = await import('./pipeline.ts');
      const result = await proxyViaGlmWebChat(c, body, email, jwt, model, isStream, logId);

      decrementInFlight(email);
      logStore.finalizeRequest(logId);
      return result;
    } catch (err: any) {
      const { decrementInFlight: dec, throttleAccount, setProviderStateLastError } = await import('../../../services/auth.ts');
      dec(email);

      const errMsg = err.message || String(err);

      if (err.upstreamStatus === 429 || /rate.?limit|too many requests|quota/i.test(errMsg)) {
        logStore.log('warn', 'glm-handler', `Rate limited on ${email} — throttling + retrying`);
        throttleAccount(email, 2 * 60 * 60 * 1000);
        setProviderStateLastError(email, 'glm', `rate_limited: ${errMsg}`);
        lastFailedEmail = email;
        lastError = err;
        continue;
      }

      if (/CAPTCHA|FRONTEND_CAPTCHA|captcha|bot.?detect|waf|blocked/i.test(errMsg)) {
        logStore.log('warn', 'glm-handler', `Captcha/bot detection on ${email} — throttling + switching`);
        throttleAccount(email, 5 * 60 * 1000);
        setProviderStateLastError(email, 'glm', `bot_detection: ${errMsg}`);
        lastFailedEmail = email;
        lastError = err;
        continue;
      }

      if (err.upstreamStatus === 401 || /token.*expired|unauthorized|invalid.*token|403/i.test(errMsg)) {
        logStore.log('warn', 'glm-handler', `Token invalid for ${email} — trying next account`);
        setProviderStateLastError(email, 'glm', `auth_failed: ${errMsg}`);
        lastFailedEmail = email;
        lastError = err;
        continue;
      }

      if (err.upstreamStatus === 408 || err.upstreamStatus === 504 || /timeout|timed.?out|etimedout/i.test(errMsg)) {
        logStore.log('warn', 'glm-handler', `Timeout on ${email} — trying next account`);
        lastFailedEmail = email;
        lastError = err;
        continue;
      }

      logStore.log('error', 'glm-handler', `Non-retryable error on ${email}: ${errMsg}`);
      logStore.addError(logId, errMsg);
      logStore.finalizeRequest(logId);
      throw err;
    }
  }

  const exhaustedErr = lastError instanceof Error ? lastError.message : 'GLM request failed after retries';
  logStore.addError(logId, exhaustedErr);
  logStore.finalizeRequest(logId);
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

registerProvider('glm/', glmHandler);
