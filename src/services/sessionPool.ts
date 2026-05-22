import { v4 as uuidv4 } from 'uuid';
import { getBasicHeaders } from './playwright.ts';

interface PoolEntry {
  chatId: string;
  parentId: string | null;
  inUse: boolean;
}

export class SessionPool {
  private waiting: Array<(entry: PoolEntry) => void> = [];

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
    const chatId = await this.createSession();
    const entry: PoolEntry = { chatId, parentId: null, inUse: true };
    console.log(`[SessionPool] Fresh session: ${chatId.substring(0, 8)}...`);
    return entry;
  }

  release(chatId: string, _newParentId: string | null): void {
    const waiter = this.waiting.shift();
    if (waiter) {
      this.createSession().then(id => {
        waiter({ chatId: id, parentId: _newParentId, inUse: true });
      });
    }
  }

  getStats(): { total: number; available: number; inUse: number; waiting: number } {
    return {
      total: 0,
      available: 0,
      inUse: 0,
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
