import { expect, mock, test } from 'bun:test';
import { createOpenAIProxyHandler } from '../routes/providers/openaiProxy.ts';

function mockCtx() {
  return {
    json: (_body: unknown, _status: number) => new Response(JSON.stringify(_body), { status: _status }),
  };
}

test('createOpenAIProxyHandler returns a function', () => {
  const handler = createOpenAIProxyHandler('test', 'TEST_API_KEY', 'TEST_BASE_URL', 'https://test.api.com');
  expect(typeof handler).toBe('function');
  expect(handler.length).toBe(2);
});

test('returns 503 when API key env var is not set', async () => {
  const orig = process.env.TEST_API_KEY;
  delete process.env.TEST_API_KEY;

  try {
    const handler = createOpenAIProxyHandler('test', 'TEST_API_KEY', 'TEST_BASE_URL', 'https://test.api.com');
    const result = await handler(mockCtx() as any, { model: 'test/some-model' } as any);
    expect(result.status).toBe(503);
    const body = await result.json();
    expect(body.error.message).toContain('TEST_API_KEY');
  } finally {
    if (orig) process.env.TEST_API_KEY = orig;
  }
});

test('model prefix is stripped from upstream model name', async () => {
  process.env.TEST_API_KEY = 'sk-test-key';
  const origUrl = process.env.TEST_BASE_URL;
  delete process.env.TEST_BASE_URL;

  try {
    const handler = createOpenAIProxyHandler('test', 'TEST_API_KEY', 'TEST_BASE_URL', 'https://test.api.com');
    const mockFetch = mock((_url: string, _init: RequestInit): Promise<Response> => Promise.resolve(new Response(null, { status: 200 })));
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = mockFetch;

    try {
      await handler(mockCtx() as any, { model: 'test/stripped-model', stream: false } as any);
    } catch {
      // fetch mock returns a real Response but signal can trigger on abort
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(mockFetch.mock.calls.length).toBeGreaterThan(0);
    const callUrl = mockFetch.mock.calls[0][0];
    expect(callUrl).toContain('/v1/chat/completions');

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(callBody.model).toBe('stripped-model');
    expect(callBody.model).not.toContain('test/');
  } finally {
    if (origUrl) process.env.TEST_BASE_URL = origUrl;
    delete process.env.TEST_API_KEY;
  }
});
