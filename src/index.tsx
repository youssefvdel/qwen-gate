import 'dotenv/config';
import { existsSync, unlinkSync, writeFileSync } from 'fs';
import { Hono } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import { cors } from 'hono/cors';

import { rateLimitMiddleware, startAutoCleanup, stopAutoCleanup } from './middleware/rateLimit.ts';
import { accountsRouter } from './routes/accounts.ts';
import { anthropicMessages } from './routes/anthropic.ts';
import { chatCompletions } from './routes/chat.ts';
import { configRouter } from './routes/config.ts';
import { registerDashboardRoutes } from './routes/dashboard/dashboardRoutes.ts';
import { debugNetworkApp } from './routes/debugNetwork.ts';
import { getAccountCount, getAccountStats, getAccounts, getAvailableCount, initAuth, setStartupStatus } from './services/auth.ts';
import { config, updateClaudeCodeSettings } from './services/configService.ts';
import { logStore } from './services/logStore.ts';
import { fetchProviderModels } from './services/providerModelsService.ts';
import { configureAccount, fetchQwenModels } from './services/qwen.ts';
import { safeCompare } from './utils/auth.ts';
import { isBun } from './utils/env.ts';
import { projectPath } from './utils/paths.ts';
import { PROVIDER_MODEL_SPECS, PROVIDER_MODELS } from './utils/providerModels.ts';

// Attach context_window / max_output_tokens / modalities to provider model
// entries so OpenAI clients (Hermes, etc.) get accurate metadata instead of
// falling back to their own (possibly stale) model databases.
function attachProviderSpecs(m: any): any {
  const spec = PROVIDER_MODEL_SPECS[m.id as string];
  if (!spec) return m;
  return {
    ...m,
    context_window: spec.max_context,
    max_output_tokens: spec.max_output,
    modalities: spec.modalities,
  };
}

process.title = 'opengate';

process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Unhandled Promise Rejection:', reason);
});

console.clear();
process.stdout.write('\x1bc\x1b[3J\x1b[2J\x1b[H');

// Forward console warn/error to dashboard system logs while preserving terminal output
const _origWarn = console.warn;
const _origError = console.error;
console.warn = (...args: any[]) => {
  _origWarn.apply(console, args);
  const msg = args.map((a: any) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  logStore.log('warn', 'system', msg);
};
console.error = (...args: any[]) => {
  _origError.apply(console, args);
  const msg = args.map((a: any) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  logStore.log('error', 'system', msg);
};

export const app = new Hono();

let inFlightRequests = 0;
let isShuttingDown = false;
let serverStop: (() => void | Promise<void>) | null = null;
const SHUTDOWN_TIMEOUT_MS = 30_000;

app.use('*', async (c, next) => {
  if (isShuttingDown) {
    return c.json({ error: { message: 'Server is shutting down' } }, 503);
  }
  inFlightRequests++;
  try {
    await next();
  } finally {
    inFlightRequests--;
  }
});

async function gracefulShutdown(_signal: string): Promise<void> {
  if (isShuttingDown) {
    process.exit(1);
  }
  isShuttingDown = true;
  if (serverStop) {
    try {
      await serverStop();
    } catch {
      /* intentional */
    }
  }
  if (inFlightRequests > 0) {
    const start = Date.now();
    while (inFlightRequests > 0 && Date.now() - start < SHUTDOWN_TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  stopAutoCleanup();
  const pidFile = projectPath('.auth', 'gate.pid');
  try {
    if (existsSync(pidFile)) unlinkSync(pidFile);
  } catch {
    /* best effort */
  }
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

app.use('*', cors({ origin: '*' }));

// Debug: log all incoming requests
app.use('*', async (c, next) => {
  const method = c.req.method;
  const path = c.req.path;
  const ua = c.req.header('user-agent') || 'unknown';
  logStore.log('debug', 'http', `${method} ${path} UA=${ua.slice(0, 80)}`);
  await next();
});

// Health check — reports actual system status
app.get('/health', (c) => {
  const totalAccounts = getAccountCount();
  const availableAccounts = getAvailableCount();
  const stats = getAccountStats();
  const authenticatedCount = stats.filter((s) => s.authenticated).length;
  const throttledCount = stats.filter((s) => s.throttled).length;
  const isHealthy = totalAccounts > 0 && authenticatedCount > 0;
  return c.json({
    status: isHealthy ? 'ok' : 'degraded',
    version: '0.7.0',
    uptime: process.uptime(),
    inFlight: inFlightRequests,
    accounts: {
      total: totalAccounts,
      authenticated: authenticatedCount,
      available: availableAccounts,
      throttled: throttledCount,
    },
  });
});
// Ping — lightweight static response
const PING_RESPONSE = new Response('OK', {
  status: 200,
  headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-cache' },
});
app.get('/ping', () => PING_RESPONSE);

// API Key protection for OpenAI-compatible routes
app.use('/v1/*', async (c, next) => {
  const apiKey = config.get('API_KEY');
  if (!apiKey) return await next();
  return bearerAuth({ token: apiKey })(c, next);
});

registerDashboardRoutes(app);

app.route('/debug/network', debugNetworkApp);

// Account CRUD API — protected by bearer auth
app.use('/api/accounts*', async (c, next) => {
  const apiKey = config.get('API_KEY');
  if (!apiKey) return await next();
  return bearerAuth({ token: apiKey })(c, next);
});
app.route('/api/accounts', accountsRouter);

// Config API
if (config.get('API_KEY')) {
  configRouter.use('*', async (c, next) => {
    const auth = c.req.header('Authorization');
    if (!auth || !auth.startsWith('Bearer ') || !safeCompare(auth.slice(7), config.get('API_KEY'))) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    await next();
  });
}
app.route('/api/config', configRouter);

// 10MB request body limit on all chat endpoints
const MAX_BODY_BYTES = 10 * 1024 * 1024;
app.use('/v1/chat/completions', async (c, next) => {
  const contentLength = Number(c.req.header('content-length') || 0);
  if (contentLength > MAX_BODY_BYTES) {
    return c.json({ error: { message: 'Request body too large' } }, 413);
  }
  await next();
});

app.post(
  '/v1/chat/completions',
  async (c, next) => {
    const result = await rateLimitMiddleware(c, 'chat-completions');
    if (result) return result;
    await next();
  },
  chatCompletions,
);

// 10MB request body limit on anthropic endpoint
app.use('/v1/messages', async (c, next) => {
  const contentLength = Number(c.req.header('content-length') || 0);
  if (contentLength > MAX_BODY_BYTES) {
    return c.json({ error: { message: 'Request body too large' } }, 413);
  }
  await next();
});

app.post(
  '/v1/messages',
  async (c, next) => {
    const result = await rateLimitMiddleware(c, 'chat-completions');
    if (result) return result;
    await next();
  },
  async (c) => {
    const startMs = Date.now();
    const model = c.req.header('anthropic-model') || '?';
    const url = c.req.url;
    logStore.log('info', 'http', `[Anthropic] /v1/messages ENTER model=${model} url=${url}`);
    try {
      const response = await anthropicMessages(c);
      logStore.log('info', 'http', `[Anthropic] /v1/messages EXIT duration=${Date.now() - startMs}ms`);
      return response;
    } catch (err: any) {
      logStore.log('error', 'http', `[Anthropic] /v1/messages UNCAUGHT after ${Date.now() - startMs}ms: ${err.message || err}`);
      throw err;
    }
  },
);

app.get(
  '/v1/models',
  async (c, next) => {
    const result = await rateLimitMiddleware(c, 'models');
    if (result) return result;
    await next();
  },
  async (c) => {
    try {
      const [qwenModels, deepseekModels, glmModels] = await Promise.all([
        fetchQwenModels(),
        fetchProviderModels('deepseek'),
        fetchProviderModels('glm'),
      ]);
      const allModels = [...qwenModels, ...deepseekModels, ...glmModels, ...PROVIDER_MODELS];
      return c.json({
        object: 'list',
        data: allModels.map(attachProviderSpecs),
      });
    } catch {
      // If any fetch fails, still return provider models
      return c.json({
        object: 'list',
        data: PROVIDER_MODELS.map(attachProviderSpecs),
      });
    }
  },
);

// Start server
if (import.meta.main) {
  // Enable per-request file logging
  logStore.enableRequestFileLogging(projectPath('.logs'));

  // Auto-configure Claude Code proxy if toggled on
  updateClaudeCodeSettings(config.getAll());

  const port = config.getPort();
  const hostArg = process.argv.indexOf('--host');
  const host = hostArg !== -1 && process.argv[hostArg + 1] ? process.argv[hostArg + 1] : config.get('HOST') || 'localhost';

  // Show banner immediately on startup
  process.stdout.write(`\x1b[31m
████████▄    ▄█     █▄     ▄████████ ███▄▄▄▄
███    ███  ███     ███   ███    ███ ███▀▀▀██▄
███    ███  ███     ███   ███    █▀  ███   ███
███    ███  ███     ███  ▄███▄▄▄     ███   ███
███    ███  ███     ███ ▀▀███▀▀▀     ███   ███
███    ███  ███     ███   ███    █▄  ███   ███
███  ▀ ███  ███ ▄█▄ ███   ███    ███ ███   ███
 ▀██████▀▄█  ▀███▀███▀    ██████████  ▀█   █▀

   ▄██████▄     ▄████████     ███        ▄████████
  ███    ███   ███    ███ ▀█████████▄   ███    ███
  ███    █▀    ███    ███    ▀███▀▀██   ███    █▀
 ▄███          ███    ███     ███   ▀  ▄███▄▄▄
▀▀███ ████▄  ▀███████████     ███     ▀▀███▀▀▀
  ███    ███   ███    ███     ███       ███    █▄
  ███    ███   ███    ███     ███       ███    ███
  ████████▀    ███    █▀     ▄████▀     ██████████

  \x1b[0m\x1b[32m●\x1b[0m Host: ${host}
  \x1b[32m●\x1b[0m Port: ${port}
  \x1b[32m●\x1b[0m API: ${host}:${port}/v1
  \x1b[32m●\x1b[0m Dashboard: http://${host}:${port}/dashboard (Ctrl+Click)\x1b[0m
  `);

  async function startServer() {
    // ── Phase 1: Start HTTP server FIRST so dashboard is live immediately ──
    const createServer = async function (p: number, h: string) {
      if (isBun) {
        const bunServer = Bun.serve({
          fetch: app.fetch,
          port: p,
          hostname: h,
          idleTimeout: 0,
        });
        serverStop = () => bunServer.stop(false);
      } else {
        const { serve } = await import('@hono/node-server');
        const nodeServer = serve({
          fetch: app.fetch,
          port: p,
          hostname: h,
          serverOptions: {
            requestTimeout: 600_000,
            keepAliveTimeout: 75_000,
            headersTimeout: 65_000,
          },
        });
        serverStop = () => new Promise<void>((resolve) => nodeServer.close(() => resolve()));
      }
    };

    try {
      await createServer(port, host);
    } catch (err: any) {
      if (err.code === 'EADDRINUSE') {
        const fallbackPort = port + 1;
        logStore.log('debug', 'server', `Port ${port} in use, trying ${fallbackPort}...`);
        await createServer(fallbackPort, host);
      } else {
        throw err;
      }
    }

    // Pre-warm DNS and TCP connection to Qwen upstream
    if (isBun) {
      try {
        // @ts-ignore — Bun-specific API
        Bun.dns?.prefetch?.('chat.qwen.ai', 443);
        // @ts-ignore
        fetch.preconnect?.('https://chat.qwen.ai');
        logStore.log('info', 'boot', 'DNS prefetch + TCP preconnect initiated');
      } catch {
        // Not all Bun versions support these — silently skip
      }
    }

    const pidFile = projectPath('.auth', 'gate.pid');
    try {
      writeFileSync(pidFile, String(process.pid));
    } catch {
      /* best effort */
    }
    logStore.log('info', 'server', `Server started on ${host}:${port}`);

    if (config.getBool('OPEN_DASHBOARD_ON_START')) {
      const { exec } = await import('child_process');
      const url = `http://localhost:${port}/dashboard`;
      const cmd =
        process.platform === 'darwin' ? `open "${url}"` : process.platform === 'win32' ? `start "" "${url}"` : `xdg-open "${url}"`;
      exec(cmd);
      logStore.log('info', 'server', `Opening dashboard at ${url}`);
    }
    startAutoCleanup();

    logStore.log('info', 'boot', 'Dashboard live — starting background initialization...');

    // ── Phase 2: Auth + post-boot tasks ──
    (async () => {
      logStore.log('info', 'boot', '[1/5] Authenticating accounts...');
      try {
        await initAuth();
        logStore.log('info', 'boot', '[1/5] Accounts authenticated');
        for (const acct of getAccounts()) {
          setStartupStatus(acct.email, 'pending');
        }
      } catch (err: any) {
        logStore.log('warn', 'boot', `[1/5] initAuth failed: ${err.message}`);
      }

      // ── Phase 2b: Configure loaded accounts ──
      logStore.log('info', 'boot', '[2/5] Configuring accounts...');
      try {
        const acctList = getAccounts().filter((a) => a.providerStates.qwen?.token);
        for (const acct of acctList) {
          setStartupStatus(acct.email, 'ready');
          configureAccount(acct.email).catch((err: any) =>
            logStore.log('warn', 'boot', `[2/5] Account config failed for ${acct.email}: ${err.message}`),
          );
        }
        logStore.log('info', 'boot', `[2/5] Accounts configured: ${acctList.length} ready`);
      } catch (err: any) {
        logStore.log('warn', 'boot', `[2/5] Configure failed: ${err.message}`);
      }

      logStore.log('info', 'boot', '[3/5] Headers ready (browserless — no pre-warm needed)');

      logStore.log('info', 'boot', 'Background initialization complete');
    })().catch((err) => {
      logStore.log('error', 'boot', `Background init error: ${err.message}`);
    });
  }

  startServer().catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}
