import { Hono } from 'hono';
import { getRecentNetworkEntries, getNetworkEntry, subscribeNetwork } from '../services/networkDebug.ts';

export const debugNetworkApp = new Hono();

// GET /debug/network -- returns recent entries as JSON
debugNetworkApp.get('/', (c) => {
  const limit = parseInt(c.req.query('limit') || '50', 10);
  const entries = getRecentNetworkEntries(limit);
  return c.json({ count: entries.length, entries });
});

// GET /debug/network/:id -- single entry detail
debugNetworkApp.get('/:id', (c) => {
  const entry = getNetworkEntry(c.req.param('id'));
  if (!entry) return c.json({ error: 'Not found' }, 404);
  return c.json(entry);
});

// GET /debug/network/stream -- SSE live feed
debugNetworkApp.get('/stream', (c) => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      // Send recent entries as initial batch
      const initial = getRecentNetworkEntries(20);
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'initial', entries: initial })}\n\n`));

      // Subscribe to updates
      const unsub = subscribeNetwork((entry) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'update', entry })}\n\n`));
        } catch { /* stream closed */ }
      });

      const signal = c.req.raw?.signal;
      if (signal) {
        signal.addEventListener('abort', () => {
          unsub();
          try { controller.close(); } catch { /* already closed */ }
        });
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
});
