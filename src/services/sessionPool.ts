import { v4 as uuidv4 } from 'uuid';
import { getQwenHeaders, getBasicHeaders } from './playwright.ts';

interface PoolEntry {
  chatId: string;
  parentId: string | null;
  inUse: boolean;
}

export class SessionPool {
  private sessions: PoolEntry[] = [];
  private poolSize: number;
  private waiting: Array<(entry: PoolEntry) => void> = [];
  private initialized = false;

  constructor(poolSize = 3) {
    this.poolSize = poolSize;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (process.env.TEST_MOCK_PLAYWRIGHT) {
      const mockId = process.env.TEST_SESSION_ID || 'mock-session';
      this.sessions.push({ chatId: mockId, parentId: null, inUse: false });
      this.initialized = true;
      console.log(`[SessionPool] Mock mode: using session ${mockId}`);
      return;
    }
    console.log(`[SessionPool] Initializing with ${this.poolSize} sessions...`);
    const errors: Error[] = [];
    for (let i = 0; i < this.poolSize; i++) {
      try {
        const chatId = await this.createSession();
        this.sessions.push({ chatId, parentId: null, inUse: false });
        console.log(`[SessionPool] Created session ${i + 1}/${this.poolSize}: ${chatId}`);
      } catch (err: any) {
        console.error(`[SessionPool] Failed to create session ${i + 1}: ${err.message}`);
        errors.push(err);
      }
    }
    if (this.sessions.length === 0) {
      throw new Error(`[SessionPool] Failed to create any sessions: ${errors.map(e => e.message).join('; ')}`);
    }
    this.initialized = true;
    if (this.sessions.length < this.poolSize) {
      console.warn(`[SessionPool] Only created ${this.sessions.length}/${this.poolSize} sessions`);
    }
  }

  async acquire(): Promise<PoolEntry> {
    if (!this.initialized && this.sessions.length === 0) {
      console.warn('[SessionPool] acquire() called but pool not initialized. Auto-initializing...');
      try {
        await this.initialize();
      } catch (err: any) {
        console.error('[SessionPool] Auto-init failed:', err.message);
        throw new Error(`Session pool unavailable: ${err.message}`);
      }
    }
    const available = this.sessions.find(s => !s.inUse);
    if (available) {
      available.inUse = true;
      return available;
    }
    return new Promise(resolve => {
      this.waiting.push(resolve);
    });
  }

  release(chatId: string, newParentId: string | null): void {
    const entry = this.sessions.find(s => s.chatId === chatId);
    if (!entry) return;
    entry.parentId = newParentId;
    entry.inUse = false;
    const waiter = this.waiting.shift();
    if (waiter) {
      entry.inUse = true;
      waiter(entry);
    }
  }

  async replenishOne(): Promise<void> {
    try {
      const chatId = await this.createSession();
      this.sessions.push({ chatId, parentId: null, inUse: false });
      console.log(`[SessionPool] Replenished session: ${chatId}`);
    } catch (err: any) {
      console.error(`[SessionPool] Replenish failed: ${err.message}`);
    }
  }

  getStats(): { total: number; available: number; inUse: number; waiting: number } {
    return {
      total: this.sessions.length,
      available: this.sessions.filter(s => !s.inUse).length,
      inUse: this.sessions.filter(s => s.inUse).length,
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

export const sessionPool = new SessionPool(3);
