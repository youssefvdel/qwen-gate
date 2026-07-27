import { config } from '../services/configService.ts';
import { logStore } from '../services/logStore.ts';

/**
 * Retry utility with configurable max attempts, exponential backoff,
 * per-attempt timeout, and circuit breaker pattern.
 * Only retries on transient errors (network, 5xx, 429).
 */

export interface RetryConfig {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number;
  /** Initial delay in ms (default: 500) */
  baseDelayMs?: number;
  /** Maximum delay in ms (default: 10000) */
  maxDelayMs?: number;
  /** Multiplier for exponential backoff (default: 2) */
  backoffMultiplier?: number;
  /** List of HTTP status codes that should NOT be retried (4xx except 429) */
  nonRetryableStatuses?: number[];
  /** Per-attempt timeout in ms (default: 30000 = 30s). 0 = no timeout. */
  attemptTimeoutMs?: number;
  /** Circuit breaker instance to use (optional). If provided, open circuit = immediate rejection. */
  circuitBreaker?: CircuitBreaker;
}

function getDefaultRetryConfig(): Required<RetryConfig> {
  return {
    maxRetries: 3,
    baseDelayMs: 500,
    maxDelayMs: 10000,
    backoffMultiplier: 2,
    nonRetryableStatuses: [400, 401, 403, 404, 405, 409, 410, 411, 412, 413, 414, 415, 418],
    attemptTimeoutMs: 30000,
    circuitBreaker: undefined as never,
  };
}

const DEFAULT_CONFIG: Required<RetryConfig> = getDefaultRetryConfig();

class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableError';
  }
}

export class CircuitOpenError extends Error {
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super(`Circuit breaker is open. Retry after ${retryAfterMs}ms.`);
    this.name = 'CircuitOpenError';
    this.retryAfterMs = retryAfterMs;
  }
}

class AttemptTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Attempt timed out after ${timeoutMs}ms`);
    this.name = 'AttemptTimeoutError';
  }
}

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerConfig {
  /** Number of consecutive failures before opening the circuit (default: 5) */
  failureThreshold?: number;
  /** Time in ms before transitioning from open to half-open (default: 30000) */
  resetTimeoutMs?: number;
  /** Number of successes in half-open state to close the circuit (default: 1) */
  halfOpenMaxAttempts?: number;
}

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime = 0;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly halfOpenMaxAttempts: number;
  readonly name: string;
  /** Promise-chain mutex to prevent concurrent recordSuccess/recordFailure races */
  private lock: Promise<void> = Promise.resolve();

  constructor(name: string, config?: CircuitBreakerConfig) {
    this.name = name;
    this.failureThreshold = config?.failureThreshold ?? 5;
    this.resetTimeoutMs = config?.resetTimeoutMs ?? 30000;
    this.halfOpenMaxAttempts = config?.halfOpenMaxAttempts ?? 1;
  }

  getResetTimeoutMs(): number {
    return this.resetTimeoutMs;
  }

  tryTransitionToHalfOpen(): void {
    if (this.state === 'open' && Date.now() - this.lastFailureTime >= this.resetTimeoutMs) {
      this.state = 'half_open';
      this.successCount = 0;
      console.error(`[CircuitBreaker:${this.name}] open → half_open (reset timeout elapsed)`);
    }
  }

  getState(): CircuitState {
    return this.state;
  }

  getStats(): { state: CircuitState; failureCount: number; successCount: number; lastFailureTime: number } {
    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      lastFailureTime: this.lastFailureTime,
    };
  }

  /** Check if the circuit allows a request to pass. Throws CircuitOpenError if open. */
  allowRequest(): void {
    this.tryTransitionToHalfOpen();
    if (this.state === 'open') {
      const retryAfterMs = Math.max(0, this.resetTimeoutMs - (Date.now() - this.lastFailureTime));
      throw new CircuitOpenError(retryAfterMs);
    }
  }

  /** Record a successful execution. */
  recordSuccess(): Promise<void> {
    return new Promise((resolve) => {
      this.lock = this.lock
        .then(() => {
          if (this.state === 'half_open') {
            this.successCount++;
            if (this.successCount >= this.halfOpenMaxAttempts) {
              this.state = 'closed';
              this.failureCount = 0;
            }
          } else {
            this.failureCount = 0;
          }
          resolve();
        })
        .catch((err) => {
          console.error(`[CircuitBreaker:${this.name}] mutex error in recordSuccess:`, err);
          resolve();
        });
    });
  }

  /** Record a failed execution. */
  recordFailure(): Promise<void> {
    return new Promise((resolve) => {
      this.lock = this.lock
        .then(() => {
          this.lastFailureTime = Date.now();
          if (this.state === 'half_open') {
            this.state = 'open';
            console.error(`[CircuitBreaker:${this.name}] half_open → open (probe failed)`);
          } else {
            this.failureCount++;
            if (this.failureCount >= this.failureThreshold) {
              this.state = 'open';
              logStore.log('debug', 'retry', `[CircuitBreaker:${this.name}] closed → open (${this.failureCount} consecutive failures)`);
            }
          }
          resolve();
        })
        .catch((err) => {
          console.error(`[CircuitBreaker:${this.name}] mutex error in recordFailure:`, err);
          resolve();
        });
    });
  }

  /** Force reset to closed state (useful for manual intervention). */
  reset(): void {
    this.state = 'closed';
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = 0;
  }

  /** Wrap an async function with circuit breaker protection. */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.allowRequest();
    try {
      const result = await fn();
      await this.recordSuccess();
      return result;
    } catch (error) {
      if (isRetryable(error)) {
        await this.recordFailure();
      }
      throw error;
    }
  }
}

/**
 * Determines if an error or HTTP status is retryable.
 * Retryable: network errors, timeout, 429, 500, 502, 503, 504
 * Non-retryable: 4xx except 429, or explicit NonRetryableError
 */
function isRetryable(error: unknown, httpStatus?: number): boolean {
  // Explicit non-retryable
  if (error instanceof NonRetryableError) return false;

  // Upstream rate-limit errors (e.g., QwenUpstreamError with upstreamStatus=429)
  // should NOT be retried at the HTTP level — the account rotation loop in
  // session.ts handles retrying with different accounts and model fallback.
  // Retrying the same account is always wasted (Qwen throttles for hours).
  if (error && typeof error === 'object' && 'upstreamStatus' in (error as object)) {
    const upstreamErr = error as { upstreamStatus: number; upstreamCode?: string };
    if (upstreamErr.upstreamStatus === 429) {
      return false;
    }
  }

  // Network errors (fetch throws TypeError/DOMException for network issues)
  if (error instanceof TypeError || error instanceof DOMException) {
    const msg = String(error.message).toLowerCase();
    const networkKeywords = ['network', 'fetch', 'aborted', 'timeout', 'connection', 'econnrefused', 'enotfound', 'econnreset', 'socket'];
    return networkKeywords.some((kw) => msg.includes(kw));
  }

  // Timeout
  if (error instanceof AttemptTimeoutError) return true;
  if (error instanceof Error && error.name === 'TimeoutError') return true;

  // Abort
  if (error instanceof Error && error.name === 'AbortError') return true;

  // HTTP status check
  if (httpStatus !== undefined) {
    if (httpStatus === 429) return true; // rate limited
    if (httpStatus >= 500) return true; // server error
    if (httpStatus >= 400 && httpStatus < 500) {
      // 4xx are generally non-retryable (except 429 handled above)
      return false;
    }
  }

  // Generic error messages from upstream that indicate transient issues
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (
      msg.includes('econnreset') ||
      msg.includes('etimedout') ||
      msg.includes('enotfound') ||
      msg.includes('enomem') ||
      msg.includes('eai_fail') ||
      msg.includes('network') ||
      msg.includes('timeout') ||
      msg.includes('upstream') ||
      msg.includes('server error') ||
      msg.includes('bad gateway') ||
      msg.includes('service unavailable') ||
      msg.includes('gateway timeout') ||
      msg.includes('internal server error')
    ) {
      return true;
    }
  }

  // Unknown error — don't retry by default
  return false;
}

/**
 * Sleep for the specified duration.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new AttemptTimeoutError(timeoutMs)), timeoutMs);
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Load retry config from environment variables with defaults.
 */
function getRetryConfigFromEnv(): Required<RetryConfig> {
  const envConfig: RetryConfig = {};

  envConfig.maxRetries = Math.max(0, config.getInt('RETRY_MAX_ATTEMPTS', DEFAULT_CONFIG.maxRetries));
  envConfig.baseDelayMs = Math.max(0, config.getInt('RETRY_BASE_DELAY_MS', DEFAULT_CONFIG.baseDelayMs));
  envConfig.maxDelayMs = Math.max(0, config.getInt('RETRY_MAX_DELAY_MS', DEFAULT_CONFIG.maxDelayMs));
  envConfig.backoffMultiplier = Math.max(0.1, config.getFloat('RETRY_BACKOFF_MULTIPLIER', DEFAULT_CONFIG.backoffMultiplier));

  return { ...DEFAULT_CONFIG, ...envConfig };
}

export async function withRetry<T>(fn: () => Promise<T>, config?: RetryConfig): Promise<T> {
  const cfg: Required<RetryConfig> = {
    ...DEFAULT_CONFIG,
    ...getRetryConfigFromEnv(),
    ...config,
  };

  if (cfg.circuitBreaker) {
    cfg.circuitBreaker.allowRequest();
  }

  let lastError: unknown;
  let delay = cfg.baseDelayMs;

  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    try {
      const result = await withTimeout(fn(), cfg.attemptTimeoutMs);
      if (cfg.circuitBreaker) await cfg.circuitBreaker.recordSuccess();
      return result;
    } catch (error: unknown) {
      lastError = error;

      let httpStatus: number | undefined;
      if (error && typeof error === 'object') {
        const errObj = error as Record<string, unknown>;
        httpStatus = errObj.status as number | undefined;
        if (!httpStatus && error instanceof Error) {
          const match = error.message.match(/\b([45]\d{2})\b/);
          if (match) httpStatus = parseInt(match[1], 10);
        }
      }

      const retryable = isRetryable(error, httpStatus);

      if (cfg.circuitBreaker && retryable) {
        await cfg.circuitBreaker.recordFailure();
      }

      if (!retryable || attempt >= cfg.maxRetries) {
        throw error;
      }

      if (cfg.circuitBreaker && cfg.circuitBreaker.getState() === 'open') {
        const stats = cfg.circuitBreaker.getStats();
        const resetTimeoutMs = cfg.circuitBreaker.getResetTimeoutMs();
        const retryAfterMs = Math.max(0, stats.lastFailureTime + resetTimeoutMs - Date.now());
        throw new CircuitOpenError(retryAfterMs);
      }

      const jitter = delay * 0.2 * (Math.random() * 2 - 1);
      const actualDelay = Math.min(delay + jitter, cfg.maxDelayMs);

      const errorName = error instanceof Error ? error.name : typeof error;
      const errorMsg = error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
      logStore.log(
        'debug',
        'retry',
        `[Retry] attempt ${attempt + 1}/${cfg.maxRetries + 1} failed (${httpStatus || errorName}: ${errorMsg}), retrying in ${Math.round(actualDelay)}ms...`,
      );
      await sleep(actualDelay);

      delay = Math.min(delay * cfg.backoffMultiplier, cfg.maxDelayMs);
    }
  }

  throw lastError;
}
