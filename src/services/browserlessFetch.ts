/**
 * browserlessFetch — wreq-js worker wrapper for browserless TLS/HTTP2 impersonation.
 *
 * Uses a Node.js sidecar worker running wreq-js (Rust + BoringSSL) with
 * Chrome 142 fingerprint to bypass Alibaba WAF.
 *
 * Manages:
 *   - TLS/HTTP2 impersonation (Chrome 142 via wreq worker)
 *   - bx-umidtoken auto-extraction + caching
 *   - bx-v / bx-et static headers
 *   - WAF detection + recovery via Playwright cookie refresh
 */

import { logCrash, logEvent, logFetchCall } from '../utils/wreqCrashLogger.ts';
import { extractBxUmidtoken } from './bxTokenExtractor.ts';
import { generateBxPp, generateBxUa, refreshCookiesViaBrowser } from './fireyejsRunner.ts';
import { logStore } from './logStore.ts';
import { QWEN_API_BASE } from './qwen.ts';
import { tokenCache } from './tokenCache.ts';
import { disposeWreqWorker, wreqFetch } from './wreqFetch.ts';

// wreq-js (BoringSSL) is the only transport — bypasses library-level WAF
// detection that impers (libcurl/OpenSSL) couldn't.

// Single-flight guard: one cookie refresh per account at a time
const cookieRefreshInFlight = new Map<string, Promise<string | null>>();
const BX_UMIDTOKEN_TTL_MS = 4 * 60 * 60 * 1000;
const BX_UA_TTL_MS = 15 * 60 * 1000;

export interface BrowserlessFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  accountEmail?: string;
  signal?: AbortSignal;
  /** Keep the session alive for streaming. Default false — session is closed after response. */
  stream?: boolean;
}

/** Ensure bx-umidtoken is in headers, fetching from cache or sg-wum endpoint. */
async function ensureBxUmidtoken(headers: Record<string, string>): Promise<void> {
  if (headers['bx-umidtoken']) return;
  const token = await tokenCache.getOrSet('bx-umidtoken', extractBxUmidtoken, BX_UMIDTOKEN_TTL_MS);
  headers['bx-umidtoken'] = token;
}

// ─── acw_tc cookie (Alibaba WAF) ────────────────────────────────────────────

let acwTcRefreshTimer: ReturnType<typeof setInterval> | null = null;
const ACW_TC_REFRESH_MS = 15 * 60 * 1000; // 15 minutes

/** Fetch acw_tc cookie from the Qwen root page via wreq worker. */
async function refreshAcwTcCookie(): Promise<string | null> {
  try {
    logEvent('refreshAcwTcCookie', 'fetching acw_tc from root');
    const resp = await wreqFetch(QWEN_API_BASE, {
      method: 'GET',
      headers: { accept: 'text/html,application/xhtml+xml' },
      debugLogDir: process.env.DEBUG_IMPERS_DIR,
    });
    logFetchCall('refreshAcwTcCookie', QWEN_API_BASE, 'GET', resp.status);
    let acwTc: string | null = null;
    const setCookie = resp.headers.get('set-cookie');
    if (setCookie && setCookie.includes('acw_tc=')) {
      const match = setCookie.match(/acw_tc=([^;]+)/);
      if (match) acwTc = match[1];
    }
    if (acwTc) {
      tokenCache.set('acw_tc', acwTc, ACW_TC_REFRESH_MS * 2);
      logStore.log('debug', 'browserless', `acw_tc cookie refreshed: ${acwTc.substring(0, 16)}...`);
      logEvent('refreshAcwTcCookie', 'acw_tc obtained', { acwTc: acwTc.substring(0, 16) });
    } else {
      logEvent('refreshAcwTcCookie', 'no acw_tc in response');
    }
    return acwTc;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logStore.log('warn', 'browserless', `acw_tc refresh failed: ${msg}`);
    logCrash('refreshAcwTcCookie', err);
    return null;
  }
}

/** Start periodic acw_tc refresh (idempotent). */
function startAcwTcRefresh(): void {
  if (acwTcRefreshTimer) return;
  setTimeout(() => {
    refreshAcwTcCookie().catch(() => {});
  }, 1000);
  acwTcRefreshTimer = setInterval(() => {
    refreshAcwTcCookie().catch(() => {});
  }, ACW_TC_REFRESH_MS);
}

/** Inject acw_tc cookie into headers from a per-account cache key.
 *  A single global acw_tc made every account share one WAF session cookie on
 *  the same IP -> strong bot signal. Keying by email keeps each account's WAF
 *  session distinct; falls back to the shared refreshed value when unknown. */
async function ensureAcwTcCookie(headers: Record<string, string>, accountEmail?: string): Promise<void> {
  startAcwTcRefresh();

  const cacheKey = accountEmail ? `acw_tc:${accountEmail}` : 'acw_tc';
  let acwTc = tokenCache.get(cacheKey) ?? tokenCache.get('acw_tc') ?? null;
  if (!acwTc) {
    acwTc = await refreshAcwTcCookie();
  }
  if (acwTc) {
    if (accountEmail) tokenCache.set(cacheKey, acwTc, ACW_TC_REFRESH_MS * 2);
    const existing = headers['cookie'] || '';
    if (!existing.includes('acw_tc=')) {
      headers['cookie'] = existing ? `${existing}; acw_tc=${acwTc}` : `acw_tc=${acwTc}`;
    }
  }
}

// ─── WAF check ──────────────────────────────────────────────────────────────

const wafCheck = (r: Response): boolean => {
  if (r.status === 302) return true;
  if (r.status === 403) return true;
  if (r.status === 200) {
    try {
      const ct = r.headers.get('content-type') || '';
      if (ct.includes('text/html')) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
};

/**
 * Make a browserless HTTP request to Qwen API.
 *
 * Returns a standard Web API Response object.
 * Use `response.body.getReader()` for SSE streaming.
 */
export async function browserlessFetch(url: string, options: BrowserlessFetchOptions = {}): Promise<Response> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) {
    const { method = 'GET', headers = {}, body } = options;
    return globalThis.fetch(url, { method, headers, body });
  }

  const { method = 'GET', headers = {}, body, accountEmail, signal, stream } = options;

  // Auto-inject bx tokens
  await ensureBxUmidtoken(headers);

  if (!headers['bx-v']) headers['bx-v'] = '2.5.36';
  if (!headers['bx-et']) headers['bx-et'] = 'nosgn';

  if (!headers['bx-ua']) {
    const cached = tokenCache.get('bx-ua');
    if (cached) {
      headers['bx-ua'] = cached;
    } else {
      try {
        const generated = await generateBxUa();
        if (generated) headers['bx-ua'] = generated;
      } catch {
        /* fallback */
      }
    }
    if (!headers['bx-ua']) {
      headers['bx-ua'] = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
    }
  }

  if (!headers['bx-pp']) {
    try {
      const pp = await generateBxPp(body);
      if (pp) headers['bx-pp'] = pp;
    } catch {
      /* optional */
    }
  }

  await ensureAcwTcCookie(headers, accountEmail);

  const startTime = Date.now();

  // ─── Initial request via wreq worker ─────────────────────────────────
  try {
    logFetchCall('browserlessFetch', url, method);
    let response = await wreqFetch(url, {
      method,
      headers,
      body,
      signal,
      stream: !!stream,
      debugLogDir: process.env.DEBUG_IMPERS_DIR,
    });
    logFetchCall('browserlessFetch', url, method, response.status);

    // ─── WAF detection + recovery ─────────────────────────────────────
    if (wafCheck(response)) {
      logEvent('browserlessFetch', 'WAF detected', { url: url.split('?')[0], status: response.status });
      logStore.log('warn', 'browserless', `WAF detected on ${url.split('?')[0]} — trying HTTP refresh first...`);
      const currentCookie = headers['cookie'] || '';

      const freshAcwTc = await refreshAcwTcCookie();
      if (freshAcwTc && !currentCookie.includes('acw_tc=')) {
        headers['cookie'] = currentCookie ? `${currentCookie}; acw_tc=${freshAcwTc}` : `acw_tc=${freshAcwTc}`;
      }

      const responseText = await response.text().catch(() => '');
      const isStillWaf = !responseText || responseText.includes('aliyun_waf') || responseText.includes('<html');
      if (!isStillWaf) {
        // The acw_tc refresh worked — response body is valid
        return response;
      }

      logStore.log('warn', 'browserless', `HTTP refresh failed — trying Playwright browser...`);
      const key = accountEmail || '_default_';
      let promise = cookieRefreshInFlight.get(key);
      if (!promise) {
        promise = refreshCookiesViaBrowser(currentCookie).finally(() => {
          cookieRefreshInFlight.delete(key);
        });
        cookieRefreshInFlight.set(key, promise);
      }
      const freshCookies = await promise;
      if (freshCookies) {
        headers['cookie'] = freshCookies;
        tokenCache.delete('bx-ua');
        tokenCache.delete('bx-pp');
        tokenCache.delete('acw_tc');
        await ensureBxUmidtoken(headers);
        headers['bx-ua'] = (await generateBxUa()) || headers['bx-ua'];
        const pp = await generateBxPp(body);
        if (pp) headers['bx-pp'] = pp;
        logStore.log('info', 'browserless', `Retrying ${url.split('?')[0]} with fresh cookies...`);

        logEvent('browserlessFetch', 'WAF retry', { url: url.split('?')[0] });
        logFetchCall('browserlessFetch.retry', url, method);
        response = await wreqFetch(url, {
          method,
          headers,
          body,
          signal,
          stream: !!stream,
          debugLogDir: process.env.DEBUG_IMPERS_DIR,
        });
        logFetchCall('browserlessFetch.retry', url, method, response.status);
        if (wafCheck(response)) {
          throw new Error(`WAF challenge persists after cookie refresh for ${url.split('?')[0]}`);
        }
      }
      if (!freshCookies) {
        throw new Error(`Cookie refresh failed for ${url.split('?')[0]} — cannot retry`);
      }
    }

    const elapsed = Date.now() - startTime;
    logStore.log('debug', 'browserless', `${method} ${url.split('?')[0]} → ${response.status} (${elapsed}ms)`);

    // For streaming: stash noop close function so qwen.ts doesn't break
    if (stream) {
      (response as any)._wreqClose = () => {
        // Worker creates fresh session per request — nothing to close.
      };
      return response;
    }

    return response;
  } catch (err) {
    const elapsed = Date.now() - startTime;
    const msg = err instanceof Error ? err.message : String(err);

    // Classify crash type for easier analysis
    const errStr = msg.toLowerCase();
    if (errStr.includes('waf') || errStr.includes('aliyun_waf') || errStr.includes('403') || errStr.includes('302')) {
      logEvent('browserlessFetch', 'WAF error', { url: url.split('?')[0], method, error: msg.substring(0, 200), elapsed_ms: elapsed });
    } else {
      logCrash('browserlessFetch', err, { url: url.split('?')[0], method, elapsed_ms: elapsed });
    }

    logStore.log('warn', 'browserless', `${method} ${url.split('?')[0]} failed after ${elapsed}ms: ${msg}`);

    if (msg.includes('403') || msg.includes('FAIL_SYS_USER_VALIDATE')) {
      tokenCache.delete('bx-umidtoken');
    }

    throw err;
  }
}

/** Dispose the wreq worker process. Call on app shutdown. */
export async function disposeSession(_accountEmail?: string): Promise<void> {
  await disposeWreqWorker();
}
