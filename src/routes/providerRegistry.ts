/*
 * File: providerRegistry.ts
 * Multi-provider dispatch registry.
 *
 * Maps model name prefixes to handler functions.
 * Add a new entry for each provider — no other code changes needed.
 *
 * Provider naming convention: `provider/model-name`
 *   e.g. deepseek/instant, glm/glm-5.2
 *
 * To add a new provider:
 *   1. Create a handler function: (c, body) => Promise<Response>
 *   2. Register it in the PROVIDERS map with its prefix
 *   3. Add model entries to models.json
 */

import type { Context } from 'hono';
import type { OpenAIRequest } from '../types/openai.ts';

export type ProviderHandler = (c: Context, body: OpenAIRequest) => Promise<Response>;

/** Known provider prefixes, checked in order (longest first for sub-prefix safety) */
const PROVIDER_PREFIXES = ['deepseek/', 'glm/', 'qwen/'] as const;

type ProviderMap = Map<string, ProviderHandler>;

const providers: ProviderMap = new Map();

/**
 * Register a provider handler for a model prefix.
 * Called once at import time by each provider module.
 */
export function registerProvider(prefix: string, handler: ProviderHandler): void {
  if (!prefix.endsWith('/')) prefix += '/';
  providers.set(prefix, handler);
}

/**
 * Find the registered provider for a model name, or null if no match.
 * Checks prefixes in longest-first order for correctness with nested prefixes.
 * Also accepts bare provider names with `-`/`_` separators (e.g. `deepseek-v4-flash`
 * or `deepseek_v4_flash`) so unprefixed DeepSeek model names don't fall through
 * to the default Qwen provider.
 */
export function providerForModel(model: string): { prefix: string; handler: ProviderHandler } | null {
  // Check longest prefix first to avoid partial matches
  const sortedPrefixes = [...providers.keys()].sort((a, b) => b.length - a.length);
  for (const prefix of sortedPrefixes) {
    if (model.startsWith(prefix)) {
      const handler = providers.get(prefix);
      if (handler) return { prefix, handler };
    }
  }
  // Bare-name fallback: `deepseek-*` / `deepseek_*` (no slash) → deepseek provider
  for (const prefix of sortedPrefixes) {
    const bare = prefix.slice(0, -1); // 'deepseek', 'glm', 'qwen'
    if (model === bare || model.startsWith(bare + '-') || model.startsWith(bare + '_')) {
      const handler = providers.get(prefix);
      if (handler) return { prefix, handler };
    }
  }
  return null;
}

/**
 * Return the list of known provider model prefixes (for model listing).
 */
function getProviderPrefixes(): string[] {
  return [...providers.keys()];
}

// Provider modules register themselves via side-effect import.
// DO NOT import them here — that creates a circular dependency.
// Import them from the entry point that uses the registry (chat.ts or index.tsx).
