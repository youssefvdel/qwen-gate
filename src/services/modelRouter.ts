/*
 * File: modelRouter.ts
 * Model fallback router with health-based degradation
 * Implements LiteLLM-style weighted fallback chain selection
 */

import { logStore } from './logStore.ts';

export interface FallbackEntry {
  model: string;
  weight: number;
  health_threshold: number;
}

export interface FallbackChain {
  primary: string;
  fallbacks: FallbackEntry[];
}

// ponytail: static fallback chains — opengate-specific, not available from Qwen API
const FALLBACK_CHAINS: Record<string, FallbackChain> = {
  'qwen3-6-plus': {
    primary: 'qwen3-6-plus',
    fallbacks: [
      { model: 'qwen3-5-plus', weight: 0.8, health_threshold: 0.9 },
      { model: 'qwen3-5-flash', weight: 0.5, health_threshold: 0.8 },
    ],
  },
  'qwen3-7-max': {
    primary: 'qwen3-7-max',
    fallbacks: [
      { model: 'qwen3-6-plus', weight: 0.9, health_threshold: 0.9 },
      { model: 'qwen3-5-plus', weight: 0.6, health_threshold: 0.8 },
    ],
  },
  'qwen3-6-max-preview': {
    primary: 'qwen3-6-max-preview',
    fallbacks: [{ model: 'qwen3-5-max-preview', weight: 0.85, health_threshold: 0.9 }],
  },
  'qwen3-6-27b': { primary: 'qwen3-6-27b', fallbacks: [{ model: 'qwen3-5-27b', weight: 0.9, health_threshold: 0.9 }] },
  'qwen3.8-max-preview': {
    primary: 'qwen3.8-max-preview',
    fallbacks: [
      { model: 'qwen3.7-max-preview', weight: 0.85, health_threshold: 0.9 },
      { model: 'qwen3.6-plus', weight: 0.6, health_threshold: 0.8 },
    ],
  },
  'qwen3-8-max-preview': {
    primary: 'qwen3.8-max-preview',
    fallbacks: [
      { model: 'qwen3.7-max-preview', weight: 0.85, health_threshold: 0.9 },
      { model: 'qwen3.6-plus', weight: 0.6, health_threshold: 0.8 },
    ],
  },
  'qwen3-7-max-preview': {
    primary: 'qwen3-7-max-preview',
    fallbacks: [{ model: 'qwen3-6-plus-preview', weight: 0.8, health_threshold: 0.9 }],
  },
  'qwen3-7-plus': {
    primary: 'qwen3-7-plus',
    fallbacks: [
      { model: 'qwen3-6-plus', weight: 0.9, health_threshold: 0.9 },
      { model: 'qwen3-5-plus', weight: 0.6, health_threshold: 0.8 },
    ],
  },
  'qwen3-7-plus-preview': {
    primary: 'qwen3-7-plus-preview',
    fallbacks: [
      { model: 'qwen3-6-plus', weight: 0.85, health_threshold: 0.9 },
      { model: 'qwen3-5-plus', weight: 0.6, health_threshold: 0.8 },
    ],
  },
  'qwen3-5-plus': { primary: 'qwen3-5-plus', fallbacks: [{ model: 'qwen3-5-flash', weight: 0.7, health_threshold: 0.85 }] },
  'qwen3-5-omni-plus': { primary: 'qwen3-5-omni-plus', fallbacks: [{ model: 'qwen3-5-omni-flash', weight: 0.8, health_threshold: 0.9 }] },
  'qwen3-6-35b-a3b': { primary: 'qwen3-6-35b-a3b', fallbacks: [{ model: 'qwen3-5-397b-a17b', weight: 0.75, health_threshold: 0.85 }] },
  'qwen3-5-flash': { primary: 'qwen3-5-flash', fallbacks: [] },
  'qwen3-5-max-preview': { primary: 'qwen3-5-max-preview', fallbacks: [{ model: 'qwen3-5-plus', weight: 0.7, health_threshold: 0.85 }] },
  'qwen3-6-plus-preview': { primary: 'qwen3-6-plus-preview', fallbacks: [{ model: 'qwen3-5-plus', weight: 0.8, health_threshold: 0.9 }] },
  'qwen3-5-397b-a17b': { primary: 'qwen3-5-397b-a17b', fallbacks: [{ model: 'qwen3-5-122b-a10b', weight: 0.8, health_threshold: 0.85 }] },
  'qwen3-5-122b-a10b': { primary: 'qwen3-5-122b-a10b', fallbacks: [{ model: 'qwen3-5-27b', weight: 0.75, health_threshold: 0.85 }] },
  'qwen3-5-omni-flash': { primary: 'qwen3-5-omni-flash', fallbacks: [] },
  'qwen3-5-27b': { primary: 'qwen3-5-27b', fallbacks: [] },

  // ── Dot-format aliases (for clients that use dots vs dashes) ──
  // NOTE: primaries MUST use dot format (matching the key) — Qwen's API expects dot-separated model names
  'qwen3.6-plus': {
    primary: 'qwen3.6-plus',
    fallbacks: [
      { model: 'qwen3.5-plus', weight: 0.8, health_threshold: 0.9 },
      { model: 'qwen3.5-flash', weight: 0.5, health_threshold: 0.8 },
    ],
  },
  'qwen3.7-max': {
    primary: 'qwen3.7-max',
    fallbacks: [
      { model: 'qwen3.6-plus', weight: 0.9, health_threshold: 0.9 },
      { model: 'qwen3.5-plus', weight: 0.6, health_threshold: 0.8 },
    ],
  },
  'qwen3.6-max-preview': {
    primary: 'qwen3.6-max-preview',
    fallbacks: [{ model: 'qwen3.5-max-preview', weight: 0.85, health_threshold: 0.9 }],
  },
  'qwen3.6-27b': { primary: 'qwen3.6-27b', fallbacks: [{ model: 'qwen3.5-27b', weight: 0.9, health_threshold: 0.9 }] },
  'qwen3.7-max-preview': {
    primary: 'qwen3.7-max-preview',
    fallbacks: [{ model: 'qwen3.6-plus-preview', weight: 0.8, health_threshold: 0.9 }],
  },
  'qwen3.7-plus': {
    primary: 'qwen3.7-plus',
    fallbacks: [
      { model: 'qwen3.6-plus', weight: 0.9, health_threshold: 0.9 },
      { model: 'qwen3.5-plus', weight: 0.6, health_threshold: 0.8 },
    ],
  },
  'qwen3.7-plus-preview': {
    primary: 'qwen3.7-plus-preview',
    fallbacks: [
      { model: 'qwen3.6-plus', weight: 0.85, health_threshold: 0.9 },
      { model: 'qwen3.5-plus', weight: 0.6, health_threshold: 0.8 },
    ],
  },
  'qwen3.5-plus': { primary: 'qwen3.5-plus', fallbacks: [{ model: 'qwen3.5-flash', weight: 0.7, health_threshold: 0.85 }] },
  'qwen3.5-omni-plus': { primary: 'qwen3.5-omni-plus', fallbacks: [{ model: 'qwen3.5-omni-flash', weight: 0.8, health_threshold: 0.9 }] },
  'qwen3.6-35b-a3b': { primary: 'qwen3.6-35b-a3b', fallbacks: [{ model: 'qwen3.5-397b-a17b', weight: 0.75, health_threshold: 0.85 }] },
  'qwen3.5-flash': { primary: 'qwen3.5-flash', fallbacks: [] },
  'qwen3.5-max-preview': { primary: 'qwen3.5-max-preview', fallbacks: [{ model: 'qwen3.5-plus', weight: 0.7, health_threshold: 0.85 }] },
  'qwen3.6-plus-preview': { primary: 'qwen3.6-plus-preview', fallbacks: [{ model: 'qwen3.5-plus', weight: 0.8, health_threshold: 0.9 }] },
  'qwen3.5-397b-a17b': { primary: 'qwen3.5-397b-a17b', fallbacks: [{ model: 'qwen3.5-122b-a10b', weight: 0.8, health_threshold: 0.85 }] },
  'qwen3.5-122b-a10b': { primary: 'qwen3.5-122b-a10b', fallbacks: [{ model: 'qwen3.5-27b', weight: 0.75, health_threshold: 0.85 }] },
  'qwen3.5-omni-flash': { primary: 'qwen3.5-omni-flash', fallbacks: [] },
  'qwen3.5-27b': { primary: 'qwen3.5-27b', fallbacks: [] },
};

class ModelRouter {
  private modelHealth: Map<string, { errors: number; successes: number; lastChecked: number }> = new Map();
  private readonly ERROR_THRESHOLD = 0.3; // 30% error rate triggers degradation
  private readonly HEALTH_WINDOW_MS = 5 * 60 * 1000; // 5 minute sliding window

  /**
   * Route a requested model alias to an available model based on health
   * Falls back through weighted chain if primary is unhealthy or fails
   */
  async route(requestedModel: string, attemptCount = 0): Promise<string> {
    const chain = FALLBACK_CHAINS[requestedModel];

    if (!chain) {
      // No fallback config, return as-is
      return requestedModel;
    }

    const { primary, fallbacks } = chain;

    // Check if primary is healthy enough
    if (attemptCount === 0 && this.isModelHealthy(primary)) {
      return primary;
    }

    // Primary failed or unhealthy, select from fallbacks
    const candidates = fallbacks.filter((f) => this.isModelHealthy(f.model, f.health_threshold));

    if (candidates.length === 0) {
      // No healthy fallbacks, return primary as last resort
      return primary;
    }

    // Weighted random selection among healthy candidates
    return this.weightedSelect(candidates);
  }

  /**
   * Record an error for a model - updates health metrics
   */
  recordError(model: string): void {
    const metrics = this.modelHealth.get(model) || { errors: 0, successes: 0, lastChecked: Date.now() };
    metrics.errors += 1;
    metrics.lastChecked = Date.now();
    this.modelHealth.set(model, metrics);

    // Also log to logStore for persistence/monitoring
    logStore.recordModelError(model);
  }

  /**
   * Record a success for a model - updates health metrics
   */
  recordSuccess(model: string): void {
    const metrics = this.modelHealth.get(model) || { errors: 0, successes: 0, lastChecked: Date.now() };
    metrics.successes += 1;
    metrics.lastChecked = Date.now();
    this.modelHealth.set(model, metrics);
    logStore.recordModelSuccess(model);
  }

  /**
   * Check if a model meets the health threshold
   */
  private isModelHealthy(model: string, customThreshold?: number): boolean {
    const metrics = this.modelHealth.get(model);
    const threshold = customThreshold ?? 1 - this.ERROR_THRESHOLD;

    if (!metrics) {
      // No data yet, assume healthy
      return true;
    }

    // Expire old metrics outside the health window
    if (Date.now() - metrics.lastChecked > this.HEALTH_WINDOW_MS) {
      return true;
    }

    const total = metrics.errors + metrics.successes;
    if (total === 0) return true;

    const successRate = metrics.successes / total;
    return successRate >= threshold;
  }

  /**
   * Weighted random selection from candidates
   */
  private weightedSelect(candidates: FallbackEntry[]): string {
    if (candidates.length === 1) {
      return candidates[0].model;
    }

    const totalWeight = candidates.reduce((sum, c) => sum + c.weight, 0);
    let random = Math.random() * totalWeight;

    for (const candidate of candidates) {
      random -= candidate.weight;
      if (random <= 0) {
        return candidate.model;
      }
    }

    // Fallback to first if rounding issues
    return candidates[0].model;
  }

  /**
   * Get current health metrics for a model (for monitoring/debugging)
   */
  getHealthMetrics(model: string): { errorRate: number; successRate: number; isHealthy: boolean } | null {
    const metrics = this.modelHealth.get(model);
    if (!metrics) return null;

    const total = metrics.errors + metrics.successes;
    if (total === 0) return { errorRate: 0, successRate: 1, isHealthy: true };

    const errorRate = metrics.errors / total;
    const successRate = metrics.successes / total;

    return {
      errorRate,
      successRate,
      isHealthy: successRate >= 1 - this.ERROR_THRESHOLD,
    };
  }

  /**
   * Reset health metrics for a model (useful for testing or manual recovery)
   */
  resetHealth(model: string): void {
    this.modelHealth.delete(model);
  }
}

export const modelRouter = new ModelRouter();
