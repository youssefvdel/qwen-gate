/**
 * plainFetch — fast plain-HTTP transport to the Qwen Chat API.
 *
 * Uses native fetch (undici/Bun) with keep-alive connection reuse and the
 * SSXMOD fingerprint cookie (see ssxmod.ts) instead of the wreq-js worker.
 * This mirrors the QwenFreeApi approach: a fresh HTTP/1.1 request per call
 * with a browser-grade cookie set is enough to pass the Aliyun WAF.
 *
 * It is only a drop-in replacement for the request I/O of browserlessFetch —
 * WAF detection, cookie refresh and the wreq fallback all live in the caller,
 * so this module deliberately stays dumb (no retries, no fingerprinting).
 */

import { logStore } from './logStore.ts';
import { getSsxmodCookies } from './ssxmod.ts';

const FETCH_TIMEOUT_MS = 120000;

export interface PlainFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

function withSsxmodCookie(headers: Record<string, string>): Record<string, string> {
  const { ssxmod_itna, ssxmod_itna2 } = getSsxmodCookies();
  const cookieParts = [headers['cookie']].filter(Boolean);
  if (ssxmod_itna) cookieParts.push(`ssxmod_itna=${ssxmod_itna}`);
  if (ssxmod_itna2) cookieParts.push(`ssxmod_itna2=${ssxmod_itna2}`);
  return { ...headers, cookie: cookieParts.join('; ') };
}

/**
 * Perform a plain HTTP request. Throws on network failure or timeout.
 * Does NOT judge WAF (caller does wafCheck on the result).
 */
export async function plainQwenFetch(url: string, options: PlainFetchOptions = {}): Promise<Response> {
  const { method = 'GET', headers = {}, body, signal } = options;

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timeout = setTimeout(() => controller.abort(new Error('plain fetch timeout')), FETCH_TIMEOUT_MS);

  const start = Date.now();
  try {
    const response = await fetch(url, {
      method,
      headers: withSsxmodCookie(headers),
      body: body || undefined,
      signal: controller.signal,
      redirect: 'follow',
    });
    const elapsed = Date.now() - start;
    logStore.log('debug', 'plainFetch', `${method} ${new URL(url).pathname} → ${response.status} via keep-alive (${elapsed}ms)`);
    return response;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logStore.log('warn', 'plainFetch', `${method} ${new URL(url).pathname} failed: ${msg}`);
    throw err;
  } finally {
    clearTimeout(timeout);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}
