/*
 * File: loginService.ts
 * Login orchestration — tries fetch first (fastest), falls back to browser strategies.
 * Extracted from auth.ts to break circular dependency between auth.ts and accountManager.ts.
 */

import crypto from 'node:crypto';
import type { AuthState } from '../types/auth.ts';
import { loginFreshViaBrowser, loginFreshViaFetch, loginViaTempContext } from './loginHelpers.ts';
import { recordLoginFailure, resetLoginAttempts } from './accountManager.ts';
import { logStore } from './logStore.ts';
import { getActivePage, getBrowser, Mutex } from './playwright.ts';

const loginMutex = new Mutex();

export async function loginFresh(email: string, password: string): Promise<AuthState | null> {
  const hashedPassword = crypto.createHash('sha256').update(password).digest('hex');

  // Try fetch first — it's the fastest (no browser overhead)
  if (!process.env.TEST_MOCK_PLAYWRIGHT) {
    const fetchResult = await loginFreshViaFetch(email, hashedPassword);
    if (fetchResult) {
      logStore.log('info', 'auth', 'Login success (fetch): ' + email);
      resetLoginAttempts(email);
      return fetchResult;
    }
  }

  // Fallback to browser strategies if fetch fails
  if (!process.env.TEST_MOCK_PLAYWRIGHT) {
    const activePage = getActivePage();
    if (activePage) {
      const browserResult = await loginFreshViaBrowser(email, hashedPassword, loginMutex);
      if (browserResult) {
        logStore.log('info', 'auth', 'Login success: ' + email);
        resetLoginAttempts(email);
        return browserResult;
      }
      logStore.log('warn', 'auth', `Browser login failed for ${email}, trying temp context...`);
    }

    const browser = getBrowser();
    if (browser) {
      const tempResult = await loginViaTempContext(browser, email, hashedPassword, loginMutex);
      if (tempResult) {
        logStore.log('info', 'auth', 'Login success (temp context): ' + email);
        resetLoginAttempts(email);
        return tempResult;
      }
      logStore.log('warn', 'auth', `Temp context login failed for ${email}`);
    }
  }

  logStore.log('error', 'auth', 'Login failed: ' + email);
  // Throttle + count so the pool stops re-picking a bad account every request
  // (otherwise N parallel requests each spawn a fresh signin -> captcha storm).
  recordLoginFailure(email);
  return null;
}
