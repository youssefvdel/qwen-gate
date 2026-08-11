/**
 * Batch-add Qwen accounts to qwengate for multi-account round-robin rotation
 * with automatic failover. Hot-reloads — the running server picks up
 * accounts.json changes on the fly (fs.watch with debounce).
 *
 * Usage:
 *   QWEN_ACCOUNTS="user1@example.com:pass1,user2@example.com:pass2" bun scripts/add-accounts.ts
 *   bun scripts/add-accounts.ts "user1@example.com:pass1" "user2@example.com:pass2"
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, '.qwen');
const ACCOUNTS_FILE = join(DATA_DIR, 'accounts.json');

interface AccountEntry {
  email: string;
  password: string;
  throttledUntil: number;
  disabled: boolean;
}

function parseAccounts(): Array<{ email: string; password: string }> {
  const fromEnv = (process.env.QWEN_ACCOUNTS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const fromArgs = process.argv.slice(2);
  const raw: string[] = [...fromEnv, ...fromArgs];

  const out: Array<{ email: string; password: string }> = [];
  for (const item of raw) {
    const idx = item.lastIndexOf(':');
    if (idx <= 0) {
      console.error(`[add-accounts] Skip malformed entry (expected email:password): ${item}`);
      continue;
    }
    const email = item.slice(0, idx).trim();
    const password = item.slice(idx + 1);
    if (email && password) out.push({ email, password });
  }
  return out;
}

function loadExisting(): AccountEntry[] {
  if (!existsSync(ACCOUNTS_FILE)) return [];
  try {
    const data = JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf-8'));
    return (Array.isArray(data) ? data : []).map((a: any) => ({
      email: String(a.email || '').trim(),
      password: String(a.password || ''),
      throttledUntil: Number(a.throttledUntil || 0),
      disabled: !!a.disabled,
    }));
  } catch {
    return [];
  }
}

const incoming = parseAccounts();
if (incoming.length === 0) {
  console.error('[add-accounts] No accounts provided. Use QWEN_ACCOUNTS="a:b,c:d" env or pass email:password args.');
  process.exit(1);
}

const existing = loadExisting();
const seen = new Set(existing.map((a) => a.email.toLowerCase()));
const added: string[] = [];
const skipped: string[] = [];
for (const acct of incoming) {
  if (seen.has(acct.email.toLowerCase())) {
    skipped.push(acct.email);
    continue;
  }
  existing.push({ ...acct, throttledUntil: 0, disabled: false });
  seen.add(acct.email.toLowerCase());
  added.push(acct.email);
}

mkdirSync(DATA_DIR, { recursive: true });
writeFileSync(ACCOUNTS_FILE, JSON.stringify(existing, null, 2) + '\n', 'utf-8');

console.log(`[add-accounts] Added: ${added.length} (${added.join(', ') || 'none'})`);
console.log(`[add-accounts] Skipped (already present): ${skipped.length} (${skipped.join(', ') || 'none'})`);
console.log(`[add-accounts] Total accounts in ${ACCOUNTS_FILE}: ${existing.length}`);
console.log('[add-accounts] Running server picks this up automatically via fs.watch — no restart needed.');
