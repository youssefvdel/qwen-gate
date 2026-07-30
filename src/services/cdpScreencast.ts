/**
 * CDP Screencast Service
 * Launches Chrome with --remote-debugging-port, connects via CDP,
 * streams viewport frames over WebSocket, relays input events back.
 */

import { spawn, execFileSync, type ChildProcess } from 'child_process';
import { existsSync, rmSync } from 'fs';
import WebSocket from 'ws';
import { logStore } from './logStore.ts';
import { getProfileDir } from './browserProfiles.ts';

export interface ScreencastSession {
  email: string;
  debugPort: number;
  chromeProcess: ChildProcess;
  cdpWs: WebSocket | null;
  clients: Set<WebSocket>;
  viewportWidth: number;
  viewportHeight: number;
  pageId: string | null;
  closed: boolean;
  loginCheckInterval: ReturnType<typeof setInterval> | null;
}

const sessions = new Map<string, ScreencastSession>();

let _cachedChromeBin: string | null = null;
function findChromeBinary(): string {
  if (_cachedChromeBin) return _cachedChromeBin;
  const home = process.env.HOME || '/home/youssefsrv';
  const candidates = [
    `${home}/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`,
    `${home}/.cache/puppeteer/chrome/linux-150.0.7871.24/chrome-linux64/chrome`,
    'chromium-browser',
    'chromium',
    'google-chrome',
    'google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
  ];
  for (const bin of candidates) {
    try {
      execFileSync(bin, ['--version'], { stdio: 'ignore' });
      _cachedChromeBin = bin;
      return bin;
    } catch {}
  }
  // Fallback: try to find any chrome binary
  try {
    const result = execFileSync('find', [`${home}/.cache`, '-name', 'chrome', '-executable', '-type', 'f'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const lines = result.trim().split('\n');
    if (lines.length > 0 && lines[0]) {
      _cachedChromeBin = lines[0].trim();
      return _cachedChromeBin;
    }
  } catch {}
  return 'chromium-browser';
}

export async function startScreencast(
  email: string,
  password: string,
  wsClient: WebSocket,
): Promise<{ debugPort: number } | { error: string }> {
  if (sessions.has(email)) {
    const existing = sessions.get(email)!;
    if (!existing.closed) {
      existing.clients.add(wsClient);
      return { debugPort: existing.debugPort };
    }
    cleanupSession(email);
  }

  const profileDir = getProfileDir(email);
  // Clean up stale singleton locks from previous browser sessions
  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try {
      const f = `${profileDir}/${name}`;
      if (existsSync(f)) rmSync(f, { recursive: true });
    } catch {}
  }
  const chromeBin = findChromeBinary();
  const debugPort = 9222 + Math.floor(Math.random() * 1000);

  logStore.log('info', 'screencast', `Starting Chrome for ${email} on debug port ${debugPort} (bin: ${chromeBin})`);

  const chromeProcess = spawn(chromeBin, [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profileDir}`,
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-gpu',
    '--headless=new',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-software-rasterizer',
    '--window-size=1280,800',
    'about:blank',
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' },
  });

  chromeProcess.stderr?.on('data', (data: Buffer) => {
    const msg = data.toString();
    logStore.log('debug', 'screencast', `Chrome stderr: ${msg.trim().slice(0, 200)}`);
    if (msg.includes('DevTools listening on')) {
      logStore.log('info', 'screencast', `Chrome ready: ${msg.trim()}`);
    }
  });

  chromeProcess.stdout?.on('data', (data: Buffer) => {
    logStore.log('debug', 'screencast', `Chrome stdout: ${data.toString().trim().slice(0, 200)}`);
  });

  chromeProcess.on('exit', (code) => {
    logStore.log('info', 'screencast', `Chrome exited for ${email} code=${code}`);
    const session = sessions.get(email);
    if (session) {
      session.closed = true;
      broadcastToClients(session, JSON.stringify({ type: 'browser_closed' }));
      cleanupSession(email);
    }
  });

  chromeProcess.on('error', (err) => {
    logStore.log('error', 'screencast', `Chrome spawn error for ${email}: ${err.message}`);
  });

  const session: ScreencastSession = {
    email,
    debugPort,
    chromeProcess,
    cdpWs: null,
    clients: new Set([wsClient]),
    viewportWidth: 1280,
    viewportHeight: 800,
    pageId: null,
    closed: false,
    loginCheckInterval: null,
  };
  sessions.set(email, session);

  // Wait for Chrome to be ready, then connect CDP
  const maxWait = 30000;
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      const resp = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
      if (resp.ok) {
        const data = (await resp.json()) as any;
        const wsUrl = data.webSocketDebuggerUrl;
        if (wsUrl) {
          logStore.log('info', 'screencast', `CDP endpoint found: ${wsUrl}`);
          await connectCDP(session, wsUrl);
          return { debugPort };
        }
      }
    } catch {
      // Chrome not ready yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  logStore.log('error', 'screencast', `Chrome failed to start for ${email} (waited ${maxWait}ms)`);
  cleanupSession(email);
  return { error: 'Chrome failed to start' };
}

async function connectCDP(session: ScreencastSession, wsUrl: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
    let msgId = 1;
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    let pageSessionId: string | null = null;

    function send(method: string, params?: any): Promise<any> {
      return new Promise((res, rej) => {
        const id = msgId++;
        pending.set(id, { resolve: res, reject: rej });
        const msg: any = { id, method, params };
        // If we have a page session, send to that session
        if (pageSessionId && !method.startsWith('Target.')) {
          msg.sessionId = pageSessionId;
        }
        ws.send(JSON.stringify(msg));
      });
    }

    ws.on('open', async () => {
      logStore.log('info', 'screencast', `CDP connected for ${session.email}`);
      session.cdpWs = ws;

      try {
        // Get targets to find the page
        const targets = await send('Target.getTargets');
        const page = targets.targetInfos?.find(
          (t: any) => t.type === 'page' && t.url.includes('chat.qwen.ai'),
        );
        if (!page) {
          const anyPage = targets.targetInfos?.find((t: any) => t.type === 'page');
          if (anyPage) {
            session.pageId = anyPage.targetId;
          } else {
            logStore.log('error', 'screencast', 'No page target found');
            reject(new Error('No page target found'));
            return;
          }
        } else {
          session.pageId = page.targetId;
        }

        // Attach to the page — get a session ID for flat mode
        const attachResult = await send('Target.attachToTarget', { targetId: session.pageId, flatten: true });
        pageSessionId = attachResult?.sessionId || null;
        if (!pageSessionId) {
          logStore.log('error', 'screencast', 'No session ID from attachToTarget');
          reject(new Error('No session ID from attachToTarget'));
          return;
        }
        logStore.log('info', 'screencast', `Attached to page, sessionId=${pageSessionId}`);
        // Store pageSessionId on WS so handleInputEvent can access it
        (ws as any)._pageSessionId = pageSessionId;

        // Enable needed domains (using page session)
        await send('Page.enable');
        await send('Runtime.enable');

        // Get page dimensions
        const layout = await send('Page.getLayoutMetrics');
        if (layout?.cssContentSize) {
          session.viewportWidth = Math.ceil(layout.cssContentSize.width);
          session.viewportHeight = Math.ceil(layout.cssContentSize.height);
        }

        // Start screencast
        await send('Page.startScreencast', {
          format: 'jpeg',
          quality: 60,
          maxWidth: 1280,
          maxHeight: 800,
          everyNthFrame: 1,
        });

        // Navigate to auth page
        await send('Page.navigate', { url: 'https://chat.qwen.ai/auth' });

        // Start polling for login completion
        startLoginPolling(session);

        logStore.log('info', 'screencast', `Screencast started for ${session.email}`);
        resolve();
      } catch (err: any) {
        logStore.log('error', 'screencast', `CDP setup failed: ${err.message}`);
        reject(err);
      }
    });

    ws.on('message', (data: Buffer) => {
      const msg = JSON.parse(data.toString());

      // Handle CDP responses
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id)!;
        pending.delete(msg.id);
        if (msg.error) {
          p.reject(new Error(msg.error.message));
        } else {
          p.resolve(msg.result);
        }
        return;
      }

      // Handle screencast frames
      if (msg.method === 'Page.screencastFrame') {
        const frame = msg.params;
        broadcastToClients(
          session,
          JSON.stringify({
            type: 'frame',
            data: frame.data, // base64 JPEG
            sessionId: frame.sessionId,
            offsetTop: frame.offsetTop,
            offsetLeft: frame.offsetLeft,
            width: frame.width,
            height: frame.height,
          }),
        );
        // Acknowledge frame to get next one
        send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
      }

      // Handle page navigated (login complete)
      if (msg.method === 'Page.frameNavigated') {
        const url = msg.params?.frame?.url || '';
        // Skip initial about:blank and about:srcdoc — only detect post-auth navigations
        if (url && !url.startsWith('about:') && url.includes('chat.qwen.ai') && !url.includes('/auth')) {
          logStore.log('info', 'screencast', `Login complete for ${session.email} — navigated to ${url}`);
          broadcastToClients(session, JSON.stringify({ type: 'login_complete' }));
          setTimeout(() => cleanupSession(session.email), 2000);
        }
      }
    });

    ws.on('close', () => {
      logStore.log('info', 'screencast', `CDP connection closed for ${session.email}`);
      session.cdpWs = null;
    });

    ws.on('error', (err) => {
      logStore.log('error', 'screencast', `CDP error: ${err.message}`);
    });
  });
}

function startLoginPolling(session: ScreencastSession): void {
  session.loginCheckInterval = setInterval(async () => {
    if (session.closed || !session.cdpWs || session.cdpWs.readyState !== WebSocket.OPEN) {
      if (session.loginCheckInterval) clearInterval(session.loginCheckInterval);
      return;
    }

    try {
      const result = await cdpSend(session, 'Network.getCookies', { urls: ['https://chat.qwen.ai'] });
      const tokenCookie = result?.cookies?.find((c: any) => c.name === 'token');
      if (tokenCookie && tokenCookie.expires && tokenCookie.expires * 1000 > Date.now()) {
        logStore.log('info', 'screencast', `Token found for ${session.email} — login successful`);
        const { saveCookies } = await import('./auth.ts');
        const refreshCookie = result.cookies.find((c: any) => c.name.toLowerCase().includes('refresh'));
        await saveCookies(session.email, tokenCookie.value, refreshCookie?.value);

        broadcastToClients(session, JSON.stringify({ type: 'login_complete' }));
        setTimeout(() => cleanupSession(session.email), 2000);
      }
    } catch {
      // Ignore polling errors
    }
  }, 2000);
}

let cdpMsgId = 1000;
async function cdpSend(session: ScreencastSession, method: string, params?: any): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!session.cdpWs || session.cdpWs.readyState !== WebSocket.OPEN) {
      reject(new Error('CDP not connected'));
      return;
    }
    const id = cdpMsgId++;
    const timeout = setTimeout(() => reject(new Error('CDP timeout')), 5000);

    const handler = (data: Buffer) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === id) {
        clearTimeout(timeout);
        session.cdpWs!.off('message', handler);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    };
    session.cdpWs.on('message', handler);
    session.cdpWs.send(JSON.stringify({ id, method, params }));
  });
}

function getVirtualKeyCode(key: string, code: string): number {
  // Map common keys to their virtual key codes (Windows ABI)
  const map: Record<string, number> = {
    Backspace: 8, Tab: 9, Enter: 13, Shift: 16, Control: 17, Alt: 18,
    CapsLock: 20, Escape: 27, ' ': 32, PageUp: 33, PageDown: 34,
    End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
    Insert: 45, Delete: 46,
    '0': 48, '1': 49, '2': 50, '3': 51, '4': 52, '5': 53,
    '6': 54, '7': 55, '8': 56, '9': 57,
    a: 65, b: 66, c: 67, d: 68, e: 69, f: 70, g: 71, h: 72, i: 73,
    j: 74, k: 75, l: 76, m: 77, n: 78, o: 79, p: 80, q: 81, r: 82,
    s: 83, t: 84, u: 85, v: 86, w: 87, x: 88, y: 89, z: 90,
    Meta: 91, F1: 112, F2: 113, F3: 114, F4: 115, F5: 116, F6: 117,
    F7: 118, F8: 119, F9: 120, F10: 121, F11: 122, F12: 123,
    NumLock: 144, ScrollLock: 145, ';': 186, '=': 187, ',': 188,
    '-': 189, '.': 190, '/': 191, '`': 192, '[': 219, '\\': 220,
    ']': 221, "'": 222,
  };
  if (map[key] != null) return map[key];
  // Fallback: try code string
  const codeMap: Record<string, number> = {
    Digit0: 48, Digit1: 49, Digit2: 50, Digit3: 51, Digit4: 52,
    Digit5: 53, Digit6: 54, Digit7: 55, Digit8: 56, Digit9: 57,
    Numpad0: 96, Numpad1: 97, Numpad2: 98, Numpad3: 99, Numpad4: 100,
    Numpad5: 101, Numpad6: 102, Numpad7: 103, Numpad8: 104, Numpad9: 105,
    NumpadAdd: 107, NumpadSubtract: 109, NumpadMultiply: 106, NumpadDivide: 111,
    NumpadDecimal: 110, NumpadEnter: 13,
  };
  return codeMap[code] || 0;
}

export function handleInputEvent(
  email: string,
  event: { type: string; x: number; y: number; button?: number; key?: string; code?: string; text?: string },
): void {
  const session = sessions.get(email);
  if (!session || session.closed || !session.cdpWs || session.cdpWs.readyState !== WebSocket.OPEN) return;

  // Get the page sessionId from the CDP connection — required for flatten mode
  const sessionId = (session.cdpWs as any)._pageSessionId;
  if (!sessionId) return; // Page not attached yet

  const cdp = session.cdpWs;
  let msgId = 2000;

  function send(method: string, params: any) {
    cdp.send(JSON.stringify({ id: msgId++, method, params, sessionId }));
  }

  switch (event.type) {
    case 'click':
      send('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: event.x, y: event.y,
        button: event.button === 2 ? 'right' : 'left', clickCount: 1,
      });
      send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: event.x, y: event.y,
        button: event.button === 2 ? 'right' : 'left', clickCount: 1,
      });
      break;
    case 'mousemove':
      send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: event.x, y: event.y });
      break;
    case 'mousedown':
      send('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: event.x, y: event.y,
        button: event.button === 2 ? 'right' : 'left', clickCount: 1,
      });
      break;
    case 'mouseup':
      send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: event.x, y: event.y,
        button: event.button === 2 ? 'right' : 'left', clickCount: 1,
      });
      break;
    case 'keydown': {
      const vk = getVirtualKeyCode(event.key || '', event.code || '');
      send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: event.key || '',
        code: event.code || '',
        windowsVirtualKeyCode: vk,
        nativeVirtualKeyCode: vk,
        text: event.text || '',
        unmodifiedText: event.text || '',
      });
      break;
    }
    case 'keyup': {
      const vk = getVirtualKeyCode(event.key || '', event.code || '');
      send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: event.key || '',
        code: event.code || '',
        windowsVirtualKeyCode: vk,
        nativeVirtualKeyCode: vk,
      });
      break;
    }
    case 'keypress':
      send('Input.dispatchKeyEvent', {
        type: 'char',
        text: event.text || '',
        unmodifiedText: event.text || '',
      });
      break;
    case 'scroll':
      send('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: event.x, y: event.y,
        deltaX: 0, deltaY: (event as any).deltaY > 0 ? 100 : -100,
      });
      break;
  }
}

function broadcastToClients(session: ScreencastSession, message: string): void {
  for (const client of session.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

function cleanupSession(email: string): void {
  const session = sessions.get(email);
  if (!session) return;

  session.closed = true;
  if (session.loginCheckInterval) clearInterval(session.loginCheckInterval);

  if (session.cdpWs) {
    try { session.cdpWs.close(); } catch {}
  }

  if (session.chromeProcess && !session.chromeProcess.killed) {
    session.chromeProcess.kill('SIGTERM');
  }

  for (const client of session.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'session_closed' }));
      client.close();
    }
  }

  sessions.delete(email);
}

export function getScreencastPort(email: string): number | null {
  return sessions.get(email)?.debugPort ?? null;
}

export function closeScreencast(email: string): void {
  cleanupSession(email);
}
