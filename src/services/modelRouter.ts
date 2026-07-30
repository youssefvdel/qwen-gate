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

export interface ModelConfig {
  max_context: number;
  max_output: number;
  modalities: string[];
  fallback_chain?: FallbackChain;
}

export class ModelRouter {
  private modelHealth: Map<string, { errors: number; successes: number; lastChecked: number }> = new Map();
  private readonly ERROR_THRESHOLD = 0.3; // 30% error rate triggers degradation
  private readonly HEALTH_WINDOW_MS = 5 * 60 * 1000; // 5 minute sliding window

  /**
   * Route a requested model — returns as-is.
   * ponytail: fallback chain disabled, add when re-enabling weighted routing.
   */
  async route(requestedModel: string, _attemptCount = 0): Promise<string> {
    return requestedModel;
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
export default modelRouter;
