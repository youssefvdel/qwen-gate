import { existsSync, readFileSync } from 'fs';
import { Hono } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import { resolve } from 'path';
import {
  getAccountCount,
  getAccountStats,
  getAllAccountEmails,
  getAvailableCount,
  getProviderPoolStats,
  initAuth,
} from '../../services/auth.ts';
import { config, isValidKey } from '../../services/configService.ts';
import { logStore } from '../../services/logStore.ts';
import { monitorStore } from '../../services/monitorStore.ts';
import { configureAccount, deleteAllChats } from '../../services/qwen.ts';
import { sessionPool } from '../../services/sessionPool.ts';
import { checkApiKeyAuth } from '../../utils/auth.ts';
import { projectPath } from '../../utils/paths.ts';
import { APP_VERSION } from '../../utils/version.ts';
import { monitorHtml } from './monitor.ts';
import { networkHtml } from './network.ts';
import { overviewHtml } from './overview.ts';
import { getProviderKeys, getProviderPageHtml, providersListHtml } from './providers.ts';
import { settingsHtml } from './settings.ts';

const serveHtml = (html: string) => (c: any) => {
  // Dashboard HTML pages always serve — they're localhost admin UI.
  // API_KEY protection applies only to data endpoints (handled by requireApiKey/bearerAuth).
  // The front-end JS injects Authorization: Bearer <key> via window.API_KEY for data fetches.
  const darkMode = config.get('DARK_MODE') === 'true';
  const scriptInjection = `<script>\nwindow.APP_VERSION = ${JSON.stringify(APP_VERSION)};\nwindow.API_KEY = ${JSON.stringify(config.get('API_KEY'))};\nwindow.DARK_MODE = ${JSON.stringify(darkMode)};\n</script>\n`;
  // Apply dark-mode class on <html> server-side to prevent flash on page navigation
  let output = html.replace(/(<script\b)/, scriptInjection + '$1');
  if (darkMode) {
    output = output.replace('<html lang="en">', '<html lang="en" class="dark-mode">');
  }
  c.header(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:;",
  );
  return c.html(output);
};

function dashboardStaticHandler(c: any) {
  const file = c.req.param('file');
  if (!/^[a-z0-9_-]+\.(css|js|svg|png|jpe?g|webp)$/i.test(file)) return c.json({ error: 'Invalid file' }, 400);
  const DASHBOARD_STATIC = projectPath('src', 'routes', 'dashboard', 'public');
  const filePath = resolve(DASHBOARD_STATIC, file);
  if (!filePath.startsWith(DASHBOARD_STATIC) || !existsSync(filePath)) return c.json({ error: 'Not found' }, 404);
  const ext = file.split('.').pop() || '';
  const textTypes = ['css', 'js', 'svg'];
  if (textTypes.includes(ext)) {
    const mime: Record<string, string> = { css: 'text/css', js: 'application/javascript', svg: 'image/svg+xml' };
    return c.text(readFileSync(filePath, 'utf-8'), 200, { 'Content-Type': mime[ext] || 'text/plain' });
  }
  // Binary image files
  const imgMime: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
  return c.body(readFileSync(filePath), 200, { 'Content-Type': imgMime[ext] || 'application/octet-stream' });
}

function healthHandler(c: any) {
  const poolOk = getAvailableCount() > 0;
  return c.json(
    {
      status: poolOk ? 'ok' : 'degraded',
      pool: poolOk,
      accounts: { total: getAccountCount(), available: getAvailableCount() },
      uptime: process.uptime(),
    },
    200,
  );
}

async function accountsReloadHandler(c: any) {
  try {
    await initAuth(async (email) => {
      logStore.log('info', 'account', `Reloading ${email}`);
      await configureAccount(email);
    });
    logStore.log('info', 'auth', 'Accounts reloaded');
    return c.json({ ok: true });
  } catch (err: any) {
    logStore.log('error', 'auth', `Reload failed: ${err.message}`);
    return c.json({ error: err.message }, 500);
  }
}

async function deleteAllChatsHandler(c: any) {
  const emails = getAllAccountEmails();
  if (!emails || emails.length === 0) return c.json({ error: 'No accounts configured' }, 400);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let deleted = 0;
      const errors: string[] = [];
      const maskEmail = (e: string) => {
        const at = e.indexOf('@');
        return at > 0 ? e.slice(0, Math.min(at, 3)) + '***' + e.slice(at) : e;
      };
      for (const email of emails) {
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: 'progress', email: maskEmail(email), status: 'deleting' })}\n\n`),
          );
          await deleteAllChats(email);
          deleted++;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'progress', email: maskEmail(email), status: 'done' })}\n\n`));
        } catch (err: any) {
          errors.push(`${maskEmail(email)}: ${err.message}`);
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: 'progress', email: maskEmail(email), status: 'error', error: err.message })}\n\n`,
            ),
          );
        }
      }
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({ type: 'result', ok: true, deleted, total: emails.length, errors: errors.length ? errors : undefined })}\n\n`,
        ),
      );
      controller.close();
    },
  });

  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
  });
}

function sanitizeLogEntry(entry: any): any {
  const sanitized = { ...entry };

  // Mask email addresses (keep first 3 chars)
  if (sanitized.account) {
    const [local, domain] = sanitized.account.split('@');
    sanitized.account = local.substring(0, 3) + '***@' + (domain || '***');
  }

  // Mask prompt content that might contain credentials
  if (sanitized.input?.messages) {
    sanitized.input = {
      ...sanitized.input,
      messages: sanitized.input.messages.map((m: any) => {
        if (typeof m.content === 'string' && m.content.length > 200) {
          return { ...m, content: m.content.substring(0, 200) + '...[truncated]' };
        }
        return m;
      }),
    };
  }

  // Truncate long text fields that may contain sensitive data
  for (const field of ['rawFullContent', 'processedApiOutput', 'remainingText', 'amplificationTriggeredInput', 'rawResponse', 'input']) {
    if (typeof sanitized[field] === 'string' && sanitized[field].length > 500) {
      sanitized[field] = sanitized[field].substring(0, 500) + '...[truncated]';
    }
  }

  // Truncate raw_output and proccessed_output
  if (sanitized.raw_output && sanitized.raw_output.length > 1000) {
    sanitized.raw_output = sanitized.raw_output.substring(0, 1000) + '...[truncated]';
  }
  if (sanitized.proccessed_output && sanitized.proccessed_output.length > 1000) {
    sanitized.proccessed_output = sanitized.proccessed_output.substring(0, 1000) + '...[truncated]';
  }
  // Truncate thinking_content
  if (sanitized.thinking_content && sanitized.thinking_content.length > 2000) {
    sanitized.thinking_content = sanitized.thinking_content.substring(0, 2000) + '...[truncated]';
  }

  return sanitized;
}

function systemLogsHandler(c: any) {
  const limit = parseInt(c.req.query('limit') || '100', 10);
  const category = c.req.query('category');
  const minLevel = c.req.query('level') as 'debug' | 'info' | 'warn' | 'error' | undefined;
  const logs = logStore.getSystemLogs({ limit, category, minLevel });
  return c.json(logs.map(sanitizeLogEntry));
}

function modelHealthHandler(c: any) {
  return c.json(logStore.getAllModelHealth());
}

function monitorHandler(c: any) {
  try {
    return c.json(monitorStore.getSummary());
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
}

function logStreamHandler(c: any) {
  return new Response(
    new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        let alive = true;
        const safeEnqueue = (data: string): boolean => {
          if (!alive) return false;
          try {
            controller.enqueue(encoder.encode(data));
            return true;
          } catch {
            alive = false;
            return false;
          }
        };

        for (const entry of logStore.getRecent(50)) {
          if (!safeEnqueue(`data: ${JSON.stringify(sanitizeLogEntry(entry))}\n\n`)) break;
        }

        const heartbeat = setInterval(() => {
          if (!alive) {
            clearInterval(heartbeat);
            return;
          }
          if (!safeEnqueue(': ping\n\n')) {
            clearInterval(heartbeat);
          }
        }, 15000);
        heartbeat.unref();

        const unsub = logStore.subscribe((entry) => {
          if (!safeEnqueue(`data: ${JSON.stringify(sanitizeLogEntry(entry))}\n\n`)) {
            unsub();
            clearInterval(heartbeat);
            try {
              controller.close();
            } catch {
              /* stream already lost */
            }
          }
        });

        const signal = c.req.raw?.signal;
        if (signal) {
          signal.addEventListener('abort', () => {
            alive = false;
            unsub();
            clearInterval(heartbeat);
            try {
              controller.close();
            } catch {
              /* stream already lost */
            }
          });
        }
      },
    }),
    {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    },
  );
}

function logJsonHandler(c: any) {
  const limit = parseInt(c.req.query('limit') || '50', 10);
  const entries = logStore.getRecent(Math.max(1, Math.min(limit, 500)));
  const serialized = entries.map((e) => {
    const toolCalls = (e.parsedToolCalls || []).map((tc) => {
      let args: unknown = tc.args;
      try {
        args = JSON.parse(tc.args);
      } catch {
        /* keep as string */
      }
      return { name: tc.name, arguments: args };
    });
    return {
      id: e.id,
      timestamp: e.timestamp,
      account: e.accountEmail,
      model: e.model,
      finish_reason: e.finalResponse?.finishReason || null,
      stream: e.stream,
      latency_ms: e.latency_ms,
      thinking_content: e.reasoningContent || '',
      raw_output: e.rawFullContent || '',
      proccessed_output: e.processedApiOutput || '',
      tool_call_count: toolCalls.length,
      tool_calls: toolCalls,
      errors: e.errors || [],
      chunks: e.qwenRawChunks || [],
      input: e.clientRequest || {},
    };
  });
  return c.json(serialized.map(sanitizeLogEntry));
}

function requireApiKey(c: any, next: () => Promise<void>) {
  const denied = checkApiKeyAuth(c);
  if (denied) return denied;
  return next();
}

// ── GLM model fetch ──
async function fetchGlmModels(): Promise<Array<{ id: string; name: string; description: string }>> {
  try {
    const { getProviderToken } = await import('../../services/accountManager.ts');
    const token = getProviderToken('glm');
    if (!token) return [];

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept-Language': 'en-US',
      'X-FE-Version': 'prod-fe-1.1.69',
      'x-region': 'overseas',
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
    };

    // GLM returns { data: [{ id, name, info: { meta: { description } } }, ...] }
    const res = await fetch('https://chat.z.ai/api/models', { headers });
    if (!res.ok) return [];
    const body = await res.json();
    const models = body?.data;
    if (!Array.isArray(models)) return [];

    return models
      .map((m: any) => ({
        id: m.id || m.name || String(m),
        name: m.name || m.id || String(m),
        description: m.info?.meta?.description || m.description || '',
      }))
      .filter((m: { id: string }) => m.id);
  } catch {
    return [];
  }
}

// ── DeepSeek model fetch ──
async function fetchDeepseekModels(): Promise<Array<{ id: string; name: string; description: string }>> {
  try {
    const { getProviderToken } = await import('../../services/accountManager.ts');
    const token = getProviderToken('deepseek');
    if (!token) return [];

    const res = await fetch('https://chat.deepseek.com/api/v0/models', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (!res.ok) {
      const res2 = await fetch('https://api.deepseek.com/models', {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });
      if (!res2.ok) return [];
      const data = await res2.json();
      return (data?.data || []).map((m: any) => ({
        id: m.id || String(m),
        name: m.id || String(m),
        description: m.description || m.object || '',
      }));
    }
    const data = await res.json();
    const models = data.models || data.data || data;
    if (Array.isArray(models)) {
      return models.map((m: any) => ({
        id: m.id || String(m),
        name: m.id || m.name || String(m),
        description: m.description || '',
      }));
    }
    return [];
  } catch {
    return [];
  }
}

export function registerDashboardRoutes(app: Hono): void {
  app.get('/dashboard', serveHtml(overviewHtml));
  app.get('/dashboard/accounts', (c) => c.redirect('/dashboard/providers'));
  app.get('/dashboard/network', serveHtml(networkHtml));
  app.get('/dashboard/settings', serveHtml(settingsHtml));
  app.get('/dashboard/monitor', serveHtml(monitorHtml));

  // Provider management pages
  app.get('/dashboard/providers', serveHtml(providersListHtml));
  const providerKeys = getProviderKeys();
  for (const key of providerKeys) {
    const html = getProviderPageHtml(key);
    if (html) {
      app.get(`/dashboard/providers/${key}`, serveHtml(html));
    }
  }

  app.get('/dashboard/static/:file', dashboardStaticHandler);

  // ── Models API ──
  app.get(
    '/api/models/:provider',
    async (c, next) => requireApiKey(c, next),
    async (c) => {
      const provider = c.req.param('provider').toLowerCase();
      try {
        if (provider === 'qwen') {
          const { fetchQwenModels } = await import('../../services/qwenModels.ts');
          const models = await fetchQwenModels();
          return c.json(models.map((m: any) => ({ id: m.id, name: m.id, description: m.description || '' })));
        } else if (provider === 'deepseek') {
          const models = await fetchDeepseekModels();
          return c.json(
            models.length > 0
              ? models
              : [
                  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', description: 'Default model — fast and efficient' },
                  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', description: 'Expert model with enhanced reasoning' },
                ],
          );
        } else if (provider === 'glm') {
          const models = await fetchGlmModels();
          return c.json(
            models.length > 0
              ? models
              : [
                  { id: 'glm-4.7', name: 'GLM-4.7', description: 'Latest general-purpose model' },
                  { id: 'glm-4v', name: 'GLM-4V', description: 'Vision-capable multimodal model' },
                ],
          );
        } else {
          return c.json({ error: 'Unknown provider' }, 400);
        }
      } catch (err: any) {
        return c.json({ error: err.message }, 500);
      }
    },
  );

  app.get('/', (c) => c.redirect('/dashboard'));
  app.get('/health', healthHandler);
  app.get(
    '/accounts',
    async (c, next) => requireApiKey(c, next),
    (c) => {
      return c.json(getAccountStats());
    },
  );
  app.get(
    '/pool/stats',
    async (c, next) => requireApiKey(c, next),
    (c) => {
      const qwen = sessionPool.getStats();
      // Non-pool providers surface as pool-style stats (accounts with valid
      // tokens / currently serving) so the Session Pool panel shows them too.
      const deepseek = getProviderPoolStats('deepseek');
      return c.json({
        ...qwen,
        providers: { qwen, deepseek },
      });
    },
  );

  app.post(
    '/admin/accounts/reload',
    async (c, next) => {
      const apiKey = config.get('API_KEY');
      if (!apiKey) return await next();
      return bearerAuth({ token: apiKey })(c, next);
    },
    accountsReloadHandler,
  );
  app.post(
    '/dashboard/accounts/delete-all-chats',
    async (c, next) => {
      const apiKey = config.get('API_KEY');
      if (!apiKey) return await next();
      return bearerAuth({ token: apiKey })(c, next);
    },
    deleteAllChatsHandler,
  );

  app.get('/system/logs', async (c, next) => requireApiKey(c, next), systemLogsHandler);
  app.get('/metrics/model-health', async (c, next) => requireApiKey(c, next), modelHealthHandler);
  app.get('/metrics/monitor', async (c, next) => requireApiKey(c, next), monitorHandler);

  app.get('/log', (c) => c.redirect('/dashboard'));

  app.patch(
    '/api/accounts/:email',
    async (c, next) => requireApiKey(c, next),
    async (c) => {
      try {
        const body = await c.req.json();
        const mod = await import('../../services/accountManager.ts');
        if (body.disabled !== undefined) {
          mod.setAccountDisabled(c.req.param('email'), body.disabled === true);
        }
        if (body.disabledProviders !== undefined) {
          // Clear account-level disabled, then sync provider disabled list
          mod.setAccountDisabled(c.req.param('email'), false);
          for (const p of body.disabledProviders) {
            mod.setProviderDisabled(c.req.param('email'), p, true);
          }
          // Clear any providers that were removed from the list
          const acct = mod.getAccountByEmail(c.req.param('email'));
          if (acct?.disabledProviders) {
            for (const existing of [...acct.disabledProviders]) {
              if (!body.disabledProviders.includes(existing)) {
                mod.setProviderDisabled(c.req.param('email'), existing, false);
              }
            }
          }
        }
        return c.json({ ok: true });
      } catch (err: any) {
        return c.json({ error: err.message }, 404);
      }
    },
  );

  app.get(
    '/api/accounts/:email/login/deepseek',
    async (c, next) => requireApiKey(c, next),
    async (c) => {
      try {
        const email = c.req.param('email');
        const { getAccountByEmail, setProviderState } = await import('../../services/accountManager.ts');
        const acct = getAccountByEmail(email);
        if (!acct) return c.json({ error: 'Account not found' }, 404);

        // Launch headless:false — user must complete captcha manually
        const { loginDeepSeekManual } = await import('../../services/deepseekLogin.ts');

        loginDeepSeekManual(email, acct.password).then((result) => {
          if (result) {
            setProviderState(email, 'deepseek', result);
          }
        });

        return c.json({ ok: true, message: `Browser opened for ${email}. Complete login in the browser window.` });
      } catch (err: any) {
        return c.json({ error: err.message }, 500);
      }
    },
  );

  app.get(
    '/api/accounts/:email/login/glm',
    async (c, next) => requireApiKey(c, next),
    async (c) => {
      try {
        const email = c.req.param('email');
        const { getAccountByEmail, setProviderState } = await import('../../services/accountManager.ts');
        const acct = getAccountByEmail(email);
        if (!acct) return c.json({ error: 'Account not found' }, 404);

        // Launch headless:false — user must complete captcha manually
        const { loginGlmManual } = await import('../../services/glmLogin.ts');

        // Run async — return immediately, let the user poll for completion
        loginGlmManual(email, acct.password).then((result) => {
          if (result) {
            setProviderState(email, 'glm', result);
          }
        });

        return c.json({ ok: true, message: `Browser opened for ${email}. Complete login in the browser window.` });
      } catch (err: any) {
        return c.json({ error: err.message }, 500);
      }
    },
  );

  app.get(
    '/api/accounts/:email/auto-login/deepseek',
    async (c, next) => requireApiKey(c, next),
    async (c) => {
      try {
        const email = c.req.param('email');
        const { getAccountByEmail, setProviderState, setProviderStateLastError } = await import('../../services/accountManager.ts');
        const acct = getAccountByEmail(email);
        if (!acct) return c.json({ error: 'Account not found' }, 404);

        const { loginDeepseekAuto } = await import('../../services/deepseekLogin.ts');

        const result = await loginDeepseekAuto(email, acct.password);
        if (result.status === 'success' && result.result) {
          setProviderStateLastError(email, 'deepseek', null);
          setProviderState(email, 'deepseek', result.result);
          return c.json({ ok: true, status: 'success' });
        } else if (result.status === 'captcha') {
          setProviderStateLastError(email, 'deepseek', 'captcha: bot detection on auto-login');
          return c.json({ ok: true, status: 'captcha', message: 'CAPTCHA or bot detection — click Login for manual browser' });
        } else {
          setProviderStateLastError(email, 'deepseek', 'auto-login failed');
          return c.json({ ok: true, status: 'error', message: 'Auto-login failed — click Login for manual browser' });
        }
      } catch (err: any) {
        return c.json({ error: err.message }, 500);
      }
    },
  );

  app.get(
    '/api/accounts/:email/auto-login/glm',
    async (c, next) => requireApiKey(c, next),
    async (c) => {
      try {
        const email = c.req.param('email');
        const { getAccountByEmail, setProviderState, setProviderStateLastError } = await import('../../services/accountManager.ts');
        const acct = getAccountByEmail(email);
        if (!acct) return c.json({ error: 'Account not found' }, 404);

        const { loginGlmAuto } = await import('../../services/glmLogin.ts');

        const result = await loginGlmAuto(email, acct.password);
        if (result.status === 'success' && result.result) {
          setProviderStateLastError(email, 'glm', null);
          setProviderState(email, 'glm', result.result);
          return c.json({ ok: true, status: 'success' });
        } else if (result.status === 'captcha') {
          setProviderStateLastError(email, 'glm', 'captcha: bot detection on auto-login');
          return c.json({ ok: true, status: 'captcha', message: 'CAPTCHA or bot detection — click Login for manual browser' });
        } else {
          setProviderStateLastError(email, 'glm', 'auto-login failed');
          return c.json({ ok: true, status: 'error', message: 'Auto-login failed — click Login for manual browser' });
        }
      } catch (err: any) {
        return c.json({ error: err.message }, 500);
      }
    },
  );

  app.delete(
    '/api/accounts/:email/provider/:provider',
    async (c, next) => requireApiKey(c, next),
    async (c) => {
      try {
        const email = c.req.param('email');
        const provider = c.req.param('provider');
        const { removeProviderFromAccount } = await import('../../services/accountManager.ts');
        const result = await removeProviderFromAccount(email, provider);
        return c.json({ ok: true, accountDeleted: result.accountDeleted });
      } catch (err: any) {
        return c.json({ error: err.message }, err.message.includes('not found') ? 404 : 500);
      }
    },
  );

  app.get('/log/json', async (c, next) => requireApiKey(c, next), logJsonHandler);
  app.get('/log/stream', async (c, next) => requireApiKey(c, next), logStreamHandler);
  app.get(
    '/metrics/uptime',
    async (c, next) => requireApiKey(c, next),
    (c) => {
      return c.json({ uptimeSeconds: logStore.getUptimeSeconds() });
    },
  );

  app.get(
    '/api/config',
    async (c, next) => requireApiKey(c, next),
    (c) => {
      const all = config.getAll();
      const safe = Object.fromEntries(Object.entries(all).filter(([k]) => !['API_KEY'].includes(k)));
      return c.json({ config: safe });
    },
  );

  app.put(
    '/api/config',
    async (c, next) => requireApiKey(c, next),
    async (c) => {
      try {
        const body = await c.req.json();
        let changed = false;
        for (const key of Object.keys(body)) {
          if (typeof body[key] === 'string' && isValidKey(key)) {
            config.set(key, body[key]);
            changed = true;
          }
        }
        if (changed) config.save();
        const all = config.getAll();
        const safe = Object.fromEntries(Object.entries(all).filter(([k]) => !['API_KEY'].includes(k)));
        return c.json({ config: safe });
      } catch {
        return c.json({ error: 'invalid request body' }, 400);
      }
    },
  );
}
