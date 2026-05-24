import crypto from 'crypto';
import path from 'path';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { activePage } from './playwright.ts';

// ─── Login Mutex ────────────────────────────────────────────────────────────────
// Serialize browser-context logins: only one activePage, cookie clearing is global.
// Local implementation to avoid circular dependency with playwright.ts.
class LoginMutex {
  private queue: (() => void)[] = [];
  private locked = false;

  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return () => this.release();
    }
    return new Promise<() => void>(resolve => {
      this.queue.push(() => {
        resolve(() => this.release());
      });
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }
}

// ─── Playwright Session Check ───────────────────────────────────────────────────

/**
 * Check if Playwright has an active browser session with auth cookies.
 * Used as fallback when Qwen's REST signin API returns 200 but no token.
 */
async function checkPlaywrightSession(): Promise<boolean> {
  try {
    if (!activePage) return false;
    const cookies = await activePage.context().cookies();
    return cookies.some(c =>
      c.name.toLowerCase().includes('token') ||
      c.name.toLowerCase().includes('session')
    );
  } catch {
    return false;
  }
}

export interface AuthState {
  token: string;
  expiresAt: number;
  refreshToken: string | null;
}

export interface AccountEntry {
  email: string;
  password: string;
  state: AuthState | null;
  lastUsed: number;
  throttledUntil: number;
  refreshInFlight: Promise<boolean> | null;
  loginAttempt: number;
}

const AUTH_TOKEN_MAX_AGE_MS = parseInt(process.env.AUTH_TOKEN_MAX_AGE_MS || String(60 * 60 * 1000), 10);
const AUTH_REFRESH_BEFORE_MS = parseInt(process.env.AUTH_REFRESH_BEFORE_MS || String(5 * 60 * 1000), 10);
const DEFAULT_THROTTLE_MS = parseInt(process.env.RATE_LIMIT_COOLDOWN_MS || String(120_000), 10);

let accounts: AccountEntry[] = [];
let roundRobinIndex = 0;
let initDone = false;

function discoverSavedAccounts(): Array<{ email: string; password: string }> {
  try {
    if (!existsSync(COOKIE_DIR)) return [];
    const files = readdirSync(COOKIE_DIR).filter((f: string) => f.endsWith('.json'));
    const accounts: Array<{ email: string; password: string }> = [];
    for (const file of files) {
      try {
        const data: SavedAccountData = JSON.parse(readFileSync(path.join(COOKIE_DIR, file), 'utf-8'));
        if (data.email && data.token) {
          accounts.push({ email: data.email, password: '' });
        }
      } catch {}
    }
    return accounts;
  } catch {
    return [];
  }
}

// ─── Account Selection ──────────────────────────────────────────────────────────

function isAvailable(acct: AccountEntry): boolean {
  if (!acct.state) return false;
  if (acct.throttledUntil > Date.now()) return false;
  return true;
}

function needsRefresh(acct: AccountEntry): boolean {
  if (!acct.state) return true;
  return acct.state.expiresAt - AUTH_REFRESH_BEFORE_MS < Date.now();
}

/**
 * Pick the best available account: round-robin among non-throttled accounts,
 * preferring the least recently used. Returns null if all are throttled.
 */
export function pickAccount(): AccountEntry | null {
  const available = accounts.filter(isAvailable);
  if (available.length === 0) {
    // All throttled — pick the one with shortest remaining cooldown
    if (accounts.length === 0) return null;
    const now = Date.now();
    let best: AccountEntry | null = null;
    for (const acct of accounts) {
      if (acct.state) {
        if (!best || acct.throttledUntil < best.throttledUntil) best = acct;
      }
    }
    return best;
  }

  // Sort by lastUsed ascending (least recently used first), then round-robin
  available.sort((a, b) => a.lastUsed - b.lastUsed);
  
  // Pick from available using round-robin index
  const idx = roundRobinIndex % available.length;
  roundRobinIndex = (roundRobinIndex + 1) % Math.max(available.length, 1);
  return available[idx];
}

/**
 * Get a specific account by email.
 */
export function getAccountByEmail(email: string): AccountEntry | null {
  return accounts.find(a => a.email === email) || null;
}

// ─── Token Access ───────────────────────────────────────────────────────────────

/**
 * Get token from the best available account. Backward-compatible.
 */
export function getToken(): string | null {
  const acct = pickAccount();
  return acct?.state?.token || null;
}

/**
 * Get token and email for a specific account (or best available).
 * Call this when you need to track which account was used.
 */
export function getTokenWithAccount(email?: string): { token: string; email: string } | null {
  let acct: AccountEntry | null;
  if (email) {
    acct = getAccountByEmail(email);
    if (acct && !isAvailable(acct) && acct.state) {
      // Account exists but throttled — still return it (caller knows what they're doing)
    }
  } else {
    acct = pickAccount();
  }
  if (!acct?.state?.token) return null;
  acct.lastUsed = Date.now();
  return { token: acct.state.token, email: acct.email };
}

/**
 * Mark an account as throttled (rate-limited). It won't be selected for `durationMs`.
 */
export function throttleAccount(email: string, durationMs?: number): void {
  const acct = getAccountByEmail(email);
  if (!acct) return;
  const cooldown = durationMs || DEFAULT_THROTTLE_MS;
  acct.throttledUntil = Date.now() + cooldown;
  const remaining = Math.ceil(cooldown / 1000);
  console.warn(`[Auth] Throttled ${email} for ${remaining}s`);
}

/**
 * Check if a specific account is throttled.
 */
export function isAccountThrottled(email: string): boolean {
  const acct = getAccountByEmail(email);
  if (!acct) return true;
  return acct.throttledUntil > Date.now();
}

// ─── Token Refresh ──────────────────────────────────────────────────────────────

async function tryRefreshToken(acct: AccountEntry): Promise<boolean> {
  if (!acct.state?.refreshToken) return false;

  try {
    const response = await fetch('https://chat.qwen.ai/api/v2/auths/refresh', {
      method: 'POST',
      headers: {
        'accept': 'application/json, text/plain, */*',
        'content-type': 'application/json',
        'source': 'web',
        'x-request-id': crypto.randomUUID(),
      },
      body: JSON.stringify({ refresh_token: acct.state.refreshToken }),
    });

    if (response.ok) {
      const data = await response.json();
      if (data.data?.token) {
        acct.state = {
          token: data.data.token,
          expiresAt: Date.now() + AUTH_TOKEN_MAX_AGE_MS,
          refreshToken: data.data.refresh_token || acct.state.refreshToken,
        };
        console.log(`[Auth] Token refreshed for ${acct.email}`);
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

async function ensureAccountFresh(acct: AccountEntry): Promise<boolean> {
  if (acct.state && !needsRefresh(acct)) return true;

  // Avoid concurrent refresh for same account
  if (acct.refreshInFlight) {
    return acct.refreshInFlight;
  }

  acct.refreshInFlight = (async () => {
    try {
      // Try refresh token first
      if (acct.state?.refreshToken) {
        console.log(`[Auth] Refreshing token for ${acct.email}...`);
        if (await tryRefreshToken(acct)) return true;
        console.warn(`[Auth] Refresh failed for ${acct.email}, re-logging in...`);
      }

      // Fresh login
      const newState = await loginFresh(acct.email, acct.password);
      if (newState) {
        acct.state = newState;
        return true;
      }
      return false;
    } finally {
      acct.refreshInFlight = null;
    }
  })();

  return acct.refreshInFlight;
}

// ─── Login ──────────────────────────────────────────────────────────────────────

// Lock to serialize browser-context logins (only one activePage, cookie clearing is global)
const loginMutex = new LoginMutex();

/**
 * Login via browser context — executes signin API inside the browser via evaluate().
 * This gives proper anti-bot/WAF headers and lets the browser capture Set-Cookie automatically.
 * After the call, we extract the token from both the response data and browser cookies.
 */
async function loginFreshViaBrowser(email: string, hashedPassword: string): Promise<AuthState | null> {
  const release = await loginMutex.acquire();
  try {
    if (!activePage) return null;

    // Ensure page is on the right origin for proper CORS/cookie handling
    try {
      const currentUrl = activePage.url();
      if (!currentUrl.startsWith('https://chat.qwen.ai')) {
        await activePage.goto('https://chat.qwen.ai', { waitUntil: 'domcontentloaded' });
      }
    } catch (err: any) {
      console.warn(`[Auth] Navigation check failed for ${email}: ${err.message}`);
    }

    // Clear existing auth cookies for a clean slate (this is global to the browser context)
    try {
      const context = activePage.context();
      const existingCookies = await context.cookies();
      const authCookies = existingCookies.filter(c =>
        c.name === 'token' ||
        c.name === 'refresh_token' ||
        c.name.toLowerCase().includes('session') ||
        c.name.toLowerCase().includes('token')
      );
      if (authCookies.length > 0) {
        // clearCookies with specific domains — Playwright API: clearCookies(urls?)
        await context.clearCookies();
      }
    } catch (err: any) {
      console.warn(`[Auth] Cookie clearing failed for ${email}: ${err.message}`);
    }

    // Execute signin API call inside the browser context
    let evalResult: { ok: boolean; status: number; token: string | null; refreshToken: string | null; dataKeys: string[] };
    try {
      evalResult = await activePage.evaluate(async ({ email, hashedPassword }: { email: string; hashedPassword: string }) => {
        const response = await fetch('https://chat.qwen.ai/api/v2/auths/signin', {
          method: 'POST',
          headers: {
            'accept': 'application/json, text/plain, */*',
            'content-type': 'application/json',
            'source': 'web',
            'timezone': Intl.DateTimeFormat().resolvedOptions().timeZone,
            'x-request-id': crypto.randomUUID(),
          },
          credentials: 'include',
          body: JSON.stringify({ email, password: hashedPassword, login_type: 'email' }),
        });

        let data: any = {};
        try { data = await response.json(); } catch {}

        const token = data?.data?.token || data?.token || data?.data?.session_token || null;
        const refreshToken = data?.data?.refresh_token || data?.refresh_token || null;

        return {
          ok: response.ok,
          status: response.status,
          token: token as string | null,
          refreshToken: refreshToken as string | null,
          dataKeys: Object.keys(data),
        };
      }, { email, hashedPassword });
    } catch (err: any) {
      console.error(`[Auth] Browser evaluate failed for ${email}: ${err.message}`);
      return null;
    }

    if (!evalResult.ok) {
      console.error(`[Auth] Login failed for ${email} (${evalResult.status})`);
      return null;
    }

    // Extract token from browser cookies (the browser auto-captured Set-Cookie headers)
    let cookieToken: string | null = null;
    let cookieRefresh: string | null = null;
    try {
      const cookies = await activePage.context().cookies();
      const tokenCookie = cookies.find(c =>
        c.name === 'token' ||
        (c.name.toLowerCase().includes('token') && c.domain.includes('qwen') && !c.name.toLowerCase().includes('refresh'))
      );
      const refreshCookie = cookies.find(c =>
        c.name === 'refresh_token' ||
        (c.name.toLowerCase().includes('refresh') && c.domain.includes('qwen'))
      );
      cookieToken = tokenCookie?.value || null;
      cookieRefresh = refreshCookie?.value || null;
    } catch (err: any) {
      console.warn(`[Auth] Cookie read failed for ${email}: ${err.message}`);
    }

    // Prefer token from response body, fallback to cookie
    const finalToken = evalResult.token || cookieToken;
    const finalRefresh = evalResult.refreshToken || cookieRefresh;

    if (finalToken) {
      const state: AuthState = {
        token: finalToken,
        expiresAt: Date.now() + AUTH_TOKEN_MAX_AGE_MS,
        refreshToken: finalRefresh,
      };
      console.log(`[Auth] Login successful for ${email} (token from ${evalResult.token ? 'response' : 'cookie'})`);
      return state;
    }

    console.warn(
      `[Auth] Login returned 200 for ${email} but no token found. ` +
      `Response keys: [${evalResult.dataKeys.join(', ')}]. ` +
      `No auth cookies captured.`
    );
    return null;
  } finally {
    release();
  }
}

/**
 * Login via plain fetch — fallback for when Playwright is not available (test mode).
 */
async function loginFreshViaFetch(email: string, hashedPassword: string): Promise<AuthState | null> {
  try {
    const response = await fetch('https://chat.qwen.ai/api/v2/auths/signin', {
      method: 'POST',
      headers: {
        'accept': 'application/json, text/plain, */*',
        'content-type': 'application/json',
        'source': 'web',
        'timezone': Intl.DateTimeFormat().resolvedOptions().timeZone,
        'x-request-id': crypto.randomUUID(),
      },
      body: JSON.stringify({ email, password: hashedPassword, login_type: 'email' }),
    });

    if (response.ok) {
      let data: any;
      try { data = await response.json(); } catch { data = {}; }

      let token = data.data?.token || data.token || data.data?.session_token || null;
      let refreshToken = data.data?.refresh_token || data.refresh_token || null;

      if (!token) {
        const setCookie = response.headers.get('set-cookie') || '';
        const match = setCookie.match(/token=([^;]+)/);
        if (match) token = match[1];
      }

      if (token) {
        const state: AuthState = {
          token,
          expiresAt: Date.now() + AUTH_TOKEN_MAX_AGE_MS,
          refreshToken,
        };
        console.log(`[Auth] Login successful for ${email}`);
        return state;
      }

      // In fetch fallback mode, check Playwright session as last resort
      const hasPlaywrightSession = await checkPlaywrightSession();
      if (hasPlaywrightSession) {
        console.log(`[Auth] ${email}: API returned no token but Playwright session is valid (cookie-based auth)`);
        return {
          token: '',
          expiresAt: Date.now() + AUTH_TOKEN_MAX_AGE_MS,
          refreshToken: null,
        };
      }

      console.warn(`[Auth] API login returned 200 but no token for ${email}:`, JSON.stringify(data).substring(0, 200));
    } else {
      const errText = await response.text();
      console.error(`[Auth] Login failed for ${email} (${response.status}): ${errText.substring(0, 200)}`);
    }
  } catch (err: any) {
    console.error(`[Auth] Login error for ${email}: ${err.message}`);
  }

  return null;
}

/**
 * Login an account — uses browser-context API calls when Playwright is active,
 * falls back to plain fetch for test/no-browser mode.
 */
async function loginFresh(email: string, password: string): Promise<AuthState | null> {
  const hashedPassword = crypto.createHash('sha256').update(password).digest('hex');
  console.log(`[Auth] Logging in as ${email}...`);

  // Browser path: use activePage.evaluate() for proper WAF headers + cookie capture
  if (activePage && !process.env.TEST_MOCK_PLAYWRIGHT) {
    const browserResult = await loginFreshViaBrowser(email, hashedPassword);
    if (browserResult) return browserResult;
    // If browser login failed (e.g., page crashed), fall through to fetch
    console.warn(`[Auth] Browser login failed for ${email}, trying fetch fallback...`);
  }

  // Fetch fallback: for test mode or when browser path fails
  return loginFreshViaFetch(email, hashedPassword);
}

// ─── Initialization ─────────────────────────────────────────────────────────────

export async function initAuth(): Promise<void> {
  if (initDone) return;
  initDone = true;

  const saved = discoverSavedAccounts();
  if (saved.length === 0) {
    console.warn('[Auth] No saved accounts found. Run: npm run login user@example.com');
    return;
  }

  console.log(`[Auth] Initializing ${saved.length} account(s)...`);

  accounts = saved.map((a: { email: string; password: string }) => ({
    email: a.email,
    password: a.password,
    state: null,
    lastUsed: 0,
    throttledUntil: 0,
    refreshInFlight: null,
    loginAttempt: 0,
  }));

  // Login all accounts sequentially with delays between them.
  // Sequential is required because:
  // 1. Browser-context login uses shared activePage + global cookie jar
  // 2. Parallel requests trigger Qwen's WAF/anti-bot protection
  for (let i = 0; i < accounts.length; i++) {
    const acct = accounts[i];

    // First try: load saved token from manual npm run login
    const savedState = await loadSavedCookies(acct.email);
    if (savedState) {
      acct.state = savedState;
      console.log(`[Auth] ✓ ${acct.email}`);
    }

    // Delay between accounts to avoid rate limiting (skip after last)
    if (i < accounts.length - 1) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  // Report results
  const successCount = accounts.filter(a => a.state !== null && a.state.token).length;
  console.log(`[Auth] ${successCount}/${accounts.length} account(s) authenticated successfully.`);
  
  for (const acct of accounts) {
    const status = acct.state?.token ? '✓' : '✗';
    console.log(`[Auth]   ${status} ${acct.email}`);
  }
}

/**
 * Ensure all accounts have valid tokens. Called periodically or before requests.
 */
export async function ensureAllFresh(): Promise<void> {
  const stale = accounts.filter(a => a.state && needsRefresh(a));
  if (stale.length === 0) return;
  await Promise.allSettled(stale.map(a => ensureAccountFresh(a)));
}

// ─── Stats ──────────────────────────────────────────────────────────────────────

export function getAccountStats(): Array<{
  email: string;
  authenticated: boolean;
  throttled: boolean;
  throttledRemainingMs: number;
  tokenExpiresInMs: number;
  lastUsedAgoMs: number;
}> {
  const now = Date.now();
  return accounts.map(a => ({
    email: a.email,
    authenticated: a.state !== null,
    throttled: a.throttledUntil > now,
    throttledRemainingMs: Math.max(0, a.throttledUntil - now),
    tokenExpiresInMs: a.state ? Math.max(0, a.state.expiresAt - now) : 0,
    lastUsedAgoMs: a.lastUsed ? now - a.lastUsed : -1,
  }));
}

export function getAccountCount(): number {
  return accounts.length;
}

export function getAvailableCount(): number {
  return accounts.filter(isAvailable).length;
}

export function getAllAccountEmails(): string[] {
  return accounts.map(a => a.email);
}

// ─── Per-Account Cookie Store ───────────────────────────────────────────

const COOKIE_DIR = 'qwen_profile/cookies';

function getCookieFilePath(email: string): string {
  const hash = crypto.createHash('md5').update(email.toLowerCase().trim()).digest('hex');
  return path.join(COOKIE_DIR, `${hash}.json`);
}

interface SavedAccountData {
  email: string;
  token: string;
  refreshToken: string | null;
  savedAt: number;
  expiresAt: number;
}

/**
 * Load saved token for an account from disk. Called by initAuth.
 * Returns AuthState if a valid, non-expired token was found, null otherwise.
 */
export async function loadSavedCookies(email: string): Promise<AuthState | null> {
  try {
    const filePath = getCookieFilePath(email);
    if (!existsSync(filePath)) return null;

    const raw = readFileSync(filePath, 'utf-8');
    const data: SavedAccountData = JSON.parse(raw);

    if (!data.token || data.email.toLowerCase() !== email.toLowerCase()) return null;

    if (data.expiresAt < Date.now()) {
      console.log(`[Auth] Saved token for ${email} expired, will try refresh/login`);
      return null;
    }

    console.log(`[Auth] Loaded saved token for ${email} (expires in ${Math.round((data.expiresAt - Date.now()) / 60000)}min)`);
    return {
      token: data.token,
      expiresAt: data.expiresAt,
      refreshToken: data.refreshToken,
    };
  } catch (err: any) {
    console.warn(`[Auth] Failed to load saved cookies for ${email}: ${err.message}`);
    return null;
  }
}

/**
 * Save token for an account to disk. Called by login.ts after manual login.
 */
export async function saveCookies(email: string, token: string, refreshToken?: string | null, expiresAt?: number): Promise<void> {
  try {
    if (!existsSync(COOKIE_DIR)) mkdirSync(COOKIE_DIR, { recursive: true });

    const data: SavedAccountData = {
      email: email.toLowerCase().trim(),
      token,
      refreshToken: refreshToken || null,
      savedAt: Date.now(),
      expiresAt: expiresAt || (Date.now() + AUTH_TOKEN_MAX_AGE_MS),
    };

    writeFileSync(getCookieFilePath(email), JSON.stringify(data, null, 2), 'utf-8');
    console.log(`[Auth] Saved token for ${email}`);
  } catch (err: any) {
    console.error(`[Auth] Failed to save cookies for ${email}: ${err.message}`);
  }
}

// ─── Backward Compatibility ─────────────────────────────────────────────────────

export function clearAuth(): void {
  accounts = [];
  initDone = false;
}

export async function ensureAuthenticated(): Promise<boolean> {
  if (accounts.length === 0) {
    await initAuth();
  }
  await ensureAllFresh();
  return accounts.some(a => a.state !== null);
}
