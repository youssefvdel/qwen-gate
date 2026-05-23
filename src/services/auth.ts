import crypto from 'crypto';

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

// ─── Account Parsing ────────────────────────────────────────────────────────────

function parseAccounts(): Array<{ email: string; password: string }> {
  const accountsEnv = process.env.QWEN_ACCOUNTS;
  if (accountsEnv && accountsEnv.trim()) {
    const parsed = accountsEnv
      .split(',')
      .map(s => s.trim())
      .filter(s => s.includes(':'))
      .map(s => {
        const colonIdx = s.indexOf(':');
        return {
          email: s.substring(0, colonIdx).trim(),
          password: s.substring(colonIdx + 1).trim(),
        };
      })
      .filter(a => a.email && a.password);
    if (parsed.length > 0) return parsed;
  }

  // Fallback to single account
  const email = process.env.QWEN_EMAIL;
  const password = process.env.QWEN_PASSWORD;
  if (email && password) return [{ email, password }];
  return [];
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

async function loginFresh(email: string, password: string): Promise<AuthState | null> {
  const hashedPassword = crypto.createHash('sha256').update(password).digest('hex');
  console.log(`[Auth] Logging in as ${email}...`);

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

// ─── Initialization ─────────────────────────────────────────────────────────────

export async function initAuth(): Promise<void> {
  if (initDone) return;
  initDone = true;

  const parsed = parseAccounts();
  if (parsed.length === 0) {
    console.warn('[Auth] No accounts configured. Set QWEN_ACCOUNTS=email:pass,... or QWEN_EMAIL/QWEN_PASSWORD in .env');
    return;
  }

  console.log(`[Auth] Initializing ${parsed.length} account(s)...`);

  // Initialize account entries
  accounts = parsed.map(a => ({
    email: a.email,
    password: a.password,
    state: null,
    lastUsed: 0,
    throttledUntil: 0,
    refreshInFlight: null,
    loginAttempt: 0,
  }));

  // Login all accounts in parallel
  const results = await Promise.allSettled(
    accounts.map(async (acct) => {
      const state = await loginFresh(acct.email, acct.password);
      if (state) {
        acct.state = state;
      }
    })
  );

  // Report results
  const successCount = accounts.filter(a => a.state !== null).length;
  console.log(`[Auth] ${successCount}/${accounts.length} account(s) authenticated successfully.`);
  
  for (const acct of accounts) {
    const status = acct.state ? '✓' : '✗';
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
