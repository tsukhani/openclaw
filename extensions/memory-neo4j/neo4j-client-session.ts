/**
 * Session management and retry utilities for the Neo4j memory client.
 *
 * Standalone functions for managed session lifecycle, search fallback
 * with graceful degradation, and transient error retry with backoff.
 */

import type { Driver, Session } from "neo4j-driver";
import { isNeo4jConnectionError } from "./errors.js";
import { isTransientNeo4jError, retryWithBackoff } from "./retry.js";
import type { Logger } from "./schema.js";

// Retry configuration for transient Neo4j errors (deadlocks, etc.)
export const TRANSIENT_RETRY_ATTEMPTS = 3;
export const TRANSIENT_RETRY_BASE_DELAY_MS = 500;

/**
 * Run a function with a managed session (ensureInitialized + auto-close).
 * When an AbortSignal is provided, the session is closed early on abort
 * so the in-flight Neo4j query is cancelled and the connection returned to the pool.
 *
 * @param ensureInitialized - Async function that ensures driver is initialized
 * @param getDriver - Function that returns the current driver (may be null after close())
 */
export async function withSession<T>(
  fn: (session: Session) => Promise<T>,
  ensureInitialized: () => Promise<void>,
  getDriver: () => Driver | null,
  abortSignal?: AbortSignal,
): Promise<T> {
  if (abortSignal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
  await ensureInitialized();
  // M2: Guard against concurrent close() nullifying driver after init
  const driver = getDriver();
  if (!driver) {
    throw new Error("memory-neo4j: driver closed during operation");
  }
  const session = driver.session();
  // Close the session early when the abort signal fires — this cancels any
  // in-flight transaction and releases the connection back to the pool.
  const onAbort = () => session.close().catch(() => {});
  abortSignal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await fn(session);
  } finally {
    abortSignal?.removeEventListener("abort", onAbort);
    await session.close();
  }
}

/**
 * Run a search operation with retry + graceful fallback on errors.
 * Connection errors are re-thrown when rethrowConnection is true (default).
 * Non-connection errors return the fallback value and log at the specified level.
 *
 * When an abortSignal is provided (from hybridSearch per-signal timeout),
 * it is threaded to retryOnTransient so zombie retries are stopped and
 * connections returned to the pool.
 */
export async function withSearchFallback<T>(
  label: string,
  fn: () => Promise<T>,
  fallback: T,
  logger: Logger,
  rethrowConnection = true,
  logLevel: "warn" | "debug" = "warn",
  abortSignal?: AbortSignal,
): Promise<T> {
  try {
    return await retryOnTransient(
      fn,
      logger,
      TRANSIENT_RETRY_ATTEMPTS,
      TRANSIENT_RETRY_BASE_DELAY_MS,
      abortSignal,
    );
  } catch (err) {
    // AbortError means the signal timed out — return fallback silently, no log spam.
    if (err instanceof DOMException && err.name === "AbortError") {
      return fallback;
    }
    if (isNeo4jConnectionError(err) && rethrowConnection) {
      logger.warn(`memory-neo4j: ${label} failed — Neo4j connection error: ${String(err)}`);
      throw err;
    }
    const msg = `memory-neo4j: ${label} failed: ${String(err)}`;
    if (logLevel === "debug") {
      logger.debug?.(msg);
    } else {
      const suffix = isNeo4jConnectionError(err) ? "" : " (non-connection)";
      logger.warn(`memory-neo4j: ${label} failed${suffix}: ${String(err)}`);
    }
    return fallback;
  }
}

/**
 * Retry an operation on transient Neo4j errors (deadlocks, connection blips, etc.)
 * with exponential backoff.
 */
export async function retryOnTransient<T>(
  fn: () => Promise<T>,
  logger: Logger,
  maxAttempts: number = TRANSIENT_RETRY_ATTEMPTS,
  baseDelay: number = TRANSIENT_RETRY_BASE_DELAY_MS,
  abortSignal?: AbortSignal,
): Promise<T> {
  return retryWithBackoff(fn, {
    maxAttempts,
    baseDelayMs: baseDelay,
    isRetryable: isTransientNeo4jError,
    abortSignal,
    onRetry: (err, attempt) => {
      logger.warn(
        `memory-neo4j: transient error, retrying (${attempt + 1}/${maxAttempts}): ${String(err)}`,
      );
    },
  });
}
