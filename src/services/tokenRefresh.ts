/*
 * File: tokenRefresh.ts
 * Token refresh logic extracted from auth.ts.
 * Handles refresh token exchange and ensuring accounts stay fresh.
 */

import type { AccountEntry } from '../types/auth.ts';
import { getAuthRefreshBeforeMs, getAuthTokenMaxAgeMs, saveCookies } from './auth.ts';
import { tokenExpiresAt } from './accountManager.ts';
import { browserlessFetch } from './browserlessFetch.ts';
import { loginFresh } from './loginService.ts';
import { logStore } from './logStore.ts';

export function needsRefresh(acct: AccountEntry): boolean {
  if (!acct.state) return true;
  return acct.state.expiresAt - getAuthRefreshBeforeMs() < Date.now();
}

const QWEN_CHAT_URL = 'https://chat.qwen.ai';

export async function tryRefreshToken(acct: AccountEntry): Promise<boolean> {
  if (!acct.state?.refreshToken) return false;

  try {
    const resp = await browserlessFetch(`${QWEN_CHAT_URL}/api/v2/auths/refresh`, {
      method: 'POST',
      body: JSON.stringify({ refresh_token: acct.state.refreshToken }),
    });

    if (!resp.ok) return false;

    const body = await resp.text();
    const data = JSON.parse(body);
    if (!data.data?.token) return false;

    acct.state = {
      token: data.data.token,
      expiresAt: tokenExpiresAt(data.data.token, getAuthTokenMaxAgeMs()),
      refreshToken: data.data.refresh_token || acct.state.refreshToken,
    };
    await saveCookies(acct.email, acct.state.token, acct.state.refreshToken, acct.state.expiresAt);
    if (acct.throttledUntil > Date.now()) {
      acct.throttledUntil = 0;
    }
    return true;
  } catch (err: any) {
    logStore.log('error', 'auth', 'HTTP fetch failed:', err);
    return false;
  }
}

export async function ensureAccountFresh(acct: AccountEntry): Promise<boolean> {
  if (acct.state && !needsRefresh(acct)) return true;

  // Avoid concurrent refresh for same account
  if (acct.refreshInFlight) {
    return acct.refreshInFlight;
  }

  acct.refreshInFlight = (async () => {
    try {
      if (acct.state?.refreshToken) {
        if (await tryRefreshToken(acct)) return true;
        logStore.log('warn', 'auth', `Refresh token failed for ${acct.email}`);
      }

      // Silent captcha-free refresh: re-launch the real browser profile (which
      // carries persisted baxia/WAF cookies) and let Qwen rotate the token cookie
      // on navigation. Avoids the captcha-prone plain-fetch signin below.
      try {
        const { refreshViaProfile } = await import('./browserProfiles.ts');
        if (await refreshViaProfile(acct.email)) {
          logStore.log('info', 'auth', `Token rotated via profile for ${acct.email} (no login)`);
          return true;
        }
      } catch (err: any) {
        logStore.log('warn', 'auth', `refreshViaProfile failed for ${acct.email}: ${err.message}`);
      }

      if (acct.throttledUntil > Date.now()) {
        const waitSec = Math.ceil((acct.throttledUntil - Date.now()) / 1000);
        logStore.log('warn', 'auth', `Skipping re-login for ${acct.email} — throttled for ${waitSec}s more`);
        return false;
      }

      const newState = await loginFresh(acct.email, acct.password);
      if (newState) {
        acct.state = newState;
        await saveCookies(acct.email, newState.token, newState.refreshToken, newState.expiresAt, newState.profileCookies);
        return true;
      }
      return false;
    } finally {
      acct.refreshInFlight = null;
    }
  })();

  return acct.refreshInFlight;
}
