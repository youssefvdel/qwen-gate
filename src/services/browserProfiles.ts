/*
 * File: browserProfiles.ts
 * Browser profile management extracted from playwright.ts.
 * Handles persistent browser profiles, auto-fill login, and token refresh via profiles.
 */

import { launchPersistentContext as cloakPersistentContext } from 'cloakbrowser';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { Cookie } from 'playwright';
import { projectPath } from '../utils/paths.ts';
import { logStore } from './logStore.ts';

export function getProfileDir(email: string): string {
  const safe = email
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]/g, '_');
  const dir = projectPath('.qwen', 'browser-profiles', safe);
  mkdirSync(dir, { recursive: true });
  // Set profile name to email so the Chrome window shows the account
  const prefsFile = `${dir}/Preferences`;
  const prefs: Record<string, any> = existsSync(prefsFile) ? JSON.parse(readFileSync(prefsFile, 'utf-8')) : {};
  prefs.profile = { ...prefs.profile, name: email };
  writeFileSync(prefsFile, JSON.stringify(prefs), 'utf-8');
  return dir;
}

/** Remove stale Chrome singleton files that block new instances from starting on this profile. */
export function cleanupSingletonLock(profileDir: string): void {
  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try {
      const f = join(profileDir, name);
      if (existsSync(f)) rmSync(f, { recursive: true });
    } catch {
      // best effort
    }
  }
}

export type LoginResult = 'success' | 'captcha' | 'closed' | 'error';

export interface BrowserProfileOptions {
  headless?: boolean;
}

import { validateQwenUrl } from './playwright.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const BROWSER_DEFAULT_ARGS: readonly string[] = ['--no-sandbox', '--disable-setuid-sandbox', '--ozone-platform-hint=auto'];

function getBrowserArgs(): string[] {
  return [...BROWSER_DEFAULT_ARGS];
}

async function setupBrowserContext(email: string, headless: boolean): Promise<any> {
  const profileDir = getProfileDir(email);
  cleanupSingletonLock(profileDir);
  return await cloakPersistentContext({
    userDataDir: profileDir,
    headless,
    humanize: true,
    geoip: true,
    viewport: { width: 1920, height: 1080 },
    args: getBrowserArgs(),
  });
}

async function checkExistingToken(context: any): Promise<boolean> {
  const existingCookies: Cookie[] = await context.cookies();
  const existingToken = existingCookies.find((c: Cookie) => c.name === 'token');
  if (!existingToken) return false;
  // expires <= 0 (e.g. -1) means a session cookie with no expiry -> treat as valid.
  // Only reject cookies with a real expiry already in the past.
  return existingToken.expires <= 0 || existingToken.expires * 1000 > Date.now();
}

async function fillLoginForm(page: any, email: string, password: string): Promise<void> {
  try {
    await page.waitForSelector('input[type="email"], input[placeholder*="Email"], input[name="email"], input[name="login"]', {
      timeout: 5000,
    });
    const emailInput = page.locator('input[type="email"], input[placeholder*="Email"], input[name="email"], input[name="login"]').first();
    await emailInput.click();
    await sleep(100 + Math.random() * 200);
    await emailInput.pressSequentially(email, { delay: 30 + Math.random() * 50 });

    await sleep(100 + Math.random() * 150);
    await page.waitForSelector('input[type="password"], input[name="password"]', { timeout: 3000 });
    const passwordInput = page.locator('input[type="password"], input[name="password"]').first();
    await passwordInput.click();
    await sleep(100 + Math.random() * 150);
    await passwordInput.pressSequentially(password, { delay: 25 + Math.random() * 40 });

    await sleep(200 + Math.random() * 300);
    try {
      const submitBtn = page
        .locator(
          'button[type="submit"], button:has-text("Sign in"), button:has-text("Login"), button:has-text("Log in"), button:has-text("Continue")',
        )
        .first();
      await submitBtn.click({ timeout: 3000 });
    } catch {
      logStore.log('warn', 'browser', 'submit button click failed for fillLoginForm');
    }
  } catch {
    logStore.log('warn', 'browser', 'form fill failed - selector not found for fillLoginForm');
  }
}

async function detectCaptcha(page: any): Promise<boolean> {
  return await page.evaluate(() => {
    return !!(
      document.querySelector('iframe[src*="recaptcha"]') ||
      document.querySelector('iframe[src*="captcha"]') ||
      document.querySelector('[class*="captcha"]') ||
      document.querySelector('[id*="captcha"]') ||
      document.querySelector('.captcha-container') ||
      document.querySelector('[data-sitekey]') ||
      document.querySelector('.g-recaptcha') ||
      Array.from(document.querySelectorAll('iframe')).some((f) => /challenge|verify|captcha|recaptcha/i.test(f.src || ''))
    );
  });
}

/** Build a `name=value; name=value` cookie string from a browser context's
 *  cookies, capturing the baxia/WAF session cookies (cna, ssxmod_itna, tfstk,
 *  isg, ...) alongside the token. These get persisted as profileCookies so
 *  browserless chat requests can merge them with token= and stay WAF-warm
 *  instead of going cold on every steady-state request. */
function buildProfileCookies(cookies: Cookie[]): string | undefined {
  const wafNames = /^(cna|ssxmod_itna|tfstk|isg|acw_tc|xlly_s|baxia|mtop|csgo)$/i;
  const pairs = cookies
    .filter((c) => c.value && (wafNames.test(c.name) || c.name === 'token' || c.name.toLowerCase().includes('refresh')))
    .map((c) => `${c.name}=${c.value}`);
  return pairs.length ? pairs.join('; ') : undefined;
}

async function tryCheckToken(context: any, email: string): Promise<LoginResult | null> {
  try {
    const cookies: Cookie[] = await context.cookies();
    const tokenCookie = cookies.find((c: Cookie) => c.name === 'token');
    if (!tokenCookie) return null;
    const { saveCookies } = await import('./auth.ts');
    const refreshCookie = cookies.find((c: Cookie) => c.name.toLowerCase().includes('refresh'));
    await saveCookies(email, tokenCookie.value, refreshCookie?.value, undefined, buildProfileCookies(cookies));
    try {
      await context.close();
    } catch {
      logStore.log('warn', 'browser', 'context.close failed in tryCheckToken success');
    }
    return 'success';
  } catch {
    try {
      await context.close();
    } catch {
      logStore.log('warn', 'browser', 'context.close failed in tryCheckToken error');
    }
    return 'closed';
  }
}

async function tryCheckCaptcha(page: any, context: any, attempt: number): Promise<'captcha' | null> {
  if (attempt <= 0 || attempt % 3 !== 0) return null;
  try {
    const hasCaptcha = await detectCaptcha(page);
    if (!hasCaptcha) return null;
    return 'captcha';
  } catch {
    logStore.log('warn', 'browser', 'captcha detection failed in tryCheckCaptcha');
  }
  return null;
}

async function pollForToken(page: any, context: any, email: string): Promise<LoginResult | null> {
  for (let attempt = 0; attempt < 20; attempt++) {
    await sleep(2000);

    const tokenResult = await tryCheckToken(context, email);
    if (tokenResult) return tokenResult;

    const captchaResult = await tryCheckCaptcha(page, context, attempt);
    if (captchaResult) return captchaResult;
  }
  return null;
}

export async function openBrowserProfile(email: string, password?: string, options?: BrowserProfileOptions): Promise<LoginResult> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return 'success' as LoginResult;

  const headless = options?.headless ?? false;
  let context: any = null;
  let page: any = null;

  try {
    logStore.log('info', 'browser', `Opening profile for ${email} (headless: ${headless})...`);
    context = await setupBrowserContext(email, headless);
    if (await checkExistingToken(context)) {
      logStore.log('info', 'browser', `Existing valid token found for ${email}`);
      await context.close();
      return 'success';
    }

    page = context.pages()[0] || (await context.newPage());

    logStore.log('info', 'browser', `Navigating to auth page for ${email}...`);
    validateQwenUrl('https://chat.qwen.ai/auth');
    await page.goto('https://chat.qwen.ai/auth', { waitUntil: 'domcontentloaded', timeout: 30_000 });

    if (password) {
      logStore.log('info', 'browser', `Filling login form for ${email}...`);
      await fillLoginForm(page, email, password);
    }

    logStore.log('info', 'browser', `Polling for token for ${email}...`);
    const result = await pollForToken(page, context, email);
    if (result) {
      logStore.log('info', 'browser', `✓ Login successful for ${email}`);
      return result;
    }

    logStore.log('error', 'browser', `Headless timeout — no login detected for ${email}, closing browser`);
    try {
      await context.close();
    } catch {
      logStore.log('warn', 'browser', `context.close failed after timeout for ${email}`);
    }
    return 'error';
  } catch (err: any) {
    logStore.log('error', 'browser', `Error for ${email}: ${err.message}`);
    if (context) {
      try {
        await context.close();
      } catch {
        logStore.log('warn', 'browser', `context.close failed in outer catch for ${email}`);
      }
    }
    return 'error';
  }
}

export async function refreshViaProfile(email: string): Promise<boolean> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return true;

  const profileDir = getProfileDir(email);
  let context: any = null;

  try {
    // Stale Chrome singleton files block the launch -> null -> fall through to
    // captcha-prone loginFresh. Clear them first (same as setupBrowserContext).
    cleanupSingletonLock(profileDir);
    context = await cloakPersistentContext({
      userDataDir: profileDir,
      headless: true,
      humanize: true,
      geoip: true,
      args: [...BROWSER_DEFAULT_ARGS],
    });

    const page = context.pages()[0] || (await context.newPage());
    validateQwenUrl('https://chat.qwen.ai');
    await page.goto('https://chat.qwen.ai', { waitUntil: 'domcontentloaded', timeout: 15000 });

    for (let attempt = 0; attempt < 10; attempt++) {
      await sleep(1500);
      const cookies: Cookie[] = await context.cookies();
      const tokenCookie = cookies.find((c: Cookie) => c.name === 'token');
      if (tokenCookie && tokenCookie.expires && tokenCookie.expires * 1000 > Date.now()) {
        const { saveCookies } = await import('./auth.ts');
        const refreshCookie = cookies.find((c: Cookie) => c.name.toLowerCase().includes('refresh'));
        await saveCookies(email, tokenCookie.value, refreshCookie?.value, undefined, buildProfileCookies(cookies));
        try {
          await context.close();
        } catch {
          logStore.log('warn', 'browser', `context.close failed after token save for ${email}`);
        }
        return true;
      }
    }

    logStore.log('error', 'browser', `No valid token found after profile navigation for ${email}`);
    try {
      await context.close();
    } catch {
      logStore.log('warn', 'browser', `context.close failed after navigation for ${email}`);
    }
    return false;
  } catch (err: any) {
    logStore.log('error', 'browser', `Profile refresh error for ${email}: ${err.message}`);
    if (context) {
      try {
        await context.close();
      } catch {
        logStore.log('warn', 'browser', `context.close failed in outer catch for ${email}`);
      }
    }
    return false;
  }
}
