import { v4 as uuidv4 } from 'uuid';
import { getBasicHeaders } from './playwright.ts';

interface PoolEntry {
  chatId: string;
  parentId: string | null;
  inUse: boolean;
  cachedHeaders?: { cookie: string; userAgent: string };
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

  async acquire(): Promise<PoolEntry> {
    if (process.env.TEST_MOCK_PLAYWRIGHT) {
      const mockId = process.env.TEST_SESSION_ID || 'mock-session';
      return { chatId: mockId, parentId: null, inUse: true };
    }
    const [{ cookie, userAgent }, chatId] = await Promise.all([
      getBasicHeaders(),
      this.createSession()
    ]);
    const entry: PoolEntry = { chatId, parentId: null, inUse: true, cachedHeaders: { cookie, userAgent } };
    this.activeSessions.add(chatId);
    this.activeCount++;
    console.log(`[SessionPool] Fresh session: ${chatId.substring(0, 8)}...`);
    return entry;
  }

  release(chatId: string, _newParentId: string | null, cachedHeaders?: { cookie: string; userAgent: string }): void {
    const waiter = this.waiting.shift();
    if (waiter) {
      Promise.all([getBasicHeaders(), this.createSession()])
        .then(([{ cookie, userAgent }, id]) => {
          waiter({ chatId: id, parentId: _newParentId, inUse: true, cachedHeaders: { cookie, userAgent } });
        })
        .catch(err => {
          console.error('[SessionPool] Failed to create session for waiter:', err.message);
        });
    }
    this.activeSessions.delete(chatId);
    if (this.activeCount > 0) this.activeCount--;
    this.deleteSession(chatId, cachedHeaders);
  }

  async deleteSession(chatId: string, cachedHeaders?: { cookie: string; userAgent: string }): Promise<void> {
    if (process.env.TEST_MOCK_PLAYWRIGHT) return;
    if (process.env.DELETE_SESSION === 'false') {
      console.log(`[SessionPool] DELETE_SESSION=false, keeping ${chatId.substring(0, 8)}...`);
      return;
    }
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const { cookie, userAgent } = cachedHeaders || await getBasicHeaders();
      const response = await fetch(`https://chat.qwen.ai/api/v2/chats/${chatId}`, {
        method: 'DELETE',
        signal: controller.signal,
        headers: {
          'accept': 'application/json, text/plain, */*',
          'content-type': 'application/json',
          'cookie': cookie,
          'referer': 'https://chat.qwen.ai/',
          'user-agent': userAgent,
          'x-request-id': uuidv4(),
          'source': 'web',
        },
      });
      clearTimeout(timeout);
      if (response.ok) {
        console.log(`[SessionPool] Deleted session ${chatId.substring(0, 8)}...`);
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        console.warn(`[SessionPool] Delete timeout for ${chatId.substring(0, 8)}...`);
      } else {
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

  private async createSession(): Promise<string> {
    const { cookie, userAgent } = await getBasicHeaders();
    const response = await fetch('https://chat.qwen.ai/api/v2/chats/new', {
      method: 'POST',
      headers: {
        'accept': 'application/json, text/plain, */*',
        'content-type': 'application/json',
        'cookie': cookie,
        'referer': 'https://chat.qwen.ai/',
        'user-agent': userAgent,
        'x-request-id': uuidv4(),
        'source': 'web',
      },
      body: JSON.stringify({}),
    });
    if (!response.ok) {
      throw new Error(`Chats/new returned ${response.status}`);
    }
    const json = await response.json();
    if (!json.data?.id) {
      throw new Error(`Chats/new returned no id: ${JSON.stringify(json).substring(0, 100)}`);
    }
    return json.data.id;
  }
}

export const sessionPool = new SessionPool();
