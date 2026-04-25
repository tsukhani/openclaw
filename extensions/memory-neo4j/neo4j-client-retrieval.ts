/**
 * Retrieval tracking buffer and flush logic for the Neo4j memory client.
 *
 * Buffers retrieval events and flushes them to Neo4j in batches to reduce
 * per-search write overhead. Handles backpressure, overflow caps, and
 * exponential backoff on flush failures.
 */

import type { Driver } from "neo4j-driver";
import * as Search from "./neo4j-client-search.js";
import type { Logger } from "./schema.js";

/** Configuration constants for retrieval buffer management. */
export const RETRIEVAL_FLUSH_INTERVAL_MS = 30_000;
/** Shorter retry interval after a flush failure to drain backlog faster under load. */
export const RETRIEVAL_RETRY_INTERVAL_MS = 5_000;
export const RETRIEVAL_FLUSH_THRESHOLD = 50;
/** H1: Cap retrieval buffer to prevent unbounded growth during persistent Neo4j outages. */
export const MAX_RETRIEVAL_BUFFER_SIZE = 1000;

/**
 * Mutable retrieval buffer state. Owned by the Neo4jMemoryClient instance
 * and passed to these standalone functions for manipulation.
 */
export interface RetrievalBufferState {
  buffer: string[];
  flushTimer: ReturnType<typeof setTimeout> | null;
  flushInProgress: boolean;
  consecutiveFailures: number;
}

/** Create a fresh retrieval buffer state. */
export function createRetrievalBufferState(): RetrievalBufferState {
  return {
    buffer: [],
    flushTimer: null,
    flushInProgress: false,
    consecutiveFailures: 0,
  };
}

/**
 * Record retrieval events for memories. Called after search/recall.
 * Buffers IDs and flushes when the threshold is reached or after a timer.
 */
export async function recordRetrievals(
  state: RetrievalBufferState,
  memoryIds: string[],
  flushFn: () => Promise<void>,
  logger: Logger,
): Promise<void> {
  if (memoryIds.length === 0) {
    return;
  }
  // Buffer retrieval IDs instead of writing immediately
  state.buffer.push(...memoryIds);
  // Flush if buffer exceeds threshold and no flush is already in-flight.
  // When a flush IS in-flight, schedule a timer so buffered IDs are drained
  // shortly after the current flush finishes (avoids silent accumulation).
  if (state.buffer.length >= RETRIEVAL_FLUSH_THRESHOLD) {
    if (!state.flushInProgress) {
      await flushFn();
      return;
    }
    // Flush in-flight — ensure a timer is scheduled to drain once it completes
    scheduleRetrievalFlush(state, RETRIEVAL_RETRY_INTERVAL_MS, flushFn, logger);
    return;
  }
  // Schedule a timer-based flush if not already scheduled
  scheduleRetrievalFlush(state, RETRIEVAL_FLUSH_INTERVAL_MS, flushFn, logger);
}

/** Schedule a retrieval flush timer if one isn't already pending. */
export function scheduleRetrievalFlush(
  state: RetrievalBufferState,
  delayMs: number,
  flushFn: () => Promise<void>,
  logger: Logger,
): void {
  if (state.flushTimer) {
    return;
  }
  state.flushTimer = setTimeout(() => {
    flushFn().catch((err) => {
      logger.debug?.(`memory-neo4j: retrieval flush failed: ${String(err)}`);
    });
  }, delayMs);
  if (state.flushTimer && typeof state.flushTimer === "object" && "unref" in state.flushTimer) {
    state.flushTimer.unref();
  }
}

/**
 * Flush buffered retrieval IDs to Neo4j. Deduplicates and counts occurrences,
 * handles failure recovery with backoff, and respects the buffer size cap.
 */
export async function flushRetrievalBuffer(
  state: RetrievalBufferState,
  driver: Driver | null,
  logger: Logger,
  retryOnTransient: <T>(fn: () => Promise<T>) => Promise<T>,
  withSession: <T>(fn: (session: import("neo4j-driver").Session) => Promise<T>) => Promise<T>,
): Promise<void> {
  if (state.flushInProgress || state.buffer.length === 0) {
    return;
  }
  state.flushInProgress = true;
  try {
    if (state.flushTimer) {
      clearTimeout(state.flushTimer);
      state.flushTimer = null;
    }
    // Defensive copy: swap buffer before async work so new arrivals go
    // into a fresh array, and restore on failure to avoid data loss.
    const ids = [...state.buffer];
    state.buffer = [];
    // Deduplicate and count occurrences
    const counts = new Map<string, number>();
    for (const id of ids) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    if (!driver) {
      return;
    }
    try {
      await retryOnTransient(() =>
        withSession((s) => Search.recordRetrievals(s, [...counts.entries()])),
      );
      state.consecutiveFailures = 0;
      // If more IDs arrived while we were flushing, schedule a quick follow-up
      if (state.buffer.length > 0) {
        scheduleRetrievalFlush(
          state,
          RETRIEVAL_RETRY_INTERVAL_MS,
          () => flushRetrievalBuffer(state, driver, logger, retryOnTransient, withSession),
          logger,
        );
      }
      return;
    } catch (err) {
      state.consecutiveFailures++;
      // M9: Restore unflushed IDs for retry by prepending so overflow truncation
      // (splice from index 0) drops already-failed IDs first, preserving newer arrivals.
      state.buffer.unshift(...ids);
      if (state.buffer.length > MAX_RETRIEVAL_BUFFER_SIZE) {
        const dropped = state.buffer.length - MAX_RETRIEVAL_BUFFER_SIZE;
        state.buffer.splice(0, dropped); // Drop oldest entries
        logger.warn(
          `memory-neo4j: retrieval buffer overflow — dropped ${dropped} oldest IDs (cap: ${MAX_RETRIEVAL_BUFFER_SIZE})`,
        );
      }
      // M6: Reschedule with shorter retry interval to drain backlog faster.
      // Use exponential backoff capped at the normal interval to avoid hammering
      // a persistently-down Neo4j instance.
      const retryDelay = Math.min(
        RETRIEVAL_RETRY_INTERVAL_MS * 2 ** (state.consecutiveFailures - 1),
        RETRIEVAL_FLUSH_INTERVAL_MS,
      );
      scheduleRetrievalFlush(
        state,
        retryDelay,
        () => flushRetrievalBuffer(state, driver, logger, retryOnTransient, withSession),
        logger,
      );
      throw err;
    }
  } finally {
    state.flushInProgress = false;
  }
}
