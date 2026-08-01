/*
 * File: providers/deepseek/leim.ts
 * hif-leim token fetcher — browserless, with 10-minute cache.
 *
 * "hif-leim" is a WAF bypass token fetched from a separate DeepSeek domain.
 * The real web client fetches it at startup and stores it in localStorage.
 * It's returned in the header `x-hif-ttl: 600` (10 min expiration).
 */

import { logStore } from '../../../services/logStore.ts';

const LEIM_URL = 'https://hif-leim.deepseek.com/query';

// ── Cache ──

let cachedLeim: string | null = null;
let cachedLeimExpiresAt = 0;

const LEIM_TTL = 600_000; // 10 minutes (matching server x-hif-ttl: 600)

/**
 * Fetch the hif-leim token from DeepSeek.
 * Cached for 10 minutes based on server TTL.
 * The token is a global value (not per-user), so we use a single cache.
 * Falls back to direct fetch if wreqFetch is not available (standalone).
 */
export async function getHifLeim(): Promise<string> {
  if (cachedLeim && cachedLeimExpiresAt > Date.now()) {
    return cachedLeim;
  }

  // Use wreqFetch for TLS impersonation when available
  try {
    const { wreqFetch } = await import('../../../services/wreqFetch.ts');
    const res = await wreqFetch(LEIM_URL, {
      method: 'GET',
      headers: { accept: 'application/json' },
      timeout: 10,
      impersonate: 'chrome_142',
    });
    const upstreamStatus = parseInt(res.headers.get('X-Upstream-Status') || '0', 10);
    if (upstreamStatus >= 400 || !res.ok) {
      throw new Error(`leim fetch failed: ${upstreamStatus || res.status}`);
    }
    const body: any = await res.json();
    const value = body.data?.biz_data?.value;
    if (!value) throw new Error('no leim value in response: ' + JSON.stringify(body).slice(0, 200));
    cachedLeim = value;
    cachedLeimExpiresAt = Date.now() + LEIM_TTL;
    logStore.log('debug', 'deepseek-leim', 'Fetched leim (wreq): ' + value.slice(0, 20) + '...');
    return value;
  } catch (err: any) {
    // If wreqFetch fails, try direct fetch as fallback
    logStore.log('warn', 'deepseek-leim', 'wreqFetch failed, trying direct: ' + (err instanceof Error ? err.message : String(err)));
  }

  // Direct fetch fallback (used by standalone test, works in Node/Bun)
  const r = await fetch(LEIM_URL, {
    headers: { accept: 'application/json' },
  });
  if (!r.ok) throw new Error('leim direct fetch failed: ' + r.status);
  const body: any = await r.json();
  const value = body.data?.biz_data?.value;
  if (!value) throw new Error('no leim value in response (direct)');
  cachedLeim = value;
  cachedLeimExpiresAt = Date.now() + LEIM_TTL;
  logStore.log('debug', 'deepseek-leim', 'Fetched leim (direct): ' + value.slice(0, 20) + '...');
  return value;
}

/**
 * Force refresh the cached leim (e.g., on 403 errors).
 */
export function clearLeimCache(): void {
  cachedLeim = null;
  cachedLeimExpiresAt = 0;
}
