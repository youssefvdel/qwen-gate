import assert from 'node:assert';
import test from 'node:test';

process.env.TEST_MOCK_PLAYWRIGHT = 'true';
// Set a test API key (never empty — prevents auth bypass in tests)
process.env.API_KEY = 'test-key-for-testing';

import { app } from '../index.tsx';
import { accounts } from '../services/accountManager.ts';

const TEST_API_KEY = 'test-key-for-testing';
const authHeaders = { Authorization: `Bearer ${TEST_API_KEY}` };

test('Health check returns degraded when Playwright not initialized', async () => {
  const req = new Request('http://localhost/health');
  const res = await app.fetch(req);

  assert.strictEqual(res.status, 200);

  const body = await res.json();
  assert.strictEqual(body.status, 'degraded');
  assert.ok(typeof body.uptime === 'number');
});

test('Models endpoint returns cleaned OpenAI-compatible model data', async () => {
  const originalFetch = globalThis.fetch;
  (globalThis as any).fetch = async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/models')) {
      return new Response(
        JSON.stringify({
          data: [
            {
              id: 'qwen3.6-plus',
              owned_by: 'qwen',
              info: {
                created_at: 1732711466,
                meta: {
                  max_context_length: 1000000,
                  max_summary_generation_length: 65536,
                  modality: ['text', 'image'],
                  short_description: 'A test model',
                  capabilities: { vision: true, thinking: true },
                },
              },
            },
          ],
        }),
        { status: 200 },
      );
    }
    return originalFetch(input);
  };

  try {
    const req = new Request('http://localhost/v1/models', { headers: authHeaders });
    const res = await app.fetch(req);

    assert.strictEqual(res.status, 200);

    const body = await res.json();
    assert.strictEqual(body.object, 'list');
    assert.ok(Array.isArray(body.data));

    const model = body.data[0];
    assert.strictEqual(model.id, 'qwen3.6-plus');
    assert.strictEqual(model.object, 'model');
    assert.strictEqual(model.created, 1732711466);
    assert.strictEqual(model.owned_by, 'qwen');
    assert.strictEqual(model.context_window, 1000000);
    assert.strictEqual(model.max_output_tokens, 65536);
    assert.deepStrictEqual(model.modalities, ['text', 'image']);
    assert.strictEqual(model.description, 'A test model');
    assert.deepStrictEqual(model.capabilities, { vision: true, thinking: true });
    // should not carry raw Qwen-internal fields
    assert.strictEqual(model.info, undefined);
    assert.strictEqual(model.preset, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Chat Completions endpoint with qwen3.6-plus (thinking enabled)', async () => {
  const originalFetch = globalThis.fetch;
  (globalThis as any).fetch = async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'qwen3.6-plus', owned_by: 'qwen' }] }), { status: 200 });
    }
    if (url.includes('/api/v2/chat/completions')) {
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(
            new TextEncoder().encode(
              'data: {"choices": [{"delta": {"phase": "thinking_summary", "extra": {"summary_thought": {"content": ["Thinking..."]}}}}]}\n\n',
            ),
          );
          c.enqueue(new TextEncoder().encode('data: {"choices": [{"delta": {"phase": "answer", "content": "Hello"}}]}\n\n'));
          c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          c.close();
        },
      });
      return new Response(stream, { status: 200 });
    }
    return originalFetch(input);
  };

  try {
    const payload = {
      model: 'qwen3.6-plus',
      messages: [{ role: 'user', content: 'What is 99 * 182? Please think step by step.' }],
      stream: true,
    };

    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders),
      body: JSON.stringify(payload),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('Content-Type'), 'text/event-stream');

    const reader = res.body?.getReader();
    assert.ok(reader, 'Response should have a readable body');

    const decoder = new TextDecoder();
    let hasReasoning = false;
    let hasContent = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (line.trim() === 'data: [DONE]') {
          break;
        }
        if (line.startsWith('data: ')) {
          try {
            const dataStr = line.slice(6);
            if (dataStr !== '[DONE]') {
              const data = JSON.parse(dataStr);

              if (data.choices && data.choices[0] && data.choices[0].delta) {
                const delta = data.choices[0].delta;
                if (delta.content) {
                  hasContent = true;
                }
                if (delta.reasoning_content) {
                  hasReasoning = true;
                }
              }
            }
          } catch {
            // Partial JSON ignored
          }
        }
      }
    }

    assert.ok(hasReasoning, 'Should have received streamed chunks with reasoning_content (Thinking enabled)');
    assert.ok(hasContent, 'Should have received streamed chunks with content');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Chat Completions returns explicit error for non-SSE upstream JSON errors', async () => {
  const originalFetch = globalThis.fetch;
  (globalThis as any).fetch = async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/v2/chat/completions')) {
      return new Response(
        JSON.stringify({
          success: false,
          data: {
            code: 'RateLimited',
            details: "You've reached the upper limit for today's usage.",
            num: 3,
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return originalFetch(input);
  };

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders),
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        messages: [{ role: 'user', content: 'hello' }],
        stream: false,
      }),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 429);

    const body = await res.json();
    assert.match(body.error.message, /Qwen upstream error: RateLimited/);
    assert.match(body.error.message, /upper limit/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Chat Completions returns a JSON chat.completion object for non-streaming requests', async () => {
  const originalFetch = globalThis.fetch;
  (globalThis as any).fetch = async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/v2/chat/completions')) {
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {"choices": [{"delta": {"phase": "answer", "content": "Hello"}}]}\n\n'));
          c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          c.close();
        },
      });
      return new Response(stream, { status: 200 });
    }
    return originalFetch(input);
  };

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders),
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        messages: [{ role: 'user', content: 'hello' }],
        stream: false,
      }),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);

    const body = await res.json();
    assert.strictEqual(body.object, 'chat.completion');
    assert.strictEqual(body.choices[0].message.role, 'assistant');
    assert.strictEqual(body.choices[0].message.content, 'Hello');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('API Key protection', async () => {
  const originalApiKey = process.env.API_KEY;
  process.env.API_KEY = 'test-api-key';
  let originalFetch: any;

  try {
    // 1. Test request without API Key
    const req1 = new Request('http://localhost/v1/models');
    const res1 = await app.fetch(req1);
    assert.strictEqual(res1.status, 401, 'Should return 401 Unauthorized without API Key');

    // 2. Test request with wrong API Key
    const req2 = new Request('http://localhost/v1/models', {
      headers: { Authorization: 'Bearer wrong-key' },
    });
    const res2 = await app.fetch(req2);
    assert.strictEqual(res2.status, 401, 'Should return 401 Unauthorized with wrong API Key');

    // 3. Test request with correct API Key
    // Mock fetch for models list
    originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => new Response(JSON.stringify({ data: [] }), { status: 200 });

    try {
      const req3 = new Request('http://localhost/v1/models', {
        headers: { Authorization: 'Bearer test-api-key' },
      });
      const res3 = await app.fetch(req3);
      assert.strictEqual(res3.status, 200, 'Should return 200 OK with correct API Key');
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    globalThis.fetch = originalFetch;
    process.env.API_KEY = originalApiKey;
  }
});

test('Chat completions with image uploads attaches files (t2t chat_type, vision class)', async () => {
  const originalFetch = globalThis.fetch;
  const originalAccounts = [...accounts];

  // Seed a test account so pickAccount returns an account for image upload
  accounts.push({
    email: 'test@qwen-gate.dev',
    password: 'test',
    state: { token: 'mock-token', expiresAt: Date.now() + 3600000, refreshToken: null },
    lastUsed: 0,
    throttledUntil: 0,
    refreshInFlight: null,
    loginAttempt: 0,
    inFlight: 0,
    totalRequests: 0,
    startupStatus: 'ready',
  });

  let stsCalled = false;
  let ossCalled = false;
  let chatPayload: any = null;

  (globalThis as any).fetch = async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'qwen3.6-plus', owned_by: 'qwen' }] }), { status: 200 });
    }
    if (url.includes('/api/v2/files/getstsToken')) {
      stsCalled = true;
      return new Response(
        JSON.stringify({
          data: {
            access_key_id: 'test-key',
            access_key_secret: 'test-secret',
            security_token: 'test-token',
            bucketname: 'test-bucket',
            region: 'oss-cn-hangzhou',
            endpoint: 'oss-cn-hangzhou.aliyuncs.com',
            file_id: 'test-file-id',
            file_path: 'test-user/test-file-id_image.png',
            file_url: 'https://test-bucket.oss-cn-hangzhou.aliyuncs.com/test-file-id_image.png',
          },
        }),
        { status: 200 },
      );
    }
    if (url.includes('/api/v2/files/parse/status')) {
      return new Response(JSON.stringify({ data: [{ status: 'success' }] }), { status: 200 });
    }
    if (url.includes('/api/v2/files/parse')) {
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    if (url.includes('aliyuncs.com') || url.includes('oss-')) {
      ossCalled = true;
      return new Response(null, { status: 200 });
    }
    if (url.includes('/api/v2/chat/completions')) {
      // Capture the payload for later assertions
      // init?.body is set when browserlessFetch calls globalThis.fetch(url, { method, headers, body })
      const bodyStr =
        typeof input === 'string' && init?.body ? init.body : typeof input !== 'string' ? await (input as Request).clone().text() : '';
      try {
        chatPayload = JSON.parse(bodyStr);
      } catch {}
      // Return a simple stream
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {"choices": [{"delta": {"content": "Image received"}}]}\n\n'));
          c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          c.close();
        },
      });
      return new Response(stream, { status: 200 });
    }
    return originalFetch(input, init);
  };

  try {
    const payload = {
      model: 'qwen3.6-plus',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is in this image?' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAA=' } },
          ],
        },
      ],
      stream: false,
    };

    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, { Authorization: 'Bearer test-key-for-testing' }),
      body: JSON.stringify(payload),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);

    // Verify STS token was requested (image upload initiated)
    assert.ok(stsCalled, 'Should have called getstsToken for image upload');

    // Verify OSS upload happened
    assert.ok(ossCalled, 'Should have uploaded image to OSS');

    // Verify the chat payload has the right format
    assert.ok(chatPayload, 'Chat completion should have been called');
    const msg = chatPayload?.messages?.[0];
    assert.ok(msg, 'Should have at least one message');

    // The image_url should be stripped from content text (only text parts remain)
    assert.ok(!msg.content.includes('image_url'), 'Image URL should be stripped from content text');
    assert.ok(msg.content.includes('What is in this image?'), 'Text content should be preserved');

    // Should have files attached
    assert.ok(Array.isArray(msg.files), 'Message should have files array');
    assert.ok(msg.files.length > 0, 'Should have at least one file (image)');

    // Chat type should remain t2t (default) — Qwen web UI uses t2t even with images
    assert.strictEqual(msg.chat_type, 't2t', 'Chat type should remain t2t for images');
    assert.strictEqual(msg.sub_chat_type, 't2t', 'Sub chat type should remain t2t');
    assert.strictEqual(msg.extra?.meta?.subChatType, 't2t', 'Extra subChatType should remain t2t');

    // Verify file attachment format
    const file = msg.files[0];
    assert.strictEqual(file.type, 'image', 'File attachment type should be image');
    assert.strictEqual(file.file_class, 'vision', 'File class should be vision');
  } finally {
    globalThis.fetch = originalFetch;
    accounts.splice(0, accounts.length, ...originalAccounts);
  }
});

test('Chat Completions endpoint - Non-streaming (stream: false)', async () => {
  const originalFetch = globalThis.fetch;
  (globalThis as any).fetch = async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'qwen3.6-plus', owned_by: 'qwen' }] }), { status: 200 });
    }
    if (url.includes('/api/v2/chat/completions')) {
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(
            new TextEncoder().encode(
              'data: {"choices": [{"delta": {"phase": "thinking_summary", "extra": {"summary_thought": {"content": ["Thinking non-stream..."]}}}}]}\n\n',
            ),
          );
          c.enqueue(new TextEncoder().encode('data: {"choices": [{"delta": {"phase": "answer", "content": "Hello non-stream"}}]}\n\n'));
          c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          c.close();
        },
      });
      return new Response(stream, { status: 200 });
    }
    return originalFetch(input);
  };

  try {
    const payload = {
      model: 'qwen3.6-plus',
      messages: [{ role: 'user', content: 'Hello' }],
      stream: false,
    };

    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders),
      body: JSON.stringify(payload),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);
    assert.ok(res.headers.get('Content-Type')?.includes('application/json'));

    const body = await res.json();
    assert.strictEqual(body.object, 'chat.completion');
    assert.strictEqual(body.model, 'qwen3.6-plus');
    assert.ok(body.choices);
    assert.strictEqual(body.choices.length, 1);

    const choice = body.choices[0];
    assert.strictEqual(choice.message.role, 'assistant');
    assert.strictEqual(choice.message.content, 'Hello non-stream');
    assert.strictEqual(choice.message.reasoning_content, 'Thinking non-stream...');
    assert.strictEqual(choice.finish_reason, 'stop');

    assert.ok(body.usage);
    assert.ok(body.usage.prompt_tokens > 0);
    assert.ok(body.usage.completion_tokens >= 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
