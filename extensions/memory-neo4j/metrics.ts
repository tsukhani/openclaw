/**
 * Structured metrics and observability for memory-neo4j.
 *
 * Counters:
 *   memories.stored, memories.recalled, memories.decayed, memories.failed
 *   auto_capture.fired, auto_capture.skipped, auto_capture.circuit_open
 *   extraction.success, extraction.failed, extraction.skipped
 *   conflicts.detected, conflicts.superseded
 *   embeddings.cache_hit, embeddings.cache_miss
 *
 * Histograms: auto_recall.latency_ms, auto_capture.latency_ms,
 *             extraction.latency_ms, embedding.latency_ms
 *
 * Gauges: memories.total, memories.pending_extraction
 */

import type { Logger } from "./schema.js";

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
