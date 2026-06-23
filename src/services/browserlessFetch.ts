/**
 * browserlessFetch — CycleTLS wrapper for browserless TLS/HTTP2 impersonation.
 *
 * Uses CycleTLS (Go subprocess with uTLS) to bypass Alibaba WAF.
 * No Rust/tokio conflicts with Bun's event loop.
 */
import initCycleTLS from 'cycletls';
import { extractBxUmidtoken } from './bxTokenExtractor.ts';
import { generateBxPp, generateBxUa, refreshCookiesViaBrowser } from './fireyejsRunner.ts';
import { logStore } from './logStore.ts';
import { QWEN_API_BASE } from './qwen.ts';
import { tokenCache } from './tokenCache.ts';

// ponytail: cycletls manages a Go subprocess internally — no session management needed.
// Single-flight guard: one cookie refresh per account at a time
const cookieRefreshInFlight = new Map<string, Promise<string | null>>();
const BX_UMIDTOKEN_TTL_MS = 4 * 60 * 60 * 1000;
const BX_UA_TTL_MS = 15 * 60 * 1000;

const CHROME_142_JA3 =
  '771,4865-4866-4867-49195-49199-52393-52392-49196-49200-49162-49161-49171-49172-51-57-47-53-10,0-23-65281-10-11-35-16-5-13-18-51-43-27-45-17513-21,29-23-24-25-256-257,0';
const CHROME_142_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

let _cycleTLS: any = null;
let _cycleTLSInitPromise: Promise<any> | null = null;

async function getCycleTLS(): Promise<any> {
  if (_cycleTLS) return _cycleTLS;
  if (!_cycleTLSInitPromise) {
    _cycleTLSInitPromise = initCycleTLS().then((client: any) => {
      _cycleTLS = client;
      return client;
    });
  }
  return _cycleTLSInitPromise;
}

export interface BrowserlessFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  accountEmail?: string;
  signal?: AbortSignal;
  /** Request a streaming response from cycletls. */
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

/** Fetch acw_tc cookie from the Qwen root page using cycletls. */
async function refreshAcwTcCookie(): Promise<string | null> {
  try {
    const cycleTLS = await getCycleTLS();
    const resp = await cycleTLS(
      QWEN_API_BASE,
      {
        body: '',
        ja3: CHROME_142_JA3,
        userAgent: CHROME_142_UA,
        headers: { accept: 'text/html,application/xhtml+xml' },
      },
      'GET',
    );

    let acwTc: string | null = null;
    // Check set-cookie header
    const setCookieHeaders = resp.headers?.['set-cookie'];
    if (setCookieHeaders) {
      const headers = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
      for (const h of headers) {
        const match = h.match(/acw_tc=([^;]+)/);
        if (match) {
          acwTc = match[1];
          break;
        }
      }
    }

    if (acwTc) {
      tokenCache.set('acw_tc', acwTc, ACW_TC_REFRESH_MS * 2);
      logStore.log('debug', 'browserless', `acw_tc cookie refreshed: ${acwTc.substring(0, 16)}...`);
    }
    return acwTc;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logStore.log('warn', 'browserless', `acw_tc refresh failed: ${msg}`);
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

/** Inject acw_tc cookie into headers from cache. */
async function ensureAcwTcCookie(headers: Record<string, string>): Promise<void> {
  startAcwTcRefresh();

  let acwTc = tokenCache.get('acw_tc') ?? null;
  if (!acwTc) {
    acwTc = await refreshAcwTcCookie();
  }
  if (acwTc) {
    const existing = headers['cookie'] || '';
    if (!existing.includes('acw_tc=')) {
      headers['cookie'] = existing ? `${existing}; acw_tc=${acwTc}` : `acw_tc=${acwTc}`;
    }
  }
}

/** Wrap a CycleTLS response into a standard Web Response object. */
async function wrapCycleTlsResponse(resp: any, stream?: boolean): Promise<Response> {
  if (stream) {
    // streaming: resp.data is a Node.js Readable stream (event emitter)
    return new Response(
      new ReadableStream({
        start(controller) {
          resp.data.on('data', (chunk: Buffer) => controller.enqueue(chunk));
          resp.data.on('end', () => controller.close());
          resp.data.on('error', (err: Error) => controller.error(err));
        },
      }),
      {
        status: resp.status || 200,
        headers: new Headers(resp.headers || {}),
      },
    );
  }

  // Non-streaming: resp.data is a string
  const bodyText = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data || '');
  return new Response(bodyText, {
    status: resp.status || 200,
    headers: new Headers(resp.headers || {}),
  });
}

/**
 * Make a browserless HTTP request to Qwen API.
 *
 * Returns a standard Response object.
 * Use `response.body.getReader()` for SSE streaming.
 */
export async function browserlessFetch(url: string, options: BrowserlessFetchOptions = {}): Promise<Response> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) {
    const { method = 'GET', headers = {}, body } = options;
    return globalThis.fetch(url, { method, headers, body });
  }

  const { method = 'GET', headers = {}, body, signal, stream } = options;

  const cycleTLS = await getCycleTLS();

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
      headers['bx-ua'] = CHROME_142_UA;
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

  await ensureAcwTcCookie(headers);

  const startTime = Date.now();
  try {
    let response = await cycleTLS(
      url,
      {
        body: body || '',
        ja3: CHROME_142_JA3,
        userAgent: CHROME_142_UA,
        headers,
        responseType: stream ? 'stream' : undefined,
        disableRedirect: true,
        timeout: 60,
      },
      (method || 'GET').toLowerCase(),
    );

    // Check for WAF by inspecting the raw cycletls response before wrapping
    const wafCheck = (r: any): boolean => {
      if (r.status === 302) return true;
      if (r.status === 403) return true;
      if (r.status === 200) {
        try {
          const ct = r.headers?.['content-type'] || '';
          if (ct.includes('text/html')) return true;
        } catch {
          /* ignore */
        }
      }
      return false;
    };

    if (wafCheck(response)) {
      // Wrap raw response so we can call .text() on it
      const wrappedResponse = await wrapCycleTlsResponse(response, false);

      logStore.log('warn', 'browserless', `WAF detected on ${url.split('?')[0]} — trying HTTP refresh first...`);
      const currentCookie = headers['cookie'] || '';

      const freshAcwTc = await refreshAcwTcCookie();
      if (freshAcwTc && !currentCookie.includes('acw_tc=')) {
        headers['cookie'] = currentCookie ? `${currentCookie}; acw_tc=${freshAcwTc}` : `acw_tc=${freshAcwTc}`;
      }

      const responseText = await wrappedResponse.text().catch(() => '');
      const isStillWaf = !responseText || responseText.includes('aliyun_waf') || responseText.includes('<html');
      if (!isStillWaf) {
        return wrappedResponse;
      }

      logStore.log('warn', 'browserless', `HTTP refresh failed — trying Playwright browser...`);
      const key = options.accountEmail || '_default_';
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

        response = await cycleTLS(
          url,
          {
            body: body || '',
            ja3: CHROME_142_JA3,
            userAgent: CHROME_142_UA,
            headers,
            responseType: stream ? 'stream' : undefined,
            disableRedirect: true,
            timeout: 60,
          },
          (method || 'GET').toLowerCase(),
        );
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

    // Wrap cycletls response into a standard Response object
    return await wrapCycleTlsResponse(response, stream);
  } catch (err) {
    const elapsed = Date.now() - startTime;
    const msg = err instanceof Error ? err.message : String(err);
    logStore.log('warn', 'browserless', `${method} ${url.split('?')[0]} failed after ${elapsed}ms: ${msg}`);

    if (msg.includes('403') || msg.includes('FAIL_SYS_USER_VALIDATE')) {
      tokenCache.delete('bx-umidtoken');
    }

    throw err;
  }
}

/** Dispose the cycletls Go subprocess. */
export async function disposeSession(): Promise<void> {
  if (_cycleTLS) {
    try {
      await _cycleTLS.exit();
    } catch {}
    _cycleTLS = null;
    _cycleTLSInitPromise = null;
  }
}
