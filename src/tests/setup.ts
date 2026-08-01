/*
 * Test preload — runs before any test module is imported (via bunfig.toml
 * [test].preload). Redirects all .qwen data writes (accounts.json, master.key,
 * monitor.json, browser-profiles) into a throwaway temp dir so the test suite
 * can never clobber the real .qwen/accounts.json. Must set the env BEFORE
 * accountManager.ts loads, because ACCOUNTS_FILE is resolved at module load.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!process.env.QWEN_DATA_DIR) {
  process.env.QWEN_DATA_DIR = mkdtempSync(join(tmpdir(), 'qwen-gate-test-'));
}
