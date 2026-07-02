// @ts-nocheck
/*
 * browserChat.ts — CDP browser fallback for DeepSeek.
 * Uses the connected Chromium browser to type/send messages via the UI
 * and read the response from the DOM. This bypasses PoW entirely because
 * the browser's own web app handles it.
 */

import { logStore } from '../../../services/logStore.ts';

async function page(targetId: string) {
  const ws = new WebSocket(`ws://127.0.0.1:9222/devtools/page/${targetId}`);
  let id = 0;
  const p = new Map<number, any>();
  return new Promise<any>((resolve, reject) => {
    let opened = false;
    const t = setTimeout(() => {
      try {
        ws.close();
      } catch {}
      if (!opened) reject(new Error('CDP page connection timeout'));
    }, 5000);
    ws.onopen = () => {
      clearTimeout(t);
      opened = true;
    };
    ws.onerror = () => {
      clearTimeout(t);
      reject(new Error('CDP page connection error'));
    };
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data as string);
      if (m.id !== undefined && p.has(m.id)) {
        const h = p.get(m.id)!;
        p.delete(m.id);
        m.error ? h.rj(new Error(JSON.stringify(m.error))) : h.rs(m.result);
      }
    };
    if (ws.readyState === WebSocket.OPEN) {
      clearTimeout(t);
      opened = true;
    }
    // Poll for open (WebSocket may already be open synchronously)
    const poll = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        clearTimeout(t);
        clearInterval(poll);
        opened = true;
        resolve({
          send: (method: string, params?: any): Promise<any> =>
            new Promise((rs, rj) => {
              const i = ++id;
              p.set(i, { rs, rj, _m: method });
              ws.send(JSON.stringify({ id: i, method, params }));
              setTimeout(() => {
                if (p.has(i)) {
                  p.delete(i);
                  rj(new Error('cdp:' + method));
                }
              }, 60000);
            }),
          close: () => {
            try {
              ws.close();
            } catch {}
          },
        });
      }
    }, 10);
  });
}

async function findOrCreatePage(): Promise<any> {
  try {
    const targets: any[] = await fetch('http://127.0.0.1:9222/json').then((r) => r.json());
    let dt = targets.find((t: any) => t.type === 'page' && t.url?.includes('deepseek'));
    if (dt) return page(dt.id);
    const info: any = await fetch('http://127.0.0.1:9222/json/version').then((r) => r.json());
    const bw = new WebSocket(info.webSocketDebuggerUrl);
    let bid = 0;
    const mp = new Map<number, any>();
    await new Promise((r) => {
      const t = setTimeout(() => {
        try {
          bw.close();
        } catch {}
        r(undefined);
      }, 5000);
      bw.onopen = () => {
        clearTimeout(t);
        r(undefined);
      };
      bw.onerror = () => {
        clearTimeout(t);
        r(undefined);
      };
    });
    bw.onmessage = (e) => {
      const m = JSON.parse(e.data as string);
      if (m.id !== undefined && mp.has(m.id)) {
        const h = mp.get(m.id)!;
        mp.delete(m.id);
        m.error ? h.rj(new Error(JSON.stringify(m.error))) : h.rs(m.result);
      }
    };
    const ct: any = await new Promise((rs, rj) => {
      const i = ++bid;
      mp.set(i, { rs, rj });
      bw.send(JSON.stringify({ id: i, method: 'Target.createTarget', params: { url: 'about:blank' } }));
    });
    bw.close();
    return page(ct.targetId);
  } catch (e: any) {
    return null;
  }
}

export async function chatViaCdpBrowser(c: any, body: any, _email: string): Promise<Response> {
  const p = await findOrCreatePage();
  if (!p) {
    return c.json(
      { error: { message: 'No CDP browser available. Start Chrome with --remote-debugging-port=9222.', type: 'browser_error' } },
      503,
    );
  }

  const prompt = body.messages?.map((m: any) => m.content).join('\n') || 'Hi';
  const model = body.model.replace(/^deepseek\//, '');

  try {
    await p.send('Runtime.enable');
    await p.send('Page.enable');

    // Navigate to DeepSeek chat
    await p.send('Page.navigate', { url: 'https://chat.deepseek.com/chat' });
    await new Promise((r) => setTimeout(r, 10000));

    // Check if logged in (may have been redirected to /)
    const urlRes = await p.send('Runtime.evaluate', { expression: 'location.href' });
    const currentUrl = urlRes.result?.value || '';
    if (currentUrl.includes('sign_in') || currentUrl.includes('login')) {
      return c.json({ error: { message: 'DeepSeek not logged in. Login via dashboard first.', type: 'auth_error' } }, 401);
    }

    // Count existing messages to track new ones
    const beforeCountRes = await p.send('Runtime.evaluate', {
      expression: `(() => document.querySelectorAll('.ds-markdown-block, [class*="markdown"], .markdown').length)()`,
    });
    const beforeCount = beforeCountRes.result?.value || 0;

    // Find textarea and type
    const textareaRes = await p.send('Runtime.evaluate', {
      expression: `(() => {
        const el = document.querySelector('textarea');
        return el ? 'found' : 'NOT FOUND';
      })()`,
    });
    if (textareaRes.result?.value === 'NOT FOUND') {
      return c.json(
        { error: { message: 'DeepSeek page textarea not found — page may not have loaded properly.', type: 'browser_error' } },
        502,
      );
    }

    // Type and send the message
    await p.send('Runtime.evaluate', {
      expression: `(() => {
        const ta = document.querySelector('textarea');
        if (!ta) return 'no textarea';
        ta.focus();
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        if (setter) setter.call(ta, ${JSON.stringify(prompt)});
        else ta.value = ${JSON.stringify(prompt)};
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.dispatchEvent(new Event('change', { bubbles: true }));
        setTimeout(() => {
          const btn = document.querySelector('[data-testid="send-button"]')
            || ta.closest('form')?.querySelector('button[type="submit"]')
            || ta.parentElement?.querySelector('button');
          if (btn) btn.click();
          else ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        }, 800);
        return 'sent';
      })()`,
    });

    // Poll for new messages
    let content = '';
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const msgRes = await p.send('Runtime.evaluate', {
        expression: `(() => {
          const blocks = document.querySelectorAll('.ds-markdown-block, [class*="markdown"], .markdown');
          if (blocks.length <= ${beforeCount}) return '';
          const last = blocks[blocks.length - 1];
          return last?.textContent?.trim() || '';
        })()`,
      });
      const v = msgRes.result?.value || '';
      if (v && v.length > 5) {
        content = v;
        // Break once we have a substantial response (not just a word)
        if (v.length > 30 || words(v) > 3) break;
      }
    }

    p.close();

    if (!content || content.length < 2) content = ' ';
    const responseMsg: any = { role: 'assistant', content };

    return c.json(
      {
        id: 'chatcmpl-' + crypto.randomUUID(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{ index: 0, message: responseMsg, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      },
      { headers: { 'content-type': 'application/json' } },
    );
  } catch (e: any) {
    try {
      p.close();
    } catch {}
    return c.json(
      {
        error: { message: 'CDP browser error: ' + (e.message || String(e)), type: 'browser_error' },
      },
      500,
    );
  }
}

function words(s: string): number {
  return s.split(/\s+/).filter((w) => w.length > 0).length;
}
