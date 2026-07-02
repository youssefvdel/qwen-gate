/*
 * File: deepseekLogin.ts
 * DeepSeek provider login with two strategies:
 * 1. Auto-login (headless stealth) — extracts Bearer token from API response
 * 2. Manual login (headed browser) — token extracted from /api/v0/users/current after auth
 *
 * DeepSeek uses opaque Bearer tokens (NOT JWT), stored in localStorage as "userToken".
 * Token comes from POST /api/v0/users/login -> data.biz_data.user.token
 * or from GET /api/v0/users/current -> data.biz_data.token
 */

import type { ProviderAuthState } from '../types/auth.ts';
import { type AutoLoginOutcome, autoLoginViaBrowser } from './browserProfiles.ts';
import { manualBrowserLogin } from './loginHelpers.ts';
import { logStore } from './logStore.ts';

const DEEPSEEK_LOGIN_URL = 'https://chat.deepseek.com/sign_in';
const DEEPSEEK_CHAT_URL = 'https://chat.deepseek.com';

/**
 * Extract the Bearer token from a browser page after DeepSeek login.
 * The token is stored in localStorage as "userToken" (JSON object with "value" field).
 * Also available from API: GET /api/v0/users/current returns data.biz_data.token
 */
async function extractDeepSeekToken(page: any): Promise<string | null> {
  try {
    // Try localStorage first (fastest)
    var tokenJson: string | null = await page.evaluate(function () {
      try {
        var raw = localStorage.getItem('userToken');
        if (raw) {
          var parsed = JSON.parse(raw);
          return parsed.value || parsed.token || raw;
        }
      } catch {
        // fall through
      }
      return null;
    });
    if (tokenJson) return tokenJson;

    // Fallback: call /api/v0/users/current from browser context
    try {
      var tokenFromApi: string | null = await page.evaluate(async function () {
        try {
          var res = await fetch('https://chat.deepseek.com/api/v0/users/current', {
            credentials: 'include',
          });
          var body = await res.json();
          return body?.data?.biz_data?.token || body?.data?.biz_data?.user?.token || null;
        } catch {
          return null;
        }
      });
      if (tokenFromApi) return tokenFromApi;
    } catch {
      // silent
    }

    return null;
  } catch {
    return null;
  }
}

/** Headless stealth auto-login — uses existing browserProfiles token extraction with provider hint */
export async function loginDeepseekAuto(
  email: string,
  password: string,
): Promise<{ status: 'success' | 'captcha' | 'closed' | 'error'; result?: ProviderAuthState }> {
  var outcome: AutoLoginOutcome = await autoLoginViaBrowser(email, password, {
    provider: 'deepseek',
    authUrl: DEEPSEEK_LOGIN_URL,
    authPagePaths: ['/sign_in'],
  });

  if (outcome.status === 'success' && outcome.token) {
    return {
      status: 'success',
      result: {
        token: outcome.token,
        expiresAt: outcome.expiresAt,
        refreshToken: null,
        lastLoginAttempt: Date.now(),
        wafToken: outcome.wafToken,
      },
    };
  }

  return { status: outcome.status };
}

/** Headed manual browser login — user completes captcha manually */
export async function loginDeepSeekManual(email: string, password: string): Promise<ProviderAuthState | null> {
  var state = await manualBrowserLogin(email, password, {
    loginUrl: DEEPSEEK_LOGIN_URL,
    provider: 'deepseek',
    authPagePaths: ['/sign_in'],
  });

  // If manualBrowserLogin returned cookie-based token, try to extract the actual Bearer token
  if (state && state.token) {
    try {
      var { setupBrowserContext } = await import('./browserProfiles.ts');
      var context = await setupBrowserContext(email, false);
      var page = context.pages()[0] || (await context.newPage());

      try {
        await page.goto(DEEPSEEK_CHAT_URL, { waitUntil: 'networkidle', timeout: 15000 });
        var token = await extractDeepSeekToken(page);
        if (token) {
          await context.close().catch(function () {});
          return {
            token: token,
            expiresAt: state.expiresAt,
            refreshToken: null,
            lastLoginAttempt: Date.now(),
          };
        }
      } finally {
        await context.close().catch(function () {});
      }
    } catch {
      // Return the original state if we can't extract the Bearer token
    }
  }

  return state;
}
