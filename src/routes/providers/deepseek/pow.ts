/*
 * File: providers/deepseek/pow.ts
 * DeepSeek Proof-of-Work (PoW) solver — direct WebAssembly, browserless.
 *
 * Loads the official DeepSeek SHA3 WASM once and reuses it to solve PoW
 * challenges. The WASM is downloaded on first use and cached in memory.
 * PoW solutions cached per (email, target_path) up to challenge.expire_after.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEEPSEEK_BASE_URL } from './spoofing.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM_PATH = resolve(__dirname, 'sha3_wasm_bg.wasm');

const POW_ENDPOINT = '/api/v0/chat/create_pow_challenge';

// ── Types ──

export interface PowChallenge {
  algorithm: string;
  challenge: string;
  salt: string;
  signature: string;
  difficulty: number;
  expire_at: number;
  expire_after: number;
  target_path: string;
}

export interface PowSolution {
  algorithm: string;
  challenge: string;
  salt: string;
  answer: number;
  signature: string;
  target_path: string;
}

// ── WASM singleton ──

let wasmExports: Record<string, any> | null = null;

function getWasm(): Record<string, any> {
  if (wasmExports) return wasmExports;
  const bytes = readFileSync(WASM_PATH);
  const module = new WebAssembly.Module(bytes);
  const instance = new WebAssembly.Instance(module, { wbg: {} });
  const e = instance.exports as Record<string, any>;
  if (typeof e.__wbindgen_start === 'function') {
    try {
      e.__wbindgen_start();
    } catch {
      /* wasm init noise */
    }
  }
  e.memory.grow(20);
  wasmExports = e;
  return e;
}

function encodeString(text: string): { ptr: number; len: number } {
  const e = getWasm();
  const bytes = new TextEncoder().encode(text);
  const ptr = e.__wbindgen_export_0(bytes.length, 1) >>> 0;
  new Uint8Array(e.memory.buffer, ptr, bytes.length).set(bytes);
  return { ptr, len: bytes.length };
}

function solveWasm(challenge: PowChallenge): number {
  const e = getWasm();
  const c = encodeString(challenge.challenge);
  const p = encodeString(challenge.salt + '_' + challenge.expire_at + '_');
  const retptr = e.__wbindgen_add_to_stack_pointer(-16);
  try {
    e.wasm_solve(retptr, c.ptr, c.len, p.ptr, p.len, challenge.difficulty);
    const view = new DataView(e.memory.buffer);
    const flag = view.getInt32(retptr, true);
    const ans = view.getFloat64(retptr + 8, true);
    if (flag === 0) throw new Error('No PoW solution found');
    return ans;
  } finally {
    e.__wbindgen_add_to_stack_pointer(16);
  }
}

function buildPowHeader(challenge: PowChallenge, answer: number): string {
  return Buffer.from(
    JSON.stringify({
      algorithm: challenge.algorithm,
      challenge: challenge.challenge,
      salt: challenge.salt,
      answer,
      signature: challenge.signature,
      target_path: challenge.target_path,
    }),
  ).toString('base64');
}

// ── API ──

/**
 * Fetch a PoW challenge from DeepSeek via wreqFetch.
 */
async function getPowChallenge(bearerToken: string, targetPath = '/api/v0/chat/completion'): Promise<PowChallenge> {
  const { wreqFetch } = await import('../../../services/wreqFetch.ts');
  const res = await wreqFetch(DEEPSEEK_BASE_URL + POW_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + bearerToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ target_path: targetPath }),
    timeout: 10,
    impersonate: 'chrome_142',
  });
  const upstreamStatus = parseInt(res.headers.get('X-Upstream-Status') || '0', 10);
  if (upstreamStatus >= 400 || !res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`PoW challenge failed: ${upstreamStatus || res.status} ${errText.slice(0, 200)}`);
  }
  const body: any = await res.json();
  const ch = body.data?.biz_data?.challenge;
  if (!ch) throw new Error('No challenge in PoW response: ' + JSON.stringify(body).slice(0, 300));
  return {
    algorithm: ch.algorithm || 'DeepSeekHashV1',
    challenge: ch.challenge,
    salt: ch.salt,
    signature: ch.signature,
    difficulty: ch.difficulty,
    expire_at: ch.expire_at,
    expire_after: ch.expire_after || 120_000,
    target_path: ch.target_path || targetPath,
  };
}

/**
 * Get a PoW response header (base64-encoded solution JSON).
 *
 * NOTE: DeepSeek PoW solutions are SINGLE-USE — each solution is accepted by
 * the chat/completion endpoint exactly once (reuse returns 40301
 * INVALID_POW_RESPONSE). Caching a solved header and reusing it within the
 * challenge's expire window makes every request after the first fail, so we
 * always solve fresh here. This mirrors the official web client, which
 * prefetches exactly one PoW per completion request (pow_prefetch_count: 1).
 * Throws on failure — caller should catch and retry.
 */
export async function getPowResponseHeader(email: string, bearerToken: string, targetPath = '/api/v0/chat/completion'): Promise<string> {
  // email is unused now (cache removed) but kept for call-site compatibility.
  void email;
  return solvePowInline(bearerToken, targetPath);
}

/**
 * Solves PoW inline without caching — for one-shot use where the caller
 * manages its own caching (e.g. session create with a different target_path).
 */
export async function solvePowInline(bearerToken: string, targetPath = '/api/v0/chat/completion'): Promise<string> {
  const challenge = await getPowChallenge(bearerToken, targetPath);
  const answer = solveWasm(challenge);
  return buildPowHeader(challenge, answer);
}
