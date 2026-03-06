/**
 * Structured metrics and observability for memory-neo4j.
 *
 * Two tiers:
 *
 * 1. `MemoryMetrics` (singleton `metrics`) — lightweight in-memory counters for
 *    capture rates, dedup rates, phase timings, and error counts. Readable via
 *    `openclaw memory neo4j metrics` CLI or `metrics.snapshot()`.
 *
 *    Key counters:
 *      memories_stored          — memories successfully written to Neo4j
 *      memories_deduped         — memories skipped by semantic/exact dedup
 *      memories_rejected_gate   — messages dropped by the attention gate
 *      memories_rejected_conflict — memories invalidated by conflict detection
 *      phase_errors             — unhandled errors in any pipeline phase
 *      sleep_cycles_run         — number of sleep-cycle invocations
 *      sleep_cycle_duration_ms  — total elapsed ms across all sleep cycles
 *
 * 2. `MetricsCollector` / `LoggingMetricsCollector` — richer histogram/gauge
 *    collector used by the embedding and extraction subsystems to emit periodic
 *    structured JSON summaries to the logger.
 */

import type { Logger } from "./schema.js";

// ============================================================================
// Tier 1: simple in-memory counters (OP-124)
// ============================================================================

export class MemoryMetrics {
  private readonly counters = new Map<string, number>();

  /** Increment a named counter by `value` (default 1). */
  record(metric: string, value = 1): void {
    this.counters.set(metric, (this.counters.get(metric) ?? 0) + value);
  }

  /** Record elapsed milliseconds since `startMs` (from Date.now()). */
  recordDuration(metric: string, startMs: number): void {
    this.record(metric, Date.now() - startMs);
  }

  /** Return a shallow copy of all counters as a plain object. */
  snapshot(): Record<string, number> {
    return Object.fromEntries(this.counters);
  }

  /** Clear all counters — useful in tests and between benchmark runs. */
  reset(): void {
    this.counters.clear();
  }
}

/** Process-scoped singleton — import this directly from other modules. */
export const metrics = new MemoryMetrics();

// ============================================================================
// Tier 2: histogram/gauge collector used by embeddings and extraction
// ============================================================================

export interface MetricsCollector {
  increment(counter: string, value?: number): void;
  histogram(name: string, valueMs: number): void;
  gauge(name: string, value: number): void;
}

export const NO_OP_METRICS: MetricsCollector = {
  increment: () => {},
  histogram: () => {},
  gauge: () => {},
};

/**
 * Accumulates counts and latencies, emits a structured JSON summary
 * to logger.info() every `intervalMs` (default 60 000 ms).
 *
 * Counters and histograms reset after each flush; gauges persist
 * (they represent current state and should not be summed).
 */
export class LoggingMetricsCollector implements MetricsCollector {
  private readonly counters = new Map<string, number>();
  private readonly histograms = new Map<string, number[]>();
  private readonly gauges = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly logger: Logger;
  private readonly intervalMs: number;

  constructor(logger: Logger, intervalMs = 60_000) {
    this.logger = logger;
    this.intervalMs = intervalMs;
    this.scheduleFlush();
  }

  increment(counter: string, value = 1): void {
    this.counters.set(counter, (this.counters.get(counter) ?? 0) + value);
  }

  histogram(name: string, valueMs: number): void {
    const bucket = this.histograms.get(name) ?? [];
    bucket.push(valueMs);
    this.histograms.set(name, bucket);
  }

  gauge(name: string, value: number): void {
    this.gauges.set(name, value);
  }

  /**
   * Flush accumulated metrics to the logger as a single structured JSON line.
   * Called automatically on the configured interval; also callable directly
   * (e.g. in tests or on service shutdown).
   */
  flush(): void {
    const summary: Record<string, number> = {};

    for (const [k, v] of this.counters) {
      summary[k] = v;
    }

    for (const [k, values] of this.histograms) {
      if (values.length === 0) continue;
      const sorted = [...values].sort((a, b) => a - b);
      const len = sorted.length;
      summary[`${k}.count`] = len;
      summary[`${k}.p50`] = sorted[Math.floor(len * 0.5)] ?? sorted[0];
      summary[`${k}.p95`] = sorted[Math.floor(len * 0.95)] ?? sorted[len - 1];
      summary[`${k}.p99`] = sorted[Math.floor(len * 0.99)] ?? sorted[len - 1];
    }

    for (const [k, v] of this.gauges) {
      summary[k] = v;
    }

    if (Object.keys(summary).length > 0) {
      this.logger.info(`memory-neo4j: metrics ${JSON.stringify(summary)}`);
    }

    // Reset transient state; gauges are kept (represent current state)
    this.counters.clear();
    this.histograms.clear();
  }

  /** Cancel the periodic flush timer (call on service stop). */
  stop(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleFlush(): void {
    this.timer = setTimeout(() => {
      this.flush();
      this.scheduleFlush();
    }, this.intervalMs);
    // Allow the Node.js process to exit even while the timer is pending
    if (typeof this.timer === "object" && this.timer !== null && "unref" in this.timer) {
      (this.timer as { unref: () => void }).unref();
    }
  }
}
