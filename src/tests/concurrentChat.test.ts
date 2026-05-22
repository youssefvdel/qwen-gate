import test from 'node:test';
import assert from 'node:assert';
import net from 'node:net';
import { serve } from '@hono/node-server';
import { app } from '../index.ts';
import { initPlaywright, closePlaywright } from '../services/playwright.ts';

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port);
  });
}

async function getFreePort(startPort: number): Promise<number> {
  let port = startPort;
  while (true) {
    const available = await isPortAvailable(port);
    if (available) return port;
    port++;
  }
}

test('Concurrent chat requests check for "chat is in progress"', async () => {
  const port = await getFreePort(3100);
  const server = serve({ fetch: app.fetch, port });
  console.log(`[ConcurrentTest] Server started on port ${port}`);

  await initPlaywright(true);

  try {
    const requestPayload = {
      model: 'qwen3.6-plus',
      messages: [{ role: 'user', content: 'Say "hello" and nothing else.' }],
      stream: false
    };

    console.log('[ConcurrentTest] Sending 2 requests concurrently...');
    
    // Dispara duas requisições simultaneamente para simular concorrência na mesma sessão
    const p1 = fetch(`http://localhost:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestPayload)
    });

    const p2 = fetch(`http://localhost:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestPayload)
    });

    const [res1, res2] = await Promise.all([p1, p2]);

    const data1 = await res1.json();
    const data2 = await res2.json();

    console.log('[ConcurrentTest] Result 1:', res1.status, JSON.stringify(data1).substring(0, 200));
    console.log('[ConcurrentTest] Result 2:', res2.status, JSON.stringify(data2).substring(0, 200));

    // Se a concorrência não estiver sendo tratada, um deles pode falhar com o erro "in progress"
    assert.strictEqual(res1.status, 200, `Request 1 failed: ${JSON.stringify(data1)}`);
    assert.strictEqual(res2.status, 200, `Request 2 failed: ${JSON.stringify(data2)}`);

  } finally {
    await closePlaywright();
    server.close();
  }
});
