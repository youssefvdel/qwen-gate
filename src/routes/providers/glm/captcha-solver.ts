/*
 * File: providers/glm/captcha-solver.ts
 * Aliyun Captcha V3 solver using Playwright headless Chrome.
 *
 * Loads the AliyunCaptcha.js SDK into a headless Chromium page with stealth
 * mitigations, then calls startTracelessVerification() to obtain a
 * captcha_verify_param. Tokens are cached for 45 seconds.
 *
 * The browser instance is reused across solves (launched once).
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, chromium } from 'playwright-core';
import { logStore } from '../../../services/logStore.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ALIYUN_SDK = readFileSync(resolve(__dirname, 'AliyunCaptcha.js.txt'), 'utf-8');

const TOKEN_TTL_MS = 45_000;
const SOLVE_RETRIES = 3;
const SOLVE_TIMEOUT_MS = 40_000;
const SDK_LOAD_TIMEOUT_MS = 20_000;

// z.ai Aliyun Captcha config (from window.AliyunCaptchaConfig on the page)
const CAPTCHA_CONFIG = {
  region: 'sgp',
  prefix: 'no8xfe',
  sceneId: 'didk33e0',
};

const LAUNCH_ARGS = [
  '--headless=new',
  '--no-sandbox',
  '--disable-blink-features=AutomationControlled',
  '--disable-features=ChromeWhatsNewUI',
  '--no-first-run',
  '--no-default-browser-check',
];

const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

const STEALTH_INIT_SCRIPT = `
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
window.chrome = { runtime: {}, loadTimes: () => ({}), csi: () => ({}), app: {} };
Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0 });
`;

interface CaptchaToken {
  verifyParam: string;
  expiresAt: number;
}

let browserPromise: Promise<Browser> | null = null;
let cachedToken: CaptchaToken | null = null;

async function getBrowser(): Promise<Browser> {
  if (browserPromise) {
    try {
      const b = await browserPromise;
      if (b.isConnected()) return b;
    } catch {
      // previous launch failed — retry
    }
  }
  browserPromise = chromium.launch({
    headless: true,
    args: LAUNCH_ARGS,
  });
  return browserPromise;
}

/** Returns a fresh captcha_verify_param for the GLM API. Cached for 45s. */
export async function getCaptchaVerifyParam(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.verifyParam;
  }

  const verifyParam = await solveWithRetry();
  cachedToken = { verifyParam, expiresAt: Date.now() + TOKEN_TTL_MS };
  return verifyParam;
}

/** Force-invalidate the cached token (call after a 403/FRONTEND_CAPTCHA error). */
export function invalidateCaptchaToken(): void {
  cachedToken = null;
}

async function solveWithRetry(): Promise<string> {
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= SOLVE_RETRIES; attempt++) {
    try {
      logStore.debug('glm-captcha', `solve attempt ${attempt}/${SOLVE_RETRIES}`);
      return await solveInBrowser();
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      logStore.debug('glm-captcha', `attempt ${attempt} failed: ${lastErr.message}`);
    }
  }
  throw new Error(`captcha solve failed after ${SOLVE_RETRIES} attempts: ${lastErr?.message ?? 'unknown'}`);
}

async function solveInBrowser(): Promise<string> {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1920, height: 947 },
    deviceScaleFactor: 1,
    locale: 'en-US',
    timezoneId: 'Africa/Cairo',
    colorScheme: 'light',
  });

  const page = await context.newPage();

  try {
    // Stealth init script
    await page.addInitScript(STEALTH_INIT_SCRIPT);

    // Serve the captcha page by intercepting chat.z.ai
    const html = buildPageHtml();
    await page.route('https://chat.z.ai/**', (route) => {
      const url = route.request().url();
      if (url === 'https://chat.z.ai/' || url === 'https://chat.z.ai') {
        route.fulfill({ status: 200, contentType: 'text/html', body: html });
      } else {
        route.continue();
      }
    });

    await page.goto('https://chat.z.ai/', { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Set captcha config after navigation
    await page.evaluate((cfg) => {
      (window as any).AliyunCaptchaConfig = { region: cfg.region, prefix: cfg.prefix };
    }, CAPTCHA_CONFIG);

    // Wait for SDK to load
    await page.waitForFunction(() => typeof (window as any).initAliyunCaptcha === 'function', { timeout: SDK_LOAD_TIMEOUT_MS });

    // Solve captcha
    const param = await page.evaluate(
      async (cfg) => {
        const w = window as any;
        return new Promise<string>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error(`Captcha solve timeout after ${cfg.timeout}ms`)), cfg.timeout);
          w.initAliyunCaptcha({
            SceneId: cfg.sceneId,
            mode: 'popup',
            region: cfg.region,
            prefix: cfg.prefix,
            language: 'en',
            element: '#captcha-element',
            button: '#captcha-button',
            captchaLogoImg: '',
            showErrorTip: false,
            success: (param: string) => {
              clearTimeout(timeout);
              resolve(param);
            },
            fail: (err: unknown) => {
              clearTimeout(timeout);
              reject(new Error('SDK fail: ' + JSON.stringify(err)));
            },
            getInstance: (inst: any) => {
              inst.startTracelessVerification();
            },
          });
        });
      },
      { ...CAPTCHA_CONFIG, timeout: SOLVE_TIMEOUT_MS },
    );

    logStore.debug('glm-captcha', 'captcha solved successfully');
    return param;
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

function buildPageHtml(): string {
  const safeSdk = ALIYUN_SDK.replace(/<\/script>/gi, '<\\/script>');
  return `<!DOCTYPE html><html><head></head><body>
<div id="captcha-element"></div>
<button id="captcha-button"></button>
<script>${safeSdk}</script>
</body></html>`;
}
