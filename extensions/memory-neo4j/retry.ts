/**
 * Shared retry-with-backoff utility for the memory-neo4j extension.
 *
 * Consolidates retry logic from neo4j-client.ts (retryOnTransient),
 * extractor.ts (withRetry), and embeddings.ts (inline retry loops)
 * into a single implementation with consistent jitter and abort support.
 */

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  /** Classify whether an error is retryable. Defaults to always-retry. */
  isRetryable?: (err: unknown) => boolean;
  /** Abort signal — throws AbortError if fired during a retry delay. */
  abortSignal?: AbortSignal;
  /** Called before each retry delay. Useful for logging. */
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
  /**
   * When set, use exponential backoff: baseDelayMs * exponent^attempt * jitter.
   * When omitted, use linear backoff: baseDelayMs * (attempt + 1) * jitter.
   */
  backoffExponent?: number;
  /** M7: Maximum delay in ms (caps exponential growth). Default: 30_000. */
  maxDelayMs?: number;
}

/**
 * Retry an async function with backoff and jitter.
 *
 * Default (linear): baseDelay * (attempt + 1) * jitter
 * With backoffExponent: baseDelay * exponent^attempt * jitter
 * Jitter range: 0.5–1.0× (prevents thundering herd).
 */
export async function retryWithBackoff<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const {
    maxAttempts,
    baseDelayMs,
    isRetryable,
    abortSignal,
    onRetry,
    backoffExponent,
    maxDelayMs = 30_000,
  } = opts;
  let lastError: unknown;

  if (maxAttempts < 1) throw new Error("retryWithBackoff: maxAttempts must be >= 1");
  // L1/L4: Validate baseDelayMs to prevent NaN propagation or negative delays
  if (!Number.isFinite(baseDelayMs) || baseDelayMs < 0) {
    throw new Error(
      `retryWithBackoff: baseDelayMs must be a non-negative finite number, got ${baseDelayMs}`,
    );
  }

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (abortSignal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }

      // Non-retryable errors throw immediately
      if (isRetryable && !isRetryable(err)) throw err;

      lastError = err;

      // Last attempt exhausted — throw
      if (attempt >= maxAttempts - 1) throw err;

      const base =
        backoffExponent !== undefined
          ? baseDelayMs * backoffExponent ** attempt
          : baseDelayMs * (attempt + 1);
      // M7: Cap delay to prevent unbounded growth with exponential backoff
      const delay = Math.min(base, maxDelayMs) * (0.5 + Math.random() * 0.5);
      onRetry?.(err, attempt, delay);

      await abortableDelay(delay, abortSignal);

      if (abortSignal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
    }
  }

  // Should not reach here, but TypeScript needs the throw
  throw lastError;
}

/** Promise-based delay that rejects on abort signal. */
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted)
    return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    // L31: Allow Node.js process to exit while timer is pending
    if (typeof timer === "object" && "unref" in timer) timer.unref();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------
// Transient error classifiers (extracted from their original modules)
// ---------------------------------------------------------------------------

/**
 * Classify Neo4j transient errors (deadlocks, connection blips, service unavailable).
 * L32: Uses both instanceof check and constructor.name for Neo4jError detection because
 * constructor.name may differ across realms/bundlers. Message-based fallback covers all cases.
 */
export function isTransientNeo4jError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const errCode = (err as unknown as Record<string, unknown>).code as string | undefined;
  return (
    err.message.includes("DeadlockDetected") ||
    err.message.includes("TransientError") ||
    err.message.includes("ServiceUnavailable") ||
    err.message.includes("SessionExpired") ||
    err.message.includes("ConnectionRefused") ||
    err.message.includes("connection terminated") ||
    (err.constructor.name === "Neo4jError" &&
      typeof errCode === "string" &&
      (errCode.startsWith("Neo.TransientError.") ||
        errCode === "ServiceUnavailable" ||
        errCode === "SessionExpired"))
  );
}
