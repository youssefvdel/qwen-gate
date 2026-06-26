/*
 * File: auth.ts
 * Core authentication: login, cookies, token management.
 * Account management is in accountManager.ts. Token refresh is in tokenRefresh.ts.
 * Login is in loginService.ts. Login helpers are in loginHelpers.ts.
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { Cookie } from 'playwright';
import type { AccountEntry, AuthState } from '../types/auth.ts';
import {
  accounts,
  decodeJwt,
  discoverSavedAccounts,
  enableHotReload as enableHotReloadImpl,
  getAccountByEmail,
  loadAccountsFromFile,
  migrateFromOldPaths,
  rebuildEmailIndex,
  resetWatcherState,
  saveAccountsToFile,
  setupAccountWatcher as setupAccountWatcherImpl,
} from './accountManager.ts';
import { config } from './configService.ts';
import { loginFresh } from './loginService.ts';
import { logStore } from './logStore.ts';
import { getActivePage, getBrowser } from './playwright.ts';
import { ensureAccountFresh, needsRefresh } from './tokenRefresh.ts';

export {
  addAccount,
  decodeJwt,
  decrementInFlight,
  discoverSavedAccounts,
  getAccountByEmail,
  getAccountCount,
  getAccountStats,
  getAccounts,
  getAllAccountEmails,
  getAvailableCount,
  getToken,
  getTokenWithAccount,
  hasInFlight,
  incrementInFlight,
  incrementTotalRequests,
  isAccountThrottled,
  isAvailable,
  pickAccount,
  rebuildEmailIndex,
  reloadAccounts,
  removeAccount,
  setAccountDisabled,
  throttleAccount,
} from './accountManager.ts';
export { ensureAccountFresh, needsRefresh, tryRefreshToken } from './tokenRefresh.ts';

export function getAuthTokenMaxAgeMs(): number {
  return config.getInt('AUTH_TOKEN_MAX_AGE_MS', 28800000);
}
export function getAuthRefreshBeforeMs(): number {
  return config.getInt('AUTH_REFRESH_BEFORE_MS', 300000);
}
const TOKEN_DIR = join(process.cwd(), '.qwen', 'tokens');

export async function checkPlaywrightSession(): Promise<boolean> {
  try {
    const page = getActivePage();
    if (!page) return false;
    const cookies = await page.context().cookies();
    return cookies.some((c) => c.name.toLowerCase().includes('token') || c.name.toLowerCase().includes('session'));
  } catch {
    return false;
  }
}

let initDone = false;

export async function initAuth(onAccountReady?: (email: string) => Promise<void>): Promise<void> {
  if (initDone) return;

  migrateFromOldPaths();

  const persisted = loadAccountsFromFile();
  const discovered = discoverSavedAccounts();

  // Merge persisted accounts (which may include throttledUntil and profileCookies) with discovered accounts
  const merged: Array<{ email: string; password: string; throttledUntil?: number; disabled?: boolean; profileCookies?: string; token?: string; refreshToken?: string | null; expiresAt?: number }> = [
    ...discovered,
  ];
  for (const p of persisted) {
    const existing = merged.find((a) => a.email.toLowerCase().trim() === p.email.toLowerCase().trim());
    if (existing) {
      if (p.password && !existing.password) {
        existing.password = p.password;
      }
      // Carry over throttledUntil from persisted data
      if (p.throttledUntil) {
        existing.throttledUntil = p.throttledUntil;
      }
      if (p.disabled !== undefined) {
        existing.disabled = p.disabled;
      }
      if (p.profileCookies) existing.profileCookies = p.profileCookies;
      if (p.token) {
        existing.token = p.token;
        existing.refreshToken = p.refreshToken;
        existing.expiresAt = p.expiresAt;
      }
    } else if (p.password) {
      merged.push(p);
    }
  }

  if (merged.length === 0) {
    initDone = true;
    logStore.log(
      'warn',
      'auth',
      'No saved accounts found. Use the dashboard at http://localhost:26405/dashboard/accounts to add accounts.',
    );
    return;
  }

  accounts.length = 0;
  for (const a of merged) {
    // Reset throttledUntil to 0 if it's in the past
    const persistedUntil = (a as any).throttledUntil || 0;
    accounts.push({
      email: a.email,
      password: a.password,
      state:
        a.token && a.expiresAt && a.expiresAt > Date.now()
          ? { token: a.token, expiresAt: a.expiresAt, refreshToken: a.refreshToken ?? null }
          : null,
      lastUsed: 0,
      throttledUntil: persistedUntil > Date.now() ? persistedUntil : 0,
      refreshInFlight: null,
      loginAttempt: 0,
      inFlight: 0,
      totalRequests: 0,
      profileCookies: a.profileCookies,
      disabled: (a as any).disabled ?? false,
      startupStatus: 'initializing',
    });
  }
  rebuildEmailIndex();

  try {
    // Phase 1: Load tokens from browser profiles — max 3 concurrent Chromium instances
    const MAX_CONCURRENT_PROFILE_LOADS = 3;
    const loadResults: Array<{ acct: (typeof accounts)[0]; source: string | null }> = [];

    for (let i = 0; i < accounts.length; i += MAX_CONCURRENT_PROFILE_LOADS) {
      const batch = accounts.slice(i, i + MAX_CONCURRENT_PROFILE_LOADS);
      const batchResults = await Promise.allSettled(
        batch.map(async (acct) => {
          // Already hydrated from persisted token (still valid) — skip the expensive,
          // lock-prone browser profile launch and the captcha-prone fresh login.
          if (acct.state?.token && acct.state.expiresAt > Date.now()) {
            return { acct, source: 'persisted' as const };
          }
          const profileState = await loadCookiesFromProfile(acct.email);
          if (profileState) {
            acct.state = profileState;
            return { acct, source: 'profile' as const };
          }
          return { acct, source: null as string | null };
        }),
      );
      for (const r of batchResults) {
        if (r.status === 'fulfilled') loadResults.push(r.value);
      }
    }

    // Phase 2: Login accounts that don't have tokens yet — max 3 concurrent
    const needLogin = accounts.filter((a) => !a.state?.token && a.password);
    if (needLogin.length > 0) {
      logStore.log('info', 'auth', `Logging in ${needLogin.length} accounts (max ${MAX_CONCURRENT_PROFILE_LOADS} concurrent)...`);
      for (let i = 0; i < needLogin.length; i += MAX_CONCURRENT_PROFILE_LOADS) {
        const batch = needLogin.slice(i, i + MAX_CONCURRENT_PROFILE_LOADS);
        await Promise.allSettled(
          batch.map(async (acct) => {
            const newState = await loginFresh(acct.email, acct.password);
            if (newState) {
              acct.state = newState;
              await saveCookies(acct.email, newState.token, newState.refreshToken, newState.expiresAt, newState.profileCookies);
            }
          }),
        );
      }
    }

    // Phase 3: Run post-login callbacks in parallel
    if (onAccountReady) {
      const readyPromises = accounts
        .filter((a) => a.state?.token)
        .map(async (acct) => {
          try {
            await onAccountReady(acct.email);
          } catch (err: any) {
            logStore.log('warn', 'auth', `Post-login config failed for ${acct.email}: ${err.message}`);
          }
        });
      await Promise.allSettled(readyPromises);
    }

    const successCount = accounts.filter((a) => a.state !== null && a.state.token).length;
    logStore.log('info', 'auth', successCount + '/' + accounts.length + ' accounts authenticated');

    setupAccountWatcherImpl();

    initDone = true;
  } catch (err) {
    initDone = false;
    throw err;
  }
}

export function setStartupStatus(email: string, status: 'initializing' | 'pending' | 'connecting' | 'ready'): void {
  const account = getAccountByEmail(email);
  if (account) account.startupStatus = status;
}

export async function loadCookiesFromProfile(email: string): Promise<AuthState | null> {
  let context: any = null;
  try {
    const { getProfileDir } = await import('./playwright.ts');
    const profileDir = getProfileDir(email);
    const acct = accounts.find((a) => a.email.toLowerCase().trim() === email.toLowerCase().trim());
    const password = acct?.password;

    // A profile directory is "real" if it was created by a prior browser launch
    // (Local State + Default/ are the reliable markers). cloakbrowser may not
    // materialize Default/Cookies until a session writes it, so checking only
    // for Cookies caused real profiles to be treated as missing -> a 180s
    // launchPersistentContext timeout storm on every cold boot.
    const hasProfile = existsSync(profileDir) && existsSync(join(profileDir, 'Local State'));
    if (!hasProfile) {
      logStore.log('warn', `auth`, `No profile dir for ${email} — creating via browser login...`);
      if (password) {
        const { openBrowserProfile } = await import('./browserProfiles.ts');
        let result = await openBrowserProfile(email, password, { headless: true });
        if (result === 'captcha') {
          logStore.log('info', 'auth', `Captcha for ${email} — opening headed browser for manual login...`);
          result = await openBrowserProfile(email, password, { headless: false });
        }
        if (result === 'success') {
          logStore.log('info', 'auth', `✓ Profile created for ${email} via browser login`);
          if (acct?.state) return acct.state;
        } else {
          logStore.log('warn', 'auth', `Profile creation failed for ${email}: ${result}`);
        }
      }
      return null;
    }

    logStore.log('info', 'auth', `Loading token from profile for ${email}...`);
    const { BROWSER_DEFAULT_ARGS } = await import('./playwright.ts');
    const { cleanupSingletonLock } = await import('./browserProfiles.ts');
    const { launchPersistentContext } = await import('cloakbrowser');
    const PROFILE_LAUNCH_TIMEOUT_MS = 30_000;
    // Stale Chrome singleton files (common on Windows after a hard kill) make
    // launchPersistentContext fail with EPERM -> null -> fresh login -> captcha.
    cleanupSingletonLock(profileDir);
    // Keep a handle on the launch promise so that if the timeout wins the race,
    // the eventually-resolved context is still closed instead of leaking a live
    // Chrome process. Leaked chromes pile up and exhaust resources, which makes
    // every subsequent launch time out too -> profile-load (and baxia harvest)
    // permanently breaks.
    const launchPromise = launchPersistentContext({
      userDataDir: profileDir,
      headless: true,
      args: [...BROWSER_DEFAULT_ARGS],
    });
    let launchTimedOut = false;
    // Reaper: if the timeout wins the race we abandon `launchPromise`, but it
    // will still resolve to a live Chrome later. Close it then, or it leaks.
    // Piled-up orphan chromes exhaust resources and make every later launch
    // time out too -> profile-load (and baxia harvest) permanently breaks.
    launchPromise
      .then((ctx: any) => {
        if (launchTimedOut) {
          try {
            ctx?.close?.();
          } catch {
            /* best effort */
          }
        }
      })
      .catch(() => {
        /* launch failed outright — nothing to reap */
      });
    context = await Promise.race([
      launchPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => {
          launchTimedOut = true;
          reject(new Error('Profile launch timed out after 30s'));
        }, PROFILE_LAUNCH_TIMEOUT_MS),
      ),
    ]);

    try {
      let cookies = await context.cookies();
      let authCookie = cookies.find((c: Cookie) => {
        const n = c.name.toLowerCase();
        if (n.includes('refresh')) return false;
        return n.includes('token') || n.includes('session');
      });

      // No auth cookie — authorize the profile via openBrowserProfile
      if (!authCookie?.value && password) {
        logStore.log('info', 'auth', `Authorizing profile for ${email}...`);
        try {
          await context.close();
          context = null;
        } catch {
          /* non-blocking */
        }

        const { openBrowserProfile } = await import('./browserProfiles.ts');
        let result = await openBrowserProfile(email, password, { headless: true });
        if (result === 'captcha') {
          logStore.log('info', 'auth', `Captcha for ${email} — opening headed browser for manual login...`);
          result = await openBrowserProfile(email, password, { headless: false });
        }

        if (result === 'success') {
          const updated = accounts.find((a) => a.email.toLowerCase().trim() === email.toLowerCase().trim());
          if (updated?.state) {
            logStore.log('info', 'auth', `✓ Authorized ${email} via browser profile`);
            return updated.state;
          }
          logStore.log('warn', 'auth', `Profile auth succeeded but no state for ${email}, letting caller retry`);
          return null;
        } else {
          logStore.log('warn', 'auth', `Profile authorization failed for ${email}: ${result}`);
          return null;
        }
      }

      // Save ALL cookies as profileCookies regardless of JWT health.
      // The baxia/WAF cookies (cna, ssxmod_itna, tfstk, isg) are independent
      // of the auth token—they bypass the WAF, not authenticate.
      try {
        const cookieStr = cookies
          .filter((c: Cookie) => c.name && c.value)
          .map((c: Cookie) => `${c.name}=${c.value}`)
          .join('; ');
        if (cookieStr && acct) {
          acct.profileCookies = cookieStr;
          const { saveAccountsToFile } = await import('./accountManager.ts');
          saveAccountsToFile(accounts);
          logStore.log('info', 'auth', `Saved ${cookies.length} cookies as profile for ${email.split('@')[0]}`);
        }
      } catch (fileErr: any) {
        logStore.log('debug', 'auth', `Profile cookie save failed: ${fileErr.message}`);
      }

      if (authCookie?.value) {
        const payload = decodeJwt(authCookie.value);
        const expiresAt = payload?.exp ? payload.exp * 1000 : Date.now() + getAuthTokenMaxAgeMs();
        if (expiresAt > Date.now()) {
          const refreshCookie = cookies.find((c: Cookie) => c.name.toLowerCase().includes('refresh'));
          const state: AuthState = {
            token: authCookie.value,
            expiresAt,
            refreshToken: refreshCookie?.value || null,
          };
          await saveCookies(email, state.token, state.refreshToken, state.expiresAt);

          logStore.log('info', 'auth', `✓ Token loaded from profile for ${email}`);
          return state;
        } else {
          logStore.log('warn', 'auth', `Token expired for ${email}`);
        }
      } else if (!authCookie?.value && password) {
        logStore.log('warn', 'auth', `No auth cookie found in profile for ${email}`);
      }
    } finally {
      if (context) {
        try {
          await context.close();
          context = null;
        } catch {
          /* non-blocking */
        }
      }
    }
  } catch (err: any) {
    if (err?.message?.toLowerCase().includes('lock')) {
      logStore.log('warn', 'auth', `Profile lock error for ${email}`);
    } else {
      logStore.log('warn', 'auth', `Profile cookie load failed for ${email}: ${err.message}`);
    }
    // Ensure context is cleaned up if timeout or error occurred before inner finally
    if (context) {
      try {
        await context.close();
      } catch {
        /* non-blocking */
      }
    }
  }
  return null;
}

export async function saveCookies(
  email: string,
  token: string,
  refreshToken?: string | null,
  expiresAt?: number,
  profileCookies?: string,
): Promise<void> {
  const normalizedEmail = email.toLowerCase().trim();
  try {
    // Prefer the real JWT exp over any caller-supplied expiresAt. Login/refresh paths
    // hardcode now+8h, which forces a captcha-prone re-login long before the token's real
    // expiry. The JWT's own exp is authoritative whenever it is decodable.
    let jwtExpiresAt: number;
    const payload = decodeJwt(token);
    if (payload?.exp && typeof payload.exp === 'number') {
      jwtExpiresAt = payload.exp * 1000;
    } else {
      jwtExpiresAt = expiresAt ?? Date.now() + getAuthTokenMaxAgeMs();
    }

    const acct = accounts.find((a) => a.email.toLowerCase().trim() === normalizedEmail);
    if (acct && token) {
      acct.state = {
        token,
        expiresAt: jwtExpiresAt,
        refreshToken: refreshToken || acct.state?.refreshToken || null,
      };
      // Persist baxia/WAF session cookies captured at login so chat requests
      // can merge them with token= (steady-state WAF-warm). Only overwrite
      // when the caller actually supplies a fresh set — never clobber existing
      // cookies with undefined and drop a known-good WAF session.
      if (profileCookies) acct.profileCookies = profileCookies;
      if (acct.throttledUntil > Date.now()) {
        acct.throttledUntil = 0;
      }

      // Persist token state to accounts.json so a restart reuses a still-valid token
      // instead of forcing a fresh (captcha-prone) login. profileCookies persist too.
      saveAccountsToFile(accounts);
    }
  } catch (err: any) {
    logStore.log('error', 'auth', `Failed to save cookies for ${normalizedEmail}: ${err.message}`);
  }
}

export function setupAccountWatcher(): void {
  setupAccountWatcherImpl();
}

export function enableHotReload(): void {
  enableHotReloadImpl();
}
