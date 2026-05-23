import crypto from 'crypto';

export interface AuthState {
  token: string;
  expiresAt: number;
  refreshToken: string | null;
}

const AUTH_TOKEN_MAX_AGE_MS = parseInt(process.env.AUTH_TOKEN_MAX_AGE_MS || String(60 * 60 * 1000), 10);
const AUTH_REFRESH_BEFORE_MS = parseInt(process.env.AUTH_REFRESH_BEFORE_MS || String(5 * 60 * 1000), 10);

let authState: AuthState | null = null;
let refreshing = false;
let refreshPromise: Promise<boolean> | null = null;
let initDone = false;

export function needsRefresh(): boolean {
  if (!authState) return true;
  const now = Date.now();
  return authState.expiresAt - AUTH_REFRESH_BEFORE_MS < now;
}

export function getToken(): string | null {
  return authState?.token || null;
}

async function tryRefreshToken(): Promise<boolean> {
  if (!authState?.refreshToken) return false;

  try {
    const response = await fetch('https://chat.qwen.ai/api/v2/auths/refresh', {
      method: 'POST',
      headers: {
        'accept': 'application/json, text/plain, */*',
        'content-type': 'application/json',
        'source': 'web',
        'x-request-id': (typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Math.random().toString(36) + Date.now().toString(36)),
      },
      body: JSON.stringify({ refresh_token: authState.refreshToken }),
    });

    if (response.ok) {
      const data = await response.json();
      if (data.data?.token) {
        authState = {
          token: data.data.token,
          expiresAt: Date.now() + AUTH_TOKEN_MAX_AGE_MS,
          refreshToken: data.data.refresh_token || authState.refreshToken,
        };
        console.log('[Auth] Token refreshed successfully.');
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

async function loginFresh(): Promise<AuthState | null> {
  const email = process.env.QWEN_EMAIL;
  const password = process.env.QWEN_PASSWORD;

  if (!email || !password) {
    console.warn('[Auth] QWEN_EMAIL or QWEN_PASSWORD not set in .env');
    return null;
  }

  const hashedPassword = crypto.createHash('sha256').update(password).digest('hex');
  console.log(`[Auth] Logging in as ${email}...`);

  try {
    const response = await fetch('https://chat.qwen.ai/api/v2/auths/signin', {
      method: 'POST',
      headers: {
        'accept': 'application/json, text/plain, */*',
        'content-type': 'application/json',
        'source': 'web',
        'timezone': new Date().toString().split(' (')[0],
        'x-request-id': (typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Math.random().toString(36) + Date.now().toString(36)),
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
        console.log('[Auth] Login successful, token obtained.');
        return state;
      }

      console.warn('[Auth] API login returned 200 but no token:', JSON.stringify(data).substring(0, 200));
    } else {
      const errText = await response.text();
      console.error(`[Auth] Login failed (${response.status}): ${errText.substring(0, 200)}`);
    }
  } catch (err: any) {
    console.error(`[Auth] Login error: ${err.message}`);
  }

  return null;
}

export async function ensureAuthenticated(): Promise<boolean> {
  if (authState && !needsRefresh()) {
    return true;
  }

  if (refreshing) {
    if (refreshPromise) await refreshPromise;
    return authState !== null && !needsRefresh();
  }

  refreshing = true;
  refreshPromise = (async () => {
    try {
      if (authState?.refreshToken) {
        console.log('[Auth] Token expired, attempting refresh...');
        if (await tryRefreshToken()) {
          return true;
        }
        console.warn('[Auth] Refresh failed, re-logging in...');
      } else if (authState && !needsRefresh()) {
        return true;
      }
      const newState = await loginFresh();
      if (newState) {
        authState = newState;
        return true;
      }
      console.error('[Auth] All auth methods failed.');
      return false;
    } finally {
      refreshing = false;
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

export async function initAuth(): Promise<void> {
  if (initDone) return;
  initDone = true;
  await ensureAuthenticated();
}

export function clearAuth(): void {
  authState = null;
  initDone = false;
}