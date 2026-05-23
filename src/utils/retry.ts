/**
 * Retry utility with configurable max attempts and exponential backoff.
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
}

const DEFAULT_CONFIG: Required<RetryConfig> = {
  maxRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 10000,
  backoffMultiplier: 2,
  nonRetryableStatuses: [400, 401, 403, 404, 405, 409, 410, 411, 412, 413, 414, 415, 418],
};

export class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableError';
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

  let lastError: unknown;
  let delay = cfg.baseDelayMs;

  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      lastError = error;

      // Check if we can determine HTTP status from the error
      let httpStatus: number | undefined;
      if (error && typeof error === 'object') {
        const errObj = error as Record<string, unknown>;
        httpStatus = errObj.status as number | undefined;
        if (!httpStatus && error instanceof Error) {
          // Try to extract status from error message (e.g., "Failed to fetch from Qwen: 502 ...")
          const match = error.message.match(/\b([45]\d{2})\b/);
          if (match) httpStatus = parseInt(match[1], 10);
        }
      }

      const retryable = isRetryable(error, httpStatus);

      if (!retryable || attempt >= cfg.maxRetries) {
        throw error;
      }

      // Add jitter (±20%) to avoid thundering herd
      const jitter = delay * 0.2 * (Math.random() * 2 - 1);
      const actualDelay = Math.min(delay + jitter, cfg.maxDelayMs);

      console.warn(`[Retry] attempt ${attempt + 1}/${cfg.maxRetries + 1} failed (${httpStatus || 'network'}, retryable), retrying in ${Math.round(actualDelay)}ms...`);
      await sleep(actualDelay);

      delay = Math.min(delay * cfg.backoffMultiplier, cfg.maxDelayMs);
    }
  }

  throw lastError;
}