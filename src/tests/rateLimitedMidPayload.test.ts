/**
 * Deterministic regression tests for mid-payload RateLimited walls
 * (upstream HTTP 200 carrying {"success":false,data:{code:"RateLimited"}}).
 *
 * TEST1  non-streaming: wall on account A → rotate → account B answers
 * TEST2  non-streaming variant with SSE-framed wall body
 * TEST3  streaming: wall BEFORE useful content → retry on account B
 * TEST4  streaming: wall AFTER useful content → NO silent retry/duplicate,
 *        walled account gets throttled, stream finishes with the error
 */
process.env.TEST_MOCK_PLAYWRIGHT = 'true';
process.env.API_KEY = 'test-key-for-testing';

import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';

// Keep usage accounting off-disk during these tests (production .qwen/usage.json
// must stay untouched) while still being able to assert wall recordings.
const rateLimitedCalls: Array<[string, string | undefined, number | null | undefined]> = [];
mock.module('../services/usageTracker.ts', () => ({
  dayKeyFor: () => '',
  loadUsageStore: () => {},
  recordUsage: () => {},
  recordRateLimited: (email: string, model: string, waitHours: number) => {
    rateLimitedCalls.push([email, model, waitHours]);
  },
  pruneUsage: () => {},
  getUsage: () => ({}),
  getUsageSummary: () => ({ accounts: {}, days: [] }),
}));

const { app } = await import('../index.tsx');

import { readFileSync, writeFileSync } from 'node:fs';
import { accounts, rebuildEmailIndex } from '../services/accountManager.ts';
import { sessionPool } from '../services/sessionPool.ts';
import type { AccountEntry } from '../types/auth.ts';
import { projectPath } from '../utils/paths.ts';

// throttleAccount persists to .qwen/accounts.json — snapshot and restore the
// production file around every test so the suite never mutates live state.
const ACCOUNTS_FILE = projectPath('.qwen', 'accounts.json');
const accountsFileSnapshot = readFileSync(ACCOUNTS_FILE, 'utf-8');

const ACCOUNT_A = 'wall-a@test.dev';
const ACCOUNT_B = 'wall-b@test.dev';

const RATE_LIMITED_JSON = JSON.stringify({
  success: false,
  request_id: 'probe-req',
  data: {
    code: 'RateLimited',
    details: "You've reached the upper limit for today's usage.",
    template: 'You have reached the daily usage limit. Please wait {{num}} hours before trying again.',
    num: 4,
  },
});

function sse(lines: string[]): Response {
  const body = lines.map((l) => `data: ${l}\n\n`).join('');
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(body));
      c.close();
    },
  });
  return new Response(stream, { status: 200 });
}

function validAnswerSse(text: string): Response {
  return sse([
    JSON.stringify({ choices: [{ delta: { phase: 'answer', content: text } }] }),
    JSON.stringify({ choices: [{ delta: { phase: 'finished', status: 'finished' } }] }),
  ]);
}

const wallResponse = (): Response => new Response(RATE_LIMITED_JSON, { status: 200, headers: { 'Content-Type': 'application/json' } });

function seedAccounts(): void {
  for (const email of [ACCOUNT_A, ACCOUNT_B]) {
    accounts.push({
      email,
      password: 'test',
      state: { token: 'mock-token', expiresAt: Date.now() + 3600000, refreshToken: null },
      lastUsed: 0,
      throttledUntil: 0,
      refreshInFlight: null,
      loginAttempt: 0,
      inFlight: 0,
      totalRequests: 0,
      startupStatus: 'ready',
    } as unknown as AccountEntry);
  }
  rebuildEmailIndex(); // getAccountByEmail/throttleAccount resolve via the email index
}

function resetState(): void {
  accounts.length = 0;
  rateLimitedCalls.length = 0;
}

// Deterministic account selection: sessionPool.acquire passes the picked email
// through even in TEST_MOCK_PLAYWRIGHT mode (which otherwise hardcodes mock@test).
const originalAcquire = sessionPool.acquire;
let chatSeq = 0;
(sessionPool as any).acquire = async (email?: string) => ({
  chatId: `wall-test-chat-${++chatSeq}`,
  parentId: null,
  inUse: true,
  accountEmail: email,
});

afterEach(() => {
  writeFileSync(ACCOUNTS_FILE, accountsFileSnapshot);
});

afterAll(() => {
  (sessionPool as any).acquire = originalAcquire;
  accounts.length = 0;
  writeFileSync(ACCOUNTS_FILE, accountsFileSnapshot);
});

async function postChat(payload: Record<string, unknown>): Promise<{ res: Response; bodyText: string }> {
  const req = new Request('http://localhost/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key-for-testing' },
    body: JSON.stringify({ model: 'qwen3.6-plus', messages: [{ role: 'user', content: 'hello' }], ...payload }),
  });
  const res = await app.fetch(req);
  const bodyText = await res.text();
  return { res, bodyText };
}

function accountByEmail(email: string): AccountEntry {
  return accounts.find((a) => a.email === email)!;
}

describe('mid-payload RateLimited walls (HTTP 200)', () => {
  test('TEST1: non-streaming JSON wall on A → B serves, A throttled', async () => {
    resetState();
    seedAccounts();

    const originalFetch = globalThis.fetch;
    let chatCalls = 0;
    (globalThis as any).fetch = async (input: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/api/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'qwen3.6-plus', owned_by: 'qwen' }] }), { status: 200 });
      }
      if (url.includes('/api/v2/chat/completions')) {
        chatCalls++;
        return chatCalls === 1 ? wallResponse() : validAnswerSse('Hello from account B');
      }
      return originalFetch(input);
    };

    try {
      const { res, bodyText } = await postChat({ stream: false });
      expect(res.status).toBe(200);
      const body = JSON.parse(bodyText);
      expect(body.object).toBe('chat.completion');
      expect(body.choices[0].message.content).toBe('Hello from account B');

      expect(chatCalls).toBe(2);
      expect(accountByEmail(ACCOUNT_A).throttledUntil).toBeGreaterThan(Date.now());
      // Native accounting recorded the wall with Qwen's reported wait hours
      expect(rateLimitedCalls.some(([email, , hours]) => email === ACCOUNT_A && (hours ?? 0) >= 4)).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('TEST2: non-streaming SSE-framed wall on A → B serves, A throttled', async () => {
    resetState();
    seedAccounts();

    const originalFetch = globalThis.fetch;
    let chatCalls = 0;
    (globalThis as any).fetch = async (input: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/api/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'qwen3.6-plus', owned_by: 'qwen' }] }), { status: 200 });
      }
      if (url.includes('/api/v2/chat/completions')) {
        chatCalls++;
        if (chatCalls === 1) {
          // Wall framed as an SSE data line instead of a bare JSON body
          return sse([
            JSON.stringify({
              success: false,
              data: { code: 'RateLimited', details: "You've reached the upper limit for today's usage.", num: 4 },
            }),
          ]);
        }
        return validAnswerSse('Recovered on account B');
      }
      return originalFetch(input);
    };

    try {
      const { res, bodyText } = await postChat({ stream: false });
      expect(res.status).toBe(200);
      const body = JSON.parse(bodyText);
      expect(body.choices[0].message.content).toBe('Recovered on account B');
      expect(chatCalls).toBe(2);
      expect(accountByEmail(ACCOUNT_A).throttledUntil).toBeGreaterThan(Date.now());
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('TEST3: streaming wall before useful content → retried on B, valid stream served', async () => {
    resetState();
    seedAccounts();

    const originalFetch = globalThis.fetch;
    let chatCalls = 0;
    (globalThis as any).fetch = async (input: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/api/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'qwen3.6-plus', owned_by: 'qwen' }] }), { status: 200 });
      }
      if (url.includes('/api/v2/chat/completions')) {
        chatCalls++;
        return chatCalls === 1 ? wallResponse() : validAnswerSse('Streamed after rotation');
      }
      return originalFetch(input);
    };

    try {
      const { res, bodyText } = await postChat({ stream: true });
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('text/event-stream');

      expect(bodyText).toContain('Streamed after rotation');
      expect(bodyText).not.toContain('RateLimited'); // wall never leaked to the client
      expect(bodyText.split('"role":"assistant"').length - 1).toBeLessThanOrEqual(1); // no restarted stream

      expect(chatCalls).toBe(2);
      expect(accountByEmail(ACCOUNT_A).throttledUntil).toBeGreaterThan(Date.now());
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('TEST4: streaming wall AFTER content → no duplicate output, account throttled', async () => {
    resetState();
    seedAccounts();

    const originalFetch = globalThis.fetch;
    let chatCalls = 0;
    (globalThis as any).fetch = async (input: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/api/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'qwen3.6-plus', owned_by: 'qwen' }] }), { status: 200 });
      }
      if (url.includes('/api/v2/chat/completions')) {
        chatCalls++;
        if (chatCalls === 1) {
          // Useful content first, THEN the wall — nothing usable to rotate into
          // a clean restart once deltas were already emitted.
          const stream = new ReadableStream({
            start(c) {
              c.enqueue(
                new TextEncoder().encode(
                  `data: ${JSON.stringify({ choices: [{ delta: { phase: 'answer', content: 'Partial useful answer' } }] })}\n\n`,
                ),
              );
              c.enqueue(
                new TextEncoder().encode(
                  `data: ${JSON.stringify({
                    success: false,
                    data: { code: 'RateLimited', details: "You've reached the upper limit for today's usage.", num: 4 },
                  })}\n\n`,
                ),
              );
              c.close();
            },
          });
          return new Response(stream, { status: 200 });
        }
        return validAnswerSse('SHOULD NOT BE SERVED');
      }
      return originalFetch(input);
    };

    try {
      const { res, bodyText } = await postChat({ stream: true });
      expect(res.status).toBe(200);

      // Partial content preserved exactly once, no silent restart/duplication
      expect(bodyText.split('Partial useful answer').length - 1).toBe(1);
      expect(bodyText).not.toContain('SHOULD NOT BE SERVED');
      // Error surfaced through the existing mechanism, stream terminated
      expect(bodyText).toContain('RateLimited');
      expect(bodyText).toContain('[DONE]');

      expect(chatCalls).toBe(1); // no retry after output was emitted
      expect(accountByEmail(ACCOUNT_A).throttledUntil).toBeGreaterThan(Date.now());
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
