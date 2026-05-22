import test from 'node:test';
import assert from 'node:assert';

process.env.TEST_MOCK_PLAYWRIGHT = 'true';
// Ensure API_KEY is empty by default for existing tests
process.env.API_KEY = '';

import { app } from '../index.ts';
import { initPlaywright, closePlaywright } from '../services/playwright.ts';

test('Health check endpoint returns status ok', async () => {
  const req = new Request('http://localhost/health');
  const res = await app.fetch(req);
  
  assert.strictEqual(res.status, 200);
  
  const body = await res.json();
  assert.deepStrictEqual(body, { status: 'ok' });
});

test('Models endpoint returns qwen3.6-plus and qwen3.6-plus-no-thinking', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'qwen3.6-plus', owned_by: 'qwen' }] }), { status: 200 });
    }
    return originalFetch(input);
  };

  try {
    const req = new Request('http://localhost/v1/models');
    const res = await app.fetch(req);
    
    assert.strictEqual(res.status, 200);
    
    const body = await res.json();
    assert.strictEqual(body.object, 'list');
    assert.ok(Array.isArray(body.data));
    assert.ok(body.data.some((m: any) => m.id === 'qwen3.6-plus'));
    assert.ok(body.data.some((m: any) => m.id === 'qwen3.6-plus-no-thinking'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Chat Completions endpoint with qwen3.6-plus (thinking enabled)', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'qwen3.6-plus', owned_by: 'qwen' }] }), { status: 200 });
    }
    if (url.includes('/api/v2/chat/completions')) {
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {"choices": [{"delta": {"phase": "thinking_summary", "extra": {"summary_thought": {"content": ["Thinking..."]}}}}]}\n\n'));
          c.enqueue(new TextEncoder().encode('data: {"choices": [{"delta": {"phase": "answer", "content": "Hello"}}]}\n\n'));
          c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          c.close();
        }
      });
      return new Response(stream, { status: 200 });
    }
    return originalFetch(input);
  };

  // Initialize playwright for this test
  await initPlaywright(false);

  try {
    const payload = {
      model: 'qwen3.6-plus',
      messages: [{ role: 'user', content: 'What is 99 * 182? Please think step by step.' }],
      stream: true
    };

    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
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
          } catch (err) {
            // Partial JSON ignored
            // console.error("Parse error:", err);
          }
        }
      }
    }

    assert.ok(hasReasoning, 'Should have received streamed chunks with reasoning_content (Thinking enabled)');
    assert.ok(hasContent, 'Should have received streamed chunks with content');
  } finally {
    globalThis.fetch = originalFetch;
    await closePlaywright();
  }
});

test('Chat Completions returns explicit error for non-SSE upstream JSON errors', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/v2/chat/completions')) {
      return new Response(JSON.stringify({
        success: false,
        data: {
          code: 'RateLimited',
          details: "You've reached the upper limit for today's usage.",
          num: 3
        }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return originalFetch(input);
  };

  await initPlaywright(false);

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        messages: [{ role: 'user', content: 'hello' }],
        stream: false
      })
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 429);

    const body = await res.json();
    assert.match(body.error.message, /Qwen upstream error: RateLimited/);
    assert.match(body.error.message, /upper limit/);
  } finally {
    globalThis.fetch = originalFetch;
    await closePlaywright();
  }
});

test('Chat Completions returns a JSON chat.completion object for non-streaming requests', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/v2/chat/completions')) {
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {"choices": [{"delta": {"phase": "answer", "content": "Hello"}}]}\n\n'));
          c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          c.close();
        }
      });
      return new Response(stream, { status: 200 });
    }
    return originalFetch(input);
  };

  await initPlaywright(false);

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        messages: [{ role: 'user', content: 'hello' }],
        stream: false
      })
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);

    const body = await res.json();
    assert.strictEqual(body.object, 'chat.completion');
    assert.strictEqual(body.choices[0].message.role, 'assistant');
    assert.strictEqual(body.choices[0].message.content, 'Hello');
  } finally {
    globalThis.fetch = originalFetch;
    await closePlaywright();
  }
});

test('API Key protection', async () => {
  const originalApiKey = process.env.API_KEY;
  process.env.API_KEY = 'test-api-key';

  try {
    // 1. Test request without API Key
    const req1 = new Request('http://localhost/v1/models');
    const res1 = await app.fetch(req1);
    assert.strictEqual(res1.status, 401, 'Should return 401 Unauthorized without API Key');

    // 2. Test request with wrong API Key
    const req2 = new Request('http://localhost/v1/models', {
      headers: { 'Authorization': 'Bearer wrong-key' }
    });
    const res2 = await app.fetch(req2);
    assert.strictEqual(res2.status, 401, 'Should return 401 Unauthorized with wrong API Key');

    // 3. Test request with correct API Key
    // Mock fetch for models list
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ data: [] }), { status: 200 });

    try {
      const req3 = new Request('http://localhost/v1/models', {
        headers: { 'Authorization': 'Bearer test-api-key' }
      });
      const res3 = await app.fetch(req3);
      assert.strictEqual(res3.status, 200, 'Should return 200 OK with correct API Key');
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    process.env.API_KEY = originalApiKey;
  }
});

test('Chat Completions endpoint - Non-streaming (stream: false)', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'qwen3.6-plus', owned_by: 'qwen' }] }), { status: 200 });
    }
    if (url.includes('/api/v2/chat/completions')) {
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {"choices": [{"delta": {"phase": "thinking_summary", "extra": {"summary_thought": {"content": ["Thinking non-stream..."]}}}}]}\n\n'));
          c.enqueue(new TextEncoder().encode('data: {"choices": [{"delta": {"phase": "answer", "content": "Hello non-stream"}}]}\n\n'));
          c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          c.close();
        }
      });
      return new Response(stream, { status: 200 });
    }
    return originalFetch(input);
  };

  // Initialize playwright for this test
  await initPlaywright(false);

  try {
    const payload = {
      model: 'qwen3.6-plus',
      messages: [{ role: 'user', content: 'Hello' }],
      stream: false
    };

    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
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
    await closePlaywright();
  }
});
