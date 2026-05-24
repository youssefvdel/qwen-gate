import { v4 as uuidv4 } from 'uuid';
import { getBasicHeaders } from './playwright.ts';
import { pickAccount } from './auth.ts';
import { createNetworkEntry, recordResponse, completeEntry, errorEntry } from './networkDebug.ts';

interface PoolEntry {
  chatId: string;
  parentId: string | null;
  inUse: boolean;
  cachedHeaders?: { cookie: string; userAgent: string };
  /** Which account email this session is bound to */
  accountEmail?: string;
}

export class SessionPool {
  private waiting: Array<(entry: PoolEntry) => void> = [];
  private activeSessions = new Set<string>();
  private activeCount = 0;

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

    // If no email specified, pick the best account
    const resolvedEmail = email || pickAccount()?.email;

    const [{ cookie, userAgent, email: actualEmail }, chatId] = await Promise.all([
      getBasicHeaders(resolvedEmail),
      this.createSession(resolvedEmail)
    ]);
    const entry: PoolEntry = {
      chatId,
      parentId: null,
      inUse: true,
      cachedHeaders: { cookie, userAgent },
      accountEmail: actualEmail || resolvedEmail,
    };
    this.activeSessions.add(chatId);
    this.activeCount++;
    const emailLabel = entry.accountEmail ? ` (${entry.accountEmail.split('@')[0]})` : '';
    console.log(`[SessionPool] Fresh session: ${chatId.substring(0, 8)}...${emailLabel}`);
    return entry;
  }

  release(chatId: string, _newParentId: string | null, cachedHeaders?: { cookie: string; userAgent: string }, accountEmail?: string): void {
    const waiter = this.waiting.shift();
    if (waiter) {
      // Pick a fresh account for the waiter (may be different from the released one)
      const waiterEmail = accountEmail || pickAccount()?.email;
      Promise.all([getBasicHeaders(waiterEmail), this.createSession(waiterEmail)])
        .then(([{ cookie, userAgent, email: actualEmail }, id]) => {
          waiter({ chatId: id, parentId: _newParentId, inUse: true, cachedHeaders: { cookie, userAgent }, accountEmail: actualEmail || waiterEmail });
        })
        .catch(err => {
          console.error('[SessionPool] Failed to create session for waiter:', err.message);
        });
    }
    this.activeSessions.delete(chatId);
    if (this.activeCount > 0) this.activeCount--;
    this.deleteSession(chatId, cachedHeaders, accountEmail);
  }

  async deleteSession(chatId: string, cachedHeaders?: { cookie: string; userAgent: string }, accountEmail?: string): Promise<void> {
    if (process.env.TEST_MOCK_PLAYWRIGHT) return;
    if (process.env.DELETE_SESSION === 'false') {
      console.log(`[SessionPool] DELETE_SESSION=false, keeping ${chatId.substring(0, 8)}...`);
      return;
    }

    const { cookie, userAgent } = cachedHeaders || await getBasicHeaders(accountEmail);
    const requestId = uuidv4();
    const debugEntry = createNetworkEntry({
      url: `https://chat.qwen.ai/api/v2/chats/${chatId}`,
      method: 'DELETE',
      headers: { cookie, 'user-agent': userAgent, 'x-request-id': requestId },
      category: 'session-delete',
      accountEmail: accountEmail,
    });

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const response = await fetch(`https://chat.qwen.ai/api/v2/chats/${chatId}`, {
        method: 'DELETE',
        signal: controller.signal,
        headers: {
          'accept': 'application/json, text/plain, */*',
          'content-type': 'application/json',
          'cookie': cookie,
          'referer': 'https://chat.qwen.ai/',
          'user-agent': userAgent,
          'x-request-id': requestId,
          'source': 'web',
        },
      });
      clearTimeout(timeout);
      recordResponse(debugEntry.id, response);
      if (response.ok) {
        completeEntry(debugEntry.id);
        console.log(`[SessionPool] Deleted session ${chatId.substring(0, 8)}...`);
      } else {
        errorEntry(debugEntry.id, `Delete returned ${response.status}`);
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        errorEntry(debugEntry.id, 'Delete request aborted (timeout)');
        console.warn(`[SessionPool] Delete timeout for ${chatId.substring(0, 8)}...`);
      } else {
        errorEntry(debugEntry.id, err.message);
        console.warn(`[SessionPool] Delete failed for ${chatId.substring(0, 8)}...: ${err.message}`);
      }
    }
  }

  getStats(): { total: number; available: number; inUse: number; waiting: number } {
    return {
      total: this.activeSessions.size,
      available: this.activeSessions.size - this.activeCount,
      inUse: this.activeCount,
      waiting: this.waiting.length,
    };
  }

  private async createSession(email?: string): Promise<string> {
    const { cookie, userAgent } = await getBasicHeaders(email);
    const requestId = uuidv4();
    const debugEntry = createNetworkEntry({
      url: 'https://chat.qwen.ai/api/v2/chats/new',
      method: 'POST',
      headers: { cookie, 'user-agent': userAgent, 'x-request-id': requestId, source: 'web' },
      body: {},
      category: 'session-create',
      accountEmail: email,
    });

    let response: Response;
    try {
      response = await fetch('https://chat.qwen.ai/api/v2/chats/new', {
        method: 'POST',
        headers: {
          'accept': 'application/json, text/plain, */*',
          'content-type': 'application/json',
          'cookie': cookie,
          'referer': 'https://chat.qwen.ai/',
          'user-agent': userAgent,
          'x-request-id': requestId,
          'source': 'web',
        },
        body: JSON.stringify({}),
      });
      recordResponse(debugEntry.id, response);
    } catch (err) {
      errorEntry(debugEntry.id, err instanceof Error ? err.message : String(err));
      throw err;
    }

    if (!response.ok) {
      errorEntry(debugEntry.id, `Chats/new returned ${response.status}`);
      throw new Error(`Chats/new returned ${response.status}`);
    }
    const json = await response.json();
    if (!json.data?.id) {
      errorEntry(debugEntry.id, `Chats/new returned no id`);
      throw new Error(`Chats/new returned no id: ${JSON.stringify(json).substring(0, 100)}`);
    }
    completeEntry(debugEntry.id);
    return json.data.id;
  }
}

export const sessionPool = new SessionPool();
