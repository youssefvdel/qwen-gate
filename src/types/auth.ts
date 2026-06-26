/*
 * File: auth.ts
 * Shared authentication types used across auth.ts, accountManager.ts, and playwright.ts.
 * Extracted to break circular dependency chains.
 */

export interface AuthState {
  token: string;
  expiresAt: number;
  refreshToken: string | null;
  /** Baxia/WAF session cookies (cna, ssxmod_itna, tfstk, isg, ...) captured
   *  from the login response set-cookie headers. When present, chat requests
   *  merge them with token= so steady-state traffic is WAF-warm, not cold. */
  profileCookies?: string;
}

export interface AccountEntry {
  email: string;
  password: string;
  state: AuthState | null;
  lastUsed: number;
  throttledUntil: number;
  refreshInFlight: Promise<boolean> | null;
  loginAttempt: number;
  inFlight: number;
  totalRequests: number;
  /** ms-epoch after which a hard-disabled (3x login-fail) account auto-rearms.
   *  Prevents a transient outage from permanently killing the account. */
  loginFailDisabledUntil?: number;
  /** Full cookie string from browser profile (cna, ssxmod_itna, tfstk, isg, token, etc.) for WAF bypass */
  profileCookies?: string;
  /** Startup lifecycle — 'pending' (added), 'initializing' (boot in progress), 'ready' (fully initialized) */
  startupStatus?: 'pending' | 'initializing' | 'connecting' | 'ready';
  /** If true, account is excluded from request routing */
  disabled?: boolean;
}
