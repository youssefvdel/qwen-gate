/*
 * File: loginHelpers.ts
 * Login implementation helpers extracted from auth.ts.
 * Contains the three login strategies: browser context, fetch, and temp context.
 */

import crypto from 'crypto';
import type { AuthState } from '../types/auth.ts';
import { checkPlaywrightSession, getAuthTokenMaxAgeMs } from './auth.ts';
import { tokenExpiresAt } from './accountManager.ts';
import { logStore } from './logStore.ts';
import { AccountContext, createAccountContext, getActivePage, getBrowser, Mutex, removeAccountContext } from './playwright.ts';
import { createFetchTimeout, QWEN_BX_V } from './qwen.ts';

const QWEN_CHAT_URL = 'https://chat.qwen.ai';

/**
 * Login via browser context — executes signin API inside the browser via evaluate().
 */
export async function loginFreshViaBrowser(email: string, hashedPassword: string, loginMutex: Mutex): Promise<AuthState | null> {
  const release = await loginMutex.acquire();
  try {
    const page = getActivePage();
    if (!page) return null;

    try {
      const currentUrl = page.url();
      if (!currentUrl.startsWith(QWEN_CHAT_URL)) {
        await page.goto(QWEN_CHAT_URL, { waitUntil: 'domcontentloaded' });
      }
    } catch (err: any) {
      logStore.log('warn', 'auth', `Navigation check failed for ${email}: ${err.message}`);
    }

    try {
      const context = page.context();
      const existingCookies = await context.cookies();
      const authCookies = existingCookies.filter((c) => c.name === 'token' || c.name === 'refresh_token');
      if (authCookies.length > 0) {
        // Only remove specific auth cookies, not ALL cookies
        for (const c of authCookies) {
          await context.clearCookies({ name: c.name, domain: c.domain, path: c.path });
        }
      }
    } catch (err: any) {
      logStore.log('warn', 'auth', `Cookie clearing failed for ${email}: ${err.message}`);
    }

    let evalResult: { ok: boolean; status: number; token: string | null; refreshToken: string | null; dataKeys: string[] };
    try {
      evalResult = await page.evaluate(
        async ({ email, hashedPassword }: { email: string; hashedPassword: string }) => {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 15_000);
          let response: Response;
          try {
            response = await fetch(`${QWEN_CHAT_URL}/api/v2/auths/signin`, {
              method: 'POST',
              headers: {
                accept: 'application/json, text/plain, */*',
                'content-type': 'application/json',
                source: 'web',
                timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                'x-request-id': crypto.randomUUID(),
              },
              credentials: 'include',
              body: JSON.stringify({ email, password: hashedPassword }),
              signal: controller.signal,
            });
          } finally {
            clearTimeout(timeoutId);
          }

          let data: any = {};
          try {
            data = await response.json();
          } catch {
            // non-blocking: non-JSON responses fall back to empty data
          }

          const token = data?.data?.token || data?.token || data?.data?.session_token || null;
          const refreshToken = data?.data?.refresh_token || data?.refresh_token || null;

          return {
            ok: response.ok,
            status: response.status,
            token: token as string | null,
            refreshToken: refreshToken as string | null,
            dataKeys: Object.keys(data),
          };
        },
        { email, hashedPassword },
      );
    } catch (err: any) {
      logStore.log('error', 'auth', `Browser evaluate failed for ${email}: ${err.message}`);
      return null;
    }

    if (!evalResult.ok) {
      logStore.log('error', 'auth', `Login failed for ${email} (${evalResult.status})`);
      return null;
    }

    let cookieToken: string | null = null;
    let cookieRefresh: string | null = null;
    try {
      const cookies = await page.context().cookies();
      const tokenCookie = cookies.find(
        (c) =>
          c.name === 'token' ||
          (c.name.toLowerCase().includes('token') && c.domain.includes('qwen') && !c.name.toLowerCase().includes('refresh')),
      );
      const refreshCookie = cookies.find(
        (c) => c.name === 'refresh_token' || (c.name.toLowerCase().includes('refresh') && c.domain.includes('qwen')),
      );
      cookieToken = tokenCookie?.value || null;
      cookieRefresh = refreshCookie?.value || null;
    } catch (err: any) {
      logStore.log('warn', 'auth', `Cookie read failed for ${email}: ${err.message}`);
    }

    const finalToken = evalResult.token || cookieToken;
    const finalRefresh = evalResult.refreshToken || cookieRefresh;

    if (finalToken) {
      return {
        token: finalToken,
        expiresAt: tokenExpiresAt(finalToken, getAuthTokenMaxAgeMs()),
        refreshToken: finalRefresh,
      };
    }

    logStore.log(
      'warn',
      'auth',
      `Login returned 200 for ${email} but no token found. ` +
        `Response keys: [${evalResult.dataKeys.join(', ')}]. ` +
        `No auth cookies captured.`,
    );
    return null;
  } finally {
    release();
  }
}

/**
 * Login via plain fetch — fallback for when Playwright is not available.
 */
export async function loginFreshViaFetch(email: string, hashedPassword: string): Promise<AuthState | null> {
  const { controller, cleanup: _cleanup } = createFetchTimeout();
  try {
    const response = await fetch(`${QWEN_CHAT_URL}/api/v2/auths/signin`, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/plain, */*',
        'content-type': 'application/json',
        source: 'web',
        Version: '0.2.57',
        'bx-v': QWEN_BX_V,
        Referer: `${QWEN_CHAT_URL}/auth`,
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        'x-request-id': crypto.randomUUID(),
      },
      body: JSON.stringify({ email, password: hashedPassword }),
      signal: controller.signal,
    });

    if (response.ok) {
      let data: any;
      try {
        data = await response.json();
      } catch {
        data = {};
      }

      let token = data.data?.token || data.token || data.data?.session_token || null;
      let refreshToken = data.data?.refresh_token || data.refresh_token || null;

      // ALWAYS parse set-cookie headers — even when the JSON body has the token,
      // the response also carries baxia/WAF session cookies (cna, ssxmod_itna,
      // tfstk, isg) that must be persisted as profileCookies so chat requests
      // are WAF-warm. Skipping this (the old `if (!token)` gate) left every
      // fetch-login account WAF-cold on steady-state traffic -> mid-chat captcha.
      const hdrs = response.headers as Headers & { getSetCookie?: () => string[] };
      const setCookies: string[] =
        typeof hdrs.getSetCookie === 'function' ? hdrs.getSetCookie() : (response.headers.get('set-cookie') || '').split(',');

      const baxiaCookies: string[] = [];
      for (const cookie of setCookies) {
        const tokenMatch = cookie.match(/\btoken=([^;]+)/);
        if (tokenMatch && !token) token = tokenMatch[1];
        const refreshMatch = cookie.match(/\brefresh_token=([^;]+)/);
        if (refreshMatch) refreshToken = refreshMatch[1];
        // Capture the WAF session cookies by name (strip attributes after ;).
        const nameMatch = cookie.match(/^\s*([a-zA-Z0-9_-]+)=([^;]+)/);
        if (nameMatch) {
          const name = nameMatch[1];
          const value = nameMatch[2];
          if (
            value &&
            name !== 'token' &&
            name !== 'refresh_token' &&
            /^(cna|ssxmod_itna|tfstk|isg|acw_tc|ssxmod_itna|xlly_s|baxia|mtop|csgo)/i.test(name)
          ) {
            baxiaCookies.push(`${name}=${value}`);
          }
        }
      }
      const profileCookies = baxiaCookies.length ? baxiaCookies.join('; ') : undefined;

      if (token) {
        return {
          token,
          expiresAt: tokenExpiresAt(token, getAuthTokenMaxAgeMs()),
          refreshToken,
          profileCookies,
        };
      }

      const hasPlaywrightSession = await checkPlaywrightSession();
      if (hasPlaywrightSession) {
        logStore.log(
          'warn',
          'auth',
          `API login returned 200 but no token for ${email}, and Playwright session exists but has no usable token`,
        );
      }

      logStore.log('warn', 'auth', `API login returned 200 but no token for ${email}: ${JSON.stringify(data).substring(0, 200)}`);
    } else {
      const errText = await response.text();
      logStore.log('error', 'auth', `Login failed for ${email} (${response.status}): ${errText.substring(0, 200)}`);
    }
  } catch (err: any) {
    logStore.log('error', 'auth', `Login error for ${email}: ${err.message}`);
  }

  return null;
}

export async function loginViaTempContext(
  _browser: ReturnType<typeof getBrowser>,
  email: string,
  hashedPassword: string,
  loginMutex: Mutex,
): Promise<AuthState | null> {
  const release = await loginMutex.acquire();
  let accCtx: AccountContext | null = null;
  try {
    accCtx = await createAccountContext(email);
    const page = accCtx.page;
    const context = accCtx.context;

    let capturedToken: string | null = null;
    let capturedRefresh: string | null = null;

    // Intercept signin API to capture token from BOTH JSON body AND set-cookie headers
    await page.route('**/api/v2/auths/signin', async (route) => {
      try {
        const response = await route.fetch();

        // Try to extract token from JSON response body first (fastest path)
        try {
          const body = await response.json();
          const jsonToken = body?.data?.token || body?.token || body?.data?.session_token || null;
          const jsonRefresh = body?.data?.refresh_token || body?.refresh_token || null;
          if (jsonToken && !capturedToken) capturedToken = jsonToken;
          if (jsonRefresh && !capturedRefresh) capturedRefresh = jsonRefresh;
        } catch {
          logStore.log('warn', 'auth', 'signin route fetch returned non-JSON response');
        }

        // Also check set-cookie headers as fallback
        const setCookies = response
          .headersArray()
          .filter((h) => h.name.toLowerCase() === 'set-cookie')
          .map((h) => h.value);
        for (const cookie of setCookies) {
          const tokenMatch = cookie.match(/\btoken=([^;]+)/);
          if (tokenMatch && !capturedToken) capturedToken = tokenMatch[1];
          const refreshMatch = cookie.match(/\brefresh_token=([^;]+)/);
          if (refreshMatch && !capturedRefresh) capturedRefresh = refreshMatch[1];
        }

        await route.fulfill({ response });
      } catch {
        // If route.fetch fails, let the request pass through normally
        await route.continue();
      }
    });

    try {
      await page.goto(`${QWEN_CHAT_URL}/auth`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    } catch {
      logStore.log('warn', 'auth', `goto auth page failed for ${email}`);
    }

    try {
      await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 10_000 });
      await page.fill('input[type="email"], input[name="email"]', email);
      await page.fill('input[type="password"], input[name="password"]', hashedPassword);
      await Promise.all([
        page.click('button[type="submit"], button:has-text("Sign in"), button:has-text("Log in"), button:has-text("Continue")'),
        page.waitForURL((url) => !url.toString().includes('/auth'), { timeout: 15_000 }).catch(() => {}),
      ]);
    } catch {
      logStore.log('warn', 'auth', `form fill/submit failed for ${email}`);
    }

    // Poll for token with shorter intervals instead of blind sleep
    for (let attempt = 0; attempt < 10; attempt++) {
      if (capturedToken) break;
      await new Promise((r) => setTimeout(r, 500));

      // Check cookies as fallback
      try {
        const cookies = await context.cookies();
        const tokenCookie = cookies.find(
          (c) =>
            c.name === 'token' ||
            (c.name.toLowerCase().includes('token') && c.domain.includes('qwen') && !c.name.toLowerCase().includes('refresh')),
        );
        const refreshCookie = cookies.find(
          (c) => c.name === 'refresh_token' || (c.name.toLowerCase().includes('refresh') && c.domain.includes('qwen')),
        );
        if (tokenCookie?.value) capturedToken = tokenCookie.value;
        if (refreshCookie?.value) capturedRefresh = refreshCookie.value;
      } catch {
        logStore.log('warn', 'auth', `cookie read failed during poll for ${email}`);
      }
    }

    await page.unroute('**/api/v2/auths/signin');

    if (capturedToken) {
      return {
        token: capturedToken,
        expiresAt: tokenExpiresAt(capturedToken, getAuthTokenMaxAgeMs()),
        refreshToken: capturedRefresh,
      };
    }

    const cookies = await context.cookies();
    logStore.log('warn', 'auth', `Temp context login failed for ${email}. Cookies: ${cookies.map((c) => c.name).join(', ')}`);
    return null;
  } catch (err: any) {
    logStore.log('error', 'auth', `Temp context login error for ${email}: ${err.message}`);
    return null;
  } finally {
    // Close the temp context to prevent BrowserContext leak. Each loginViaTempContext
    // call creates a new page+context via createAccountContext — without closing it,
    // contexts accumulate in the Playwright browser process, wasting memory.
    if (accCtx) {
      try {
        removeAccountContext(email);
      } catch {
        /* removeAccountContext handles interval clear, context close, and map cleanup */
      }
      try {
        await accCtx.page.close();
      } catch {
        /* page may already be closed */
      }
      try {
        await accCtx.context.close();
      } catch {
        /* context may already be closed or already closed by removeAccountContext */
      }
    }
    release();
  }
}
