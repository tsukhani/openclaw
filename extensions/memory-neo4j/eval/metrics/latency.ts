/**
 * Latency distribution statistics for the eval harness.
 *
 * Computes percentiles (p50/p95/p99), mean, stddev, min, max from an array
 * of per-query latency samples. Uses sorted-array indexing for percentiles
 * and population standard deviation (full population, not sample).
 */

import type { LatencyStats } from "../types.js";

const ZERO_STATS: LatencyStats = {
  count: 0,
  min: 0,
  max: 0,
  mean: 0,
  stddev: 0,
  p50: 0,
  p95: 0,
  p99: 0,
};

/**
 * Compute latency distribution statistics from an array of latency samples (ms).
 *
 * Percentiles use floor-rank indexing on the sorted array:
 *   p_X = sorted[floor(X/100 * count)]
 */
export function computeLatencyStats(samples: number[]): LatencyStats {
  if (samples.length === 0) return ZERO_STATS;

  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;

  const sum = sorted.reduce((s, v) => s + v, 0);
  const mean = sum / n;

  // Population standard deviation (dividing by N, not N-1)
  const sqDiffSum = sorted.reduce((s, v) => s + (v - mean) ** 2, 0);
  const stddev = Math.sqrt(sqDiffSum / n);

  return {
    count: n,
    min: sorted[0],
    max: sorted[n - 1],
    mean,
    stddev,
    p50: sorted[Math.floor(0.5 * n)],
    p95: sorted[Math.floor(0.95 * n)],
    p99: sorted[Math.floor(0.99 * n)],
  };
}

/**
 * Compute latency statistics grouped by ability category.
 */
export function computeLatencyStatsByAbility(
  cases: Array<{ ability: string; latencyMs: number }>,
): Record<string, LatencyStats> {
  const byAbility = new Map<string, number[]>();

  for (const c of cases) {
    const list = byAbility.get(c.ability) ?? [];
    list.push(c.latencyMs);
    byAbility.set(c.ability, list);
  }

  const result: Record<string, LatencyStats> = {};
  for (const [ability, samples] of byAbility) {
    result[ability] = computeLatencyStats(samples);
  }
  return result;
}
