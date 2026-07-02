/*
 * File: providers/deepseek/session.ts
 * DeepSeek chat session management — browserless.
 *
 * Creates chat sessions using WASM PoW + real hif-leim.
 * Session ID is at data.biz_data.id (NOT chat_session.id).
 * Cached for 30 minutes per bearer token.
 */

import { logStore } from '../../../services/logStore.ts';
import { getHifLeim } from './leim.ts';
import { solvePowInline } from './pow.ts';
import { buildDeepSeekHeaders, createDeepSeekContext, DEEPSEEK_BASE_URL } from './spoofing.ts';

export interface DeepSeekChatSession {
  id: string;
  model_type: string;
}

// ── Cache (per bearer-token) ──

interface SessionCacheEntry {
  session: DeepSeekChatSession;
  timestamp: number;
}
const sessionCache = new Map<string, SessionCacheEntry>();
const SESSION_TTL = 30 * 60 * 1000; // 30 minutes

/**
 * Get or create a chat session for this Bearer token.
 * Cached for 30 minutes.
 *
 * Flow:
 *   1. Get hif-leim (cached 10 min)
 *   2. Solve PoW for chat_session/create (cached per-email up to 2 min)
 *   3. POST /api/v0/chat_session/create with full browser headers
 *   4. Extract session ID from data.biz_data.id
 */
export async function getOrCreateChatSession(bearerToken: string, email: string, powHeader?: string): Promise<DeepSeekChatSession | null> {
  // Check cache
  const cached = sessionCache.get(bearerToken);
  if (cached && Date.now() - cached.timestamp < SESSION_TTL) {
    return cached.session;
  }

  try {
    const ctx = createDeepSeekContext(bearerToken);

    // 1. Get hif-leim (global cache, 10 min TTL)
    const leim = await getHifLeim();
    logStore.log('debug', 'deepseek-session', 'Leim: ' + leim.slice(0, 20) + '...');

    // 2. Get PoW header (use passed-in if provided, otherwise solve for chat/completion)
    const pw = powHeader || (await solvePowInline(bearerToken, '/api/v0/chat/completion'));
    logStore.log('debug', 'deepseek-session', 'PoW ready' + (powHeader ? ' (passed)' : ' (solved)'));

    // 3. Build browser headers
    const baseHeaders = buildDeepSeekHeaders(ctx, {
      powResponse: pw,
      hifLeim: leim,
      dsSessionId: '',
    }) as unknown as Record<string, string>;
    baseHeaders['accept'] = 'application/json'; // session create is JSON, not SSE
    const { wreqFetch } = await import('../../../services/wreqFetch.ts');
    const res = await wreqFetch(DEEPSEEK_BASE_URL + '/api/v0/chat_session/create', {
      method: 'POST',
      headers: {
        ...baseHeaders,
        accept: 'application/json',
      },
      body: '{}',
      timeout: 10,
      impersonate: 'chrome_142',
    });
    const upstreamStatus = parseInt(res.headers.get('X-Upstream-Status') || '0', 10);
    if (!res.ok || upstreamStatus >= 400) {
      const errText = await res.text().catch(() => 'unknown');
      logStore.log(
        'warn',
        'deepseek-session',
        'POST chat_session/create failed: ' + (upstreamStatus || res.status) + ' ' + errText.slice(0, 500),
      );
      return null;
    }

    const body: any = await res.json().catch(() => null);
    if (!body) {
      logStore.log('warn', 'deepseek-session', 'POST chat_session/create: empty/unparseable body');
      return null;
    }
    if (body.code) {
      logStore.log('warn', 'deepseek-session', 'POST chat_session/create error: ' + JSON.stringify(body).slice(0, 500));
    }

    // CRITICAL: The verified response format is:
    //   { code: 0, msg: "success", data: { biz_data: { id: "<uuid>" } } }
    // NOT data.biz_data.chat_session.id — that was from an older API version.
    const bizData = body.data?.biz_data;
    const sessionId: string | undefined = bizData?.id || bizData?.chat_session?.id;
    const modelType: string = bizData?.model_type || 'default';

    if (!sessionId) {
      logStore.log('warn', 'deepseek-session', 'No session ID in response: ' + JSON.stringify(body).slice(0, 300));
      return null;
    }

    const session: DeepSeekChatSession = {
      id: sessionId,
      model_type: modelType,
    };

    sessionCache.set(bearerToken, { session, timestamp: Date.now() });
    logStore.log('debug', 'deepseek-session', 'Created session: ' + sessionId + ' model=' + modelType);
    return session;
  } catch (err: any) {
    logStore.log('error', 'deepseek-session', 'getOrCreateChatSession exception: ' + (err?.message || err));
    return null;
  }
}

/**
 * Clear session cache for a token (e.g. on auth failure).
 */
export function clearSessionCache(bearerToken: string): void {
  sessionCache.delete(bearerToken);
}
