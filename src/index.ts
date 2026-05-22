import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bearerAuth } from 'hono/bearer-auth';
import { chatCompletions } from './routes/chat.ts';
import { fetchQwenModels } from './services/qwen.ts';
import * as dotenv from 'dotenv';
import { initPlaywright, activePage, BrowserType } from './services/playwright.ts';
import { networkInterfaces } from 'os';

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
  if (!apiKey) {
    return await next();
  }
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
    try {
      const { sessionPool } = await import('./services/sessionPool.ts');
      await sessionPool.initialize();
      console.log(`Session pool ready with ${sessionPool.getStats().total} sessions.`);
    } catch (err: any) {
      console.error('Session pool init failed:', err.message);
      console.warn('Proxy will start but concurrent requests may be limited.');
    }
    const port = parseInt(process.env.PORT || '3000', 10) || 3000;
    
    const networkIP = getNetworkAddress();
    
    console.log('\n🚀 QwenProxy started!');
    console.log(`- Local:   http://localhost:${port}`);
    if (networkIP) {
      console.log(`- Network: http://${networkIP}:${port}`);
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
