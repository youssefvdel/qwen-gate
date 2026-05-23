import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bearerAuth } from 'hono/bearer-auth';
import { chatCompletions } from './routes/chat.ts';
import { fetchQwenModels } from './services/qwen.ts';
import * as dotenv from 'dotenv';
import { initPlaywright, activePage, BrowserType, getQwenHeaders } from './services/playwright.ts';
import { initAuth } from './services/auth.ts';
import { networkInterfaces } from 'os';
import { logStore } from './services/logStore.ts';
import { logHtml } from './routes/logPage.ts';
import { stream as honoStream } from 'hono/streaming';

dotenv.config();

export const app = new Hono();

app.use('*', cors());

// Helper to get local network IPs
function getNetworkAddress() {
  const interfaces = networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]!) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return null;
}

// API Key protection middleware
app.use('/v1/*', async (c, next) => {
  const apiKey = process.env.API_KEY;
  if (!apiKey) return await next();
  return bearerAuth({ token: apiKey })(c, next);
});

app.use('/log*', async (c, next) => {
  const apiKey = process.env.API_KEY;
  if (!apiKey) return await next();
  return bearerAuth({ token: apiKey })(c, next);
});

// Basic health check
app.get('/health', (c) => {
  const pwOk = activePage !== null;
  return c.json({
    status: pwOk ? 'ok' : 'degraded',
    playwright: pwOk,
    uptime: process.uptime()
  }, pwOk ? 200 : 503);
});

// Log viewer — shows recent client inputs and Qwen outputs
app.get('/log', (c) => {
  return c.html(logHtml);
});

app.get('/log/json', (c) => {
  return c.json(logStore.getRecent(50));
});

app.get('/log/stream', (c) => {
  return new Response(
    new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        for (const entry of logStore.getRecent(50)) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(entry)}\n\n`));
        }
        const unsub = logStore.subscribe((entry) => {
          try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(entry)}\n\n`)); } catch {}
        });
        const signal = c.req.raw?.signal;
        if (signal) {
          signal.addEventListener('abort', () => { unsub(); try { controller.close(); } catch {} });
        }
      },
    }),
    {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      }
    }
  );
});

// OpenAI compatible routes
app.post('/v1/chat/completions', chatCompletions);

app.get('/v1/models', async (c) => {
  try {
    const models = await fetchQwenModels();
    return c.json({
      object: 'list',
      data: models
    });
  } catch (err: any) {
    return c.json({ error: { message: err.message } }, 500);
  }
});

// Initialize playwright when server starts
import { fileURLToPath } from 'url';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Parse browser type from args or env
  let browserType: BrowserType = 'chromium';
  const browserArg = process.argv.find(arg => arg.startsWith('--browser='));
  if (browserArg) {
    browserType = browserArg.split('=')[1] as BrowserType;
  } else if (process.env.BROWSER) {
    browserType = process.env.BROWSER as BrowserType;
  }

  initPlaywright(true, browserType).then(async () => {
    console.log(`Playwright initialized (${browserType}).`);

    // Initialize auth AFTER playwright so login uses browser context with WAF headers.
    // The auth service will use activePage.evaluate() for the API call when available,
    // giving us proper anti-bot headers and avoiding WAF blocks.
    initAuth().catch(err => console.warn('[Startup] initAuth failed:', err.message));

    console.log('[Startup] Pre-warming headers...');
    try {
      await getQwenHeaders(true);
      console.log('[Startup] Headers pre-warmed.');
    } catch (err: any) {
      console.warn('[Startup] Header pre-warm failed:', err.message);
    }

    const port = parseInt(process.env.PORT || '26405', 10) || 26405;
    
    const networkIP = getNetworkAddress();
    
    console.log('\n🚀 Qwen Gate started!');
    console.log(`- Local:   http://localhost${port === 80 ? '' : ':' + port}`);
    console.log(`- Alias:   http://qwen-gate`);
    if (networkIP) {
      console.log(`- Network: http://${networkIP}${port === 80 ? '' : ':' + port}`);
    }

    console.log('\nAvailable Routes:');
    app.routes.forEach(route => {
      console.log(`- [${route.method}] ${route.path}`);
    });
    console.log('');

    serve({
      fetch: app.fetch,
      port
    });
  }).catch((err: any) => {
    console.error('Failed to initialize playwright:', err);
    process.exit(1);
  });
}
