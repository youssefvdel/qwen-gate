/*
 * File: providers/glm/session.ts
 * GLM chat session and user info management.
 * Uses wreqFetch (Rust + BoringSSL) for TLS/HTTP2 fingerprint impersonation.
 */

import { logStore } from '../../../services/logStore.ts';
import { GLM_BASE_URL } from './spoofing.ts';

export interface GlmUser {
  id: string;
  email: string;
  name: string;
  token: string;
}

export interface GlmChatSession {
  id: string;
  user_id: string;
  title: string;
  chat: any;
  created_at: number;
  updated_at: number;
}

const sessionCache = new Map<string, { session: GlmChatSession; timestamp: number }>();
const SESSION_TTL = 30 * 60 * 1000;

/**
 * Get current user info from GLM via wreqFetch (validates JWT, returns user details).
 */
export async function getCurrentUser(jwt: string): Promise<GlmUser | null> {
  try {
    const { wreqFetch } = await import('../../../services/wreqFetch.ts');
    const res = await wreqFetch(`${GLM_BASE_URL}/api/v1/auths/`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/json',
      },
      timeout: 10,
      impersonate: 'chrome_142',
    });
    const upstreamStatus = parseInt(res.headers.get('X-Upstream-Status') || '0', 10);
    if (upstreamStatus >= 400 || !res.ok) {
      logStore.log('warn', 'glm-session', `GET /api/v1/auths/ returned ${upstreamStatus || res.status}`);
      return null;
    }
    const data: any = await res.json();
    const user = data?.user || data;
    if (!user?.id) {
      logStore.log('warn', 'glm-session', 'No user ID in auth response');
      return null;
    }
    return {
      id: user.id,
      email: user.email || '',
      name: user.name || user.nickname || user.email || 'User',
      token: jwt,
    };
  } catch (err: any) {
    logStore.log('warn', 'glm-session', `getCurrentUser error: ${err.message}`);
    return null;
  }
}

/**
 * Get or create a chat session for this JWT.
 * Uses wreqFetch for all API calls. Fresh session per request — no cache (each request is independent).
 */
export async function getOrCreateChatSession(jwt: string, model: string): Promise<GlmChatSession | null> {
  const { wreqFetch } = await import('../../../services/wreqFetch.ts');

  try {
    const user = await getCurrentUser(jwt);
    if (!user) return null;

    // Clean up old sessions (keep max 5)
    try {
      const sessionsRes = await wreqFetch(`${GLM_BASE_URL}/api/v1/chats/`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${jwt}` },
        timeout: 10,
        impersonate: 'chrome_142',
      });
      const sessionsUpstream = parseInt(sessionsRes.headers.get('X-Upstream-Status') || '0', 10);
      if (sessionsRes.ok || sessionsUpstream < 400) {
        const chatsData: any = await sessionsRes.json();
        const chats = Array.isArray(chatsData) ? chatsData : chatsData?.data || [];
        for (let i = 5; i < chats.length; i++) {
          wreqFetch(`${GLM_BASE_URL}/api/v1/chats/${chats[i].id}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${jwt}` },
            timeout: 10,
            impersonate: 'chrome_142',
          }).catch(() => {});
        }
      }
    } catch {
      // Non-critical
    }

    // Create new chat session
    const chatId = crypto.randomUUID();
    const chatBody = {
      chat: {
        id: chatId,
        title: 'OpenGate Session',
        models: [model],
        params: {},
        history: { messages: {}, currentId: null },
        tags: [],
        flags: [],
        features: [],
        mcp_servers: [],
        enable_thinking: model.includes('glm-5') || model.includes('glm-4'),
        reasoning_effort: model.includes('glm-5') ? 'max' : '',
        auto_web_search: false,
        message_version: 1,
        extra: {},
        timestamp: Date.now(),
        type: 'default',
      },
    };

    const chatRes = await wreqFetch(`${GLM_BASE_URL}/api/v1/chats/new`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(chatBody),
      timeout: 15,
      impersonate: 'chrome_142',
    });

    const chatUpstream = parseInt(chatRes.headers.get('X-Upstream-Status') || '0', 10);
    if (!chatRes.ok || chatUpstream >= 400) {
      logStore.log('warn', 'glm-session', `POST /api/v1/chats/new returned ${chatUpstream || chatRes.status}`);
      return null;
    }

    const chatData: any = await chatRes.json();
    const session: GlmChatSession = {
      id: chatData?.id || chatData?.chat?.id || chatId,
      user_id: user.id,
      title: 'OpenGate Session',
      chat: chatData?.chat || chatBody.chat,
      created_at: Date.now(),
      updated_at: Date.now(),
    };

    sessionCache.set(jwt, { session, timestamp: Date.now() });
    return session;
  } catch (err: any) {
    logStore.log('warn', 'glm-session', `getOrCreateChatSession error: ${err.message}`);
    return null;
  }
}

/**
 * Clear the session cache for a JWT.
 */
export function clearSessionCache(jwt: string): void {
  sessionCache.delete(jwt);
}
