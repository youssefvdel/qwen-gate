import crypto from 'node:crypto';
import { decrementInFlight, getAccountByEmail, getAllAccountEmails, incrementTotalRequests, pickAccount, throttleAccount } from './auth.ts';
import { browserlessFetch } from './browserlessFetch.ts';
import { config } from './configService.ts';
import { logStore } from './logStore.ts';
import { type BasicHeaders, getBasicHeaders } from './playwright.ts';
import { QWEN_API_BASE } from './qwen.ts';

interface PoolEntry {
  chatId: string;
  parentId: string | null;
  inUse: boolean;
  cachedHeaders?: { cookie: string; userAgent: string };
  /** Which account email this session is bound to */
  accountEmail?: string;
}

export function formatQwenEnvelopeError(json: any): string {
  const code = json?.data?.code || json?.code || 'unknown';
  const details = json?.data?.details || json?.details || json?.message || '';
  return details ? `${code}: ${details}` : String(code);
}

export class SessionPool {
  private activeSessions = new Set<string>();
  private activeCount = 0;
  private releaseTimers = new Map<string, ReturnType<typeof setTimeout>>();

  async initialize(): Promise<void> {
    if (process.env.TEST_MOCK_PLAYWRIGHT) {
      return;
    }
  }

  /**
   * Acquire a fresh session. If email is provided, use that specific account.
   * Otherwise, pick the best available account (round-robin, non-throttled).
   */
  async acquire(email?: string): Promise<PoolEntry> {
    if (process.env.TEST_MOCK_PLAYWRIGHT) {
      const mockId = process.env.TEST_SESSION_ID || 'mock-session';
      return { chatId: mockId, parentId: null, inUse: true, accountEmail: 'mock@test' };
    }

    const maxAttempts = email ? 1 : Math.max(1, getAllAccountEmails().length);
    let lastErr: unknown;
    const ACQUIRE_TIMEOUT = 30_000; // ponytail: overall timeout to prevent hanging session creation

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const resolvedEmail = email || (await pickAccount())?.email;

      try {
        // Fetch headers once, pass to createSessionWithHeaders (no duplicate getBasicHeaders call)
        const result = await Promise.race([
          (async () => {
            const headers = await getBasicHeaders(resolvedEmail);
            const chatId = await this.createSessionWithHeaders(resolvedEmail, headers);
            return { headers, chatId };
          })(),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`Session acquire timed out for ${resolvedEmail || '?'} after ${ACQUIRE_TIMEOUT}ms`)),
              ACQUIRE_TIMEOUT,
            ),
          ),
        ]);
        const { headers, chatId } = result;
        const entry: PoolEntry = {
          chatId,
          parentId: null,
          inUse: true,
          cachedHeaders: { cookie: headers.cookie, userAgent: headers.userAgent },
          accountEmail: headers.email || resolvedEmail,
        };
        this.activeSessions.add(chatId);
        this.activeCount++;
        logStore.log('info', 'pool', 'Session acquired' + (entry.accountEmail ? ': ' + entry.accountEmail.split('@')[0] : ''));
        return entry;
      } catch (err: any) {
        lastErr = err;
        if (resolvedEmail) {
          decrementInFlight(resolvedEmail);
          if (!email && /pending activation|Bad_Request|Chats\/new returned no id/i.test(err?.message || '')) {
            throttleAccount(resolvedEmail, 30 * 60 * 1000);
            logStore.log('warn', 'pool', `Skipping account ${resolvedEmail}: ${err.message}`);
            continue;
          }
        }
        throw err;
      }
    }

    throw lastErr instanceof Error ? lastErr : new Error('Failed to acquire session');
  }

  async release(
    chatId: string,
    _newParentId: string | null,
    cachedHeaders?: { cookie: string; userAgent: string },
    accountEmail?: string,
    isSuccess: boolean = true,
  ): Promise<void> {
    // Idempotency guard: if chatId not tracked as active, this session was already released.
    // Prevents double-release from competing cleanup paths (setTimeout + finally).
    if (!this.activeSessions.has(chatId)) {
      return;
    }

    // Track completed request — decrement in-flight, bump total count
    // Only count successful completions toward totalRequests
    if (accountEmail) {
      decrementInFlight(accountEmail);
      if (isSuccess) {
        incrementTotalRequests(accountEmail);
      }
    }

    this.activeSessions.delete(chatId);
    if (this.activeCount > 0) this.activeCount--;
    const existingTimer = this.releaseTimers.get(chatId);
    if (existingTimer) clearTimeout(existingTimer);
    const timer = setTimeout(() => {
      this.deleteSession(chatId, cachedHeaders, accountEmail);
      this.releaseTimers.delete(chatId);
    }, 0);
    if (typeof timer.unref === 'function') timer.unref();
    this.releaseTimers.set(chatId, timer);

    logStore.log('info', 'pool', 'Session released' + (accountEmail ? ': ' + accountEmail.split('@')[0] : ''));
  }

  async deleteSession(chatId: string, cachedHeaders?: { cookie: string; userAgent: string }, accountEmail?: string): Promise<void> {
    if (process.env.TEST_MOCK_PLAYWRIGHT) return;
    if (config.get('DELETE_SESSION', 'true') === 'false') return;

    // Ensure we have an email for browser context lookup
    let email = accountEmail;
    if (!email) {
      try {
        const headers = await getBasicHeaders();
        email = headers.email;
      } catch {
        console.error('[SessionPool] Failed to get email for session deletion');
        return;
      }
    }

    try {
      const tokenInfo = email ? await import('./auth.ts').then((m) => m.getTokenWithAccount(email!)) : null;
      const cookieStr = tokenInfo ? tokenInfo.cookie : '';
      const response = await browserlessFetch(`${QWEN_API_BASE}/api/v2/chats/${chatId}`, {
        method: 'DELETE',
        headers: {
          accept: 'application/json, text/plain, */*',
          source: 'web',
          cookie: cookieStr,
          origin: QWEN_API_BASE,
        },
        accountEmail: email,
      });
      if (!response.ok) {
        logStore.log('debug', 'pool', `[SessionPool] Delete returned ${response.status} for ${chatId.substring(0, 8)}...`);
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        logStore.log('debug', 'pool', `[SessionPool] Delete timeout for ${chatId.substring(0, 8)}...`);
      } else {
        logStore.log('debug', 'pool', `[SessionPool] Delete failed for ${chatId.substring(0, 8)}...: ${err.message}`);
      }
    }
  }

  getStats(): { total: number; available: number; inUse: number; waiting: number } {
    return {
      total: this.activeSessions.size,
      available: this.activeSessions.size - this.activeCount,
      inUse: this.activeCount,
      waiting: 0,
    };
  }

  /**
   * Create a session using pre-fetched headers (avoids duplicate getBasicHeaders call).
   */
  private async createSessionWithHeaders(email: string | undefined, headers: BasicHeaders): Promise<string> {
    const acct = email ? getAccountByEmail(email) : null;

    const sessionBody = JSON.stringify({
      title: 'New Chat',
      models: [acct?.state?.token ? 'qwen3.7-plus' : 'qwen3.5-flash'],
      chat_mode: 'normal',
      chat_type: 't2t',
      timestamp: Date.now(),
      project_id: '',
    });

    const tokenInfo = email ? await import('./auth.ts').then((m) => m.getTokenWithAccount(email!)) : null;
    const cookieStr = tokenInfo ? tokenInfo.cookie : '';

    const response = await browserlessFetch(`${QWEN_API_BASE}/api/v2/chats/new`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/plain, */*',
        source: 'web',
        cookie: cookieStr,
        origin: QWEN_API_BASE,
        referer: 'https://chat.qwen.ai/',
      },
      body: sessionBody,
      accountEmail: email,
    });

    if (!response.ok) {
      const bodySnippet = await response
        .text()
        .then((t) => t.substring(0, 200))
        .catch(() => 'unknown');
      logStore.log('warn', 'session', `Chats/new returned ${response.status}: ${bodySnippet.substring(0, 100)}`);
      throw new Error(`Chats/new returned ${response.status}`);
    }

    const responseText = await response.text();
    if (responseText.startsWith('<')) {
      logStore.log('warn', 'session', `Chats/new returned HTML instead of JSON (${responseText.substring(0, 80)}...) — baxia challenge`);
      throw new Error(`Chats/new blocked by WAF — cookies may be expired`);
    }
    let json: any;
    try {
      json = JSON.parse(responseText);
    } catch {
      logStore.log('warn', 'session', `Chats/new returned non-JSON: ${responseText.substring(0, 120)}`);
      throw new Error(`Chats/new returned non-JSON response`);
    }
    if (!json.data?.id) {
      const message = formatQwenEnvelopeError(json);
      throw new Error(`Chats/new returned no id: ${message}`);
    }

    return json.data.id;
  }

  /**
   * Convenience wrapper: fetches headers then delegates to createSessionWithHeaders.
   */
  private async createSession(email?: string): Promise<string> {
    const headers = await getBasicHeaders(email);
    return this.createSessionWithHeaders(email || '', headers);
  }
}

export const sessionPool = new SessionPool();
