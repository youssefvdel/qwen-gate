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

const DEFAULT_CONFIG: Required<RetryConfig> = {
  maxRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 10000,
  backoffMultiplier: 2,
  nonRetryableStatuses: [400, 401, 403, 404, 405, 409, 410, 411, 412, 413, 414, 415, 418],
  attemptTimeoutMs: 30000,
  circuitBreaker: undefined as unknown as CircuitBreaker,
};

export class NonRetryableError extends Error {
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

export class AttemptTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Attempt timed out after ${timeoutMs}ms`);
    this.name = 'AttemptTimeoutError';
  }
}

// ─── Circuit Breaker ────────────────────────────────────────────────────────────

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

  constructor(name: string, config?: CircuitBreakerConfig) {
    this.name = name;
    this.failureThreshold = config?.failureThreshold ?? 5;
    this.resetTimeoutMs = config?.resetTimeoutMs ?? 30000;
    this.halfOpenMaxAttempts = config?.halfOpenMaxAttempts ?? 1;
  }

  getState(): CircuitState {
    // Auto-transition from open → half_open after reset timeout
    if (this.state === 'open' && Date.now() - this.lastFailureTime >= this.resetTimeoutMs) {
      this.state = 'half_open';
      this.successCount = 0;
      console.log(`[CircuitBreaker:${this.name}] open → half_open (reset timeout elapsed)`);
    }
    return this.state;
  }

  getStats(): { state: CircuitState; failureCount: number; successCount: number; lastFailureTime: number } {
    return {
      state: this.getState(),
      failureCount: this.failureCount,
      successCount: this.successCount,
      lastFailureTime: this.lastFailureTime,
    };
  }

  /** Check if the circuit allows a request to pass. Throws CircuitOpenError if open. */
  allowRequest(): void {
    const state = this.getState();
    if (state === 'open') {
      const retryAfterMs = Math.max(0, this.resetTimeoutMs - (Date.now() - this.lastFailureTime));
      throw new CircuitOpenError(retryAfterMs);
    }
  }

  /** Record a successful execution. */
  recordSuccess(): void {
    if (this.state === 'half_open') {
      this.successCount++;
      if (this.successCount >= this.halfOpenMaxAttempts) {
        this.state = 'closed';
        this.failureCount = 0;
        console.log(`[CircuitBreaker:${this.name}] half_open → closed (recovered)`);
      }
    } else {
      // Reset on success in closed state
      this.failureCount = 0;
    }
  }

  /** Record a failed execution. */
  recordFailure(): void {
    this.lastFailureTime = Date.now();
    if (this.state === 'half_open') {
      // Immediate re-open on any failure in half-open
      this.state = 'open';
      console.log(`[CircuitBreaker:${this.name}] half_open → open (probe failed)`);
    } else {
      this.failureCount++;
      if (this.failureCount >= this.failureThreshold) {
        this.state = 'open';
        console.warn(`[CircuitBreaker:${this.name}] closed → open (${this.failureCount} consecutive failures)`);
      }
    }
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
      this.recordSuccess();
      return result;
    } catch (error) {
      // Only count retryable errors as circuit failures
      if (isRetryable(error)) {
        this.recordFailure();
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
export function isRetryable(error: unknown, httpStatus?: number): boolean {
  // Explicit non-retryable
  if (error instanceof NonRetryableError) return false;

  // Network errors (fetch throws TypeError/AbortError/NetworkError)
  if (error instanceof TypeError || error instanceof DOMException) {
    const msg = String(error.message).toLowerCase();
    if (msg.includes('network') || msg.includes('fetch') || msg.includes('aborted') || msg.includes('timeout')) {
      return true;
    }
    // TypeError often means network failure
    return true;
  }

  // Timeout
  if (error instanceof Error && error.name === 'TimeoutError') return true;

  // Abort
  if (error instanceof Error && error.name === 'AbortError') return true;

  // HTTP status check
  if (httpStatus !== undefined) {
    if (httpStatus === 429) return true; // rate limited
    if (httpStatus >= 500) return true;  // server error
    if (httpStatus >= 400 && httpStatus < 500) {
      // 4xx are generally non-retryable (except 429 handled above)
      return false;
    }
  }

  // Generic error messages from upstream that indicate transient issues
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (msg.includes('econnreset') ||
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
        msg.includes('internal server error')) {
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
  return new Promise(resolve => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new AttemptTimeoutError(timeoutMs)), timeoutMs);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

/**
 * Load retry config from environment variables with defaults.
 */
export function getRetryConfigFromEnv(): Required<RetryConfig> {
  const envConfig: RetryConfig = {};

  if (process.env.RETRY_MAX_ATTEMPTS !== undefined) {
    envConfig.maxRetries = parseInt(process.env.RETRY_MAX_ATTEMPTS, 10);
    if (isNaN(envConfig.maxRetries) || envConfig.maxRetries < 0) {
      envConfig.maxRetries = DEFAULT_CONFIG.maxRetries;
    }
  }

  if (process.env.RETRY_BASE_DELAY_MS !== undefined) {
    envConfig.baseDelayMs = parseInt(process.env.RETRY_BASE_DELAY_MS, 10);
    if (isNaN(envConfig.baseDelayMs) || envConfig.baseDelayMs < 0) {
      envConfig.baseDelayMs = DEFAULT_CONFIG.baseDelayMs;
    }
  }

  if (process.env.RETRY_MAX_DELAY_MS !== undefined) {
    envConfig.maxDelayMs = parseInt(process.env.RETRY_MAX_DELAY_MS, 10);
    if (isNaN(envConfig.maxDelayMs) || envConfig.maxDelayMs < 0) {
      envConfig.maxDelayMs = DEFAULT_CONFIG.maxDelayMs;
    }
  }

  if (process.env.RETRY_BACKOFF_MULTIPLIER !== undefined) {
    envConfig.backoffMultiplier = parseFloat(process.env.RETRY_BACKOFF_MULTIPLIER);
    if (isNaN(envConfig.backoffMultiplier) || envConfig.backoffMultiplier <= 0) {
      envConfig.backoffMultiplier = DEFAULT_CONFIG.backoffMultiplier;
    }
  }

  return { ...DEFAULT_CONFIG, ...envConfig };
}

/**
 * Wraps an async function with retry logic.
 * Retries on transient errors with exponential backoff.
 * Supports per-attempt timeout and optional circuit breaker.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  config?: RetryConfig
): Promise<T> {
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
      if (cfg.circuitBreaker) cfg.circuitBreaker.recordSuccess();
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
        cfg.circuitBreaker.recordFailure();
      }

      if (!retryable || attempt >= cfg.maxRetries) {
        throw error;
      }

      if (cfg.circuitBreaker && cfg.circuitBreaker.getState() === 'open') {
        throw new CircuitOpenError(cfg.circuitBreaker.getStats().lastFailureTime);
      }

      const jitter = delay * 0.2 * (Math.random() * 2 - 1);
      const actualDelay = Math.min(delay + jitter, cfg.maxDelayMs);

      console.warn(`[Retry] attempt ${attempt + 1}/${cfg.maxRetries + 1} failed (${httpStatus || 'network'}, retryable), retrying in ${Math.round(actualDelay)}ms...`);
      await sleep(actualDelay);

      delay = Math.min(delay * cfg.backoffMultiplier, cfg.maxDelayMs);
    }
  }

  throw lastError;
}