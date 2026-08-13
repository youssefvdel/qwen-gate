/**
 * captchaSolver — interactive CAPTCHA solver.
 *
 * When Qwen flags an account with FAIL_SYS_USER_VALIDATE, we open a visible
 * Chromium window (headful, via cloakbrowser) using the account's persistent
 * browser profile — so all live cookies/token are already inside — and let the
 * human solve the CAPTCHA on screen. Once a fresh `token` cookie appears the
 * solver saves it via saveCookies() (which also clears the throttle) and
 * returns, so the upstream request can be retried on the same account.
 *
 * Solver is skipped entirely when the CAPTCHA_SOLVER config flag is not enabled.
 */

import { launchPersistentContext } from 'cloakbrowser';
import type { Cookie } from 'playwright';
import { getProfileDir, BROWSER_DEFAULT_ARGS } from './browserProfiles.ts';
import { logStore } from './logStore.ts';

export interface SolveCaptchaOptions {
  /** How long to wait for the human to solve the CAPTCHA before giving up. */
  timeoutMs?: number;
  /** Poll interval while waiting for a fresh token. */
  pollIntervalMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_MS = 2_500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Open a headful window on the account's persistent profile and wait until a
 * fresh (unexpired) `token` cookie shows up — i.e. the human solved the
 * CAPTCHA. Saves the new token via saveCookies() which also un-throttles.
 *
 * @returns true if a fresh token was found and saved, false on timeout/close.
 */
export async function solveCaptchaOnProfile(email: string, options?: SolveCaptchaOptions): Promise<boolean> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) {
    // Test hook: CAPTCHA_SOLVER_MOCK_RESULT forces a deterministic outcome.
    return process.env.CAPTCHA_SOLVER_MOCK_RESULT === 'true';
  }

  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = options?.pollIntervalMs ?? DEFAULT_POLL_MS;

  const profileDir = getProfileDir(email);
  let context: any = null;

  try {
    logStore.log('info', 'captcha', `[CaptchaSolver] Opening visible browser for ${email} — please solve the CAPTCHA on screen`);

    context = await launchPersistentContext({
      userDataDir: profileDir,
      headless: false,
      humanize: true,
      geoip: true,
      viewport: { width: 1600, height: 900 },
      args: [...BROWSER_DEFAULT_ARGS],
    });

    const page = context.pages()[0] || (await context.newPage());
    await page.goto('https://chat.qwen.ai', { waitUntil: 'domcontentloaded', timeout: 30_000 });

    const deadline = Date.now() + timeoutMs;
    let tokenCookie: Cookie | undefined;

    while (Date.now() < deadline) {
      // If the human closed the window, abort gracefully.
      if (!context || context._closed) {
        logStore.log('info', 'captcha', `[CaptchaSolver] ${email}: browser window closed by user, aborting`);
        return false;
      }

      const cookies: Cookie[] = await context.cookies().catch(() => []);
      tokenCookie = cookies.find((c: Cookie) => c.name === 'token');

      const isFresh = tokenCookie && tokenCookie.expires && tokenCookie.expires * 1000 > Date.now();
      if (isFresh && tokenCookie) {
        const { saveCookies } = await import('./auth.ts');
        const refreshCookie = cookies.find((c: Cookie) => c.name.toLowerCase().includes('refresh'));
        await saveCookies(email, tokenCookie.value, refreshCookie?.value);
        logStore.log('info', 'captcha', `[CaptchaSolver] ${email}: fresh token captured after CAPTCHA solve`);
        return true;
      }

      await sleep(pollMs);
    }

    logStore.log('warn', 'captcha', `[CaptchaSolver] ${email}: timed out after ${timeoutMs}ms — CAPTCHA not solved`);
    return false;
  } catch (err: any) {
    logStore.log('warn', 'captcha', `[CaptchaSolver] ${email}: error — ${err?.message ?? String(err)}`);
    return false;
  } finally {
    if (context && !context._closed) {
      try {
        await context.close();
      } catch {
        // best effort
      }
    }
  }
}
