import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Get the directory of this file (src/utils/)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Project root is two levels up from src/utils/
export const PROJECT_ROOT = resolve(__dirname, '..', '..');

/**
 * Resolve a path relative to the project root.
 * Use this instead of process.cwd() to ensure paths work
 * regardless of where the CLI is invoked from.
 *
 * Honors the QWEN_DATA_DIR env override, but ONLY for the mutable `.qwen` data
 * dir (accounts.json, master.key, monitor.json, browser-profiles). Source-tree
 * reads (package.json, etc.) always resolve under PROJECT_ROOT. Tests point
 * QWEN_DATA_DIR at a throwaway temp dir so writes never clobber real
 * .qwen/accounts.json, while still reading package.json from the real root.
 */
export function projectPath(...segments: string[]): string {
  if (process.env.QWEN_DATA_DIR && segments[0] === '.qwen') {
    return resolve(process.env.QWEN_DATA_DIR, ...segments);
  }
  return resolve(PROJECT_ROOT, ...segments);
}

