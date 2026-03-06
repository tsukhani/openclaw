/**
 * Baseline snapshot management for CI regression detection (OP-128 Phase 4).
 *
 * Provides save/load of EvalRunResult snapshots and regression comparison
 * against configurable per-metric thresholds.
 */

import { readFile, writeFile } from "node:fs/promises";
import type { CiMetricsSummary, EvalRunResult, MetricDelta, RegressionReport } from "./types.js";

// ============================================================================
// Default regression thresholds (negative = minimum acceptable drop)
// ============================================================================

const DEFAULT_THRESHOLDS: Record<string, number> = {
  avgRecallAtK: -0.02, // recall may drop up to 2%
  avgPrecisionAtK: -0.01, // precision may drop up to 1%
  avgF1AtK: -0.015, // F1: midpoint
  avgMRR: -0.01,
  avgNDCG: -0.01,
  contextCompleteness: -0.02, // completeness rate may drop up to 2%
};

// ============================================================================
// Save / Load
// ============================================================================

/**
 * Persist an EvalRunResult as a JSON baseline file.
 */
export async function saveBaseline(result: EvalRunResult, filePath: string): Promise<void> {
  await writeFile(filePath, JSON.stringify(result, null, 2), "utf8");
}

/**
 * Load a baseline EvalRunResult from a JSON file.
 * Returns null if the file does not exist.
 */
export async function loadBaseline(filePath: string): Promise<EvalRunResult | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as EvalRunResult;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

// ============================================================================
// Regression detection
// ============================================================================

/**
 * Compare current results against a baseline and flag metric regressions.
 *
 * A regression is when `current − baseline < threshold` (i.e. the metric
 * dropped more than the allowed tolerance).
 *
 * @param current - Latest eval run
 * @param baseline - Saved baseline run
 * @param thresholds - Per-metric threshold overrides (defaults to DEFAULT_THRESHOLDS)
 */
export function computeRegression(
  current: EvalRunResult,
  baseline: EvalRunResult,
  thresholds: Partial<Record<string, number>> = {},
): RegressionReport {
  const merged = { ...DEFAULT_THRESHOLDS, ...thresholds };

  const metrics: Array<{ key: string; current: number; baseline: number }> = [
    {
      key: "avgRecallAtK",
      current: current.overall.avgRecallAtK,
      baseline: baseline.overall.avgRecallAtK,
    },
    {
      key: "avgPrecisionAtK",
      current: current.overall.avgPrecisionAtK,
      baseline: baseline.overall.avgPrecisionAtK,
    },
    {
      key: "avgF1AtK",
      current: current.overall.avgF1AtK,
      baseline: baseline.overall.avgF1AtK,
    },
    {
      key: "avgMRR",
      current: current.overall.avgMRR,
      baseline: baseline.overall.avgMRR,
    },
    {
      key: "avgNDCG",
      current: current.overall.avgNDCG,
      baseline: baseline.overall.avgNDCG,
    },
    ...(current.contextCompleteness && baseline.contextCompleteness
      ? [
          {
            key: "contextCompleteness",
            current: current.contextCompleteness.aggregate.completenessRate,
            baseline: baseline.contextCompleteness.aggregate.completenessRate,
          },
        ]
      : []),
  ];

  const regressions: MetricDelta[] = [];

  for (const m of metrics) {
    const threshold = merged[m.key] ?? -0.02;
    const delta = m.current - m.baseline;
    const isRegression = delta < threshold;

    if (isRegression) {
      regressions.push({
        metric: m.key,
        current: m.current,
        baseline: m.baseline,
        delta,
        threshold,
        isRegression: true,
      });
    }
  }

  return {
    hasRegression: regressions.length > 0,
    regressions,
    currentTimestamp: current.timestamp,
    baselineTimestamp: baseline.timestamp,
  };
}

// ============================================================================
// CI metrics summary
// ============================================================================

/**
 * Flatten an EvalRunResult into the CI-friendly summary object.
 */
export function buildCiSummary(result: EvalRunResult, regression: boolean): CiMetricsSummary {
  return {
    recall_at_k: result.overall.avgRecallAtK,
    precision_at_k: result.overall.avgPrecisionAtK,
    f1_at_k: result.overall.avgF1AtK,
    mrr: result.overall.avgMRR,
    ndcg_at_k: result.overall.avgNDCG,
    context_completeness: result.contextCompleteness?.aggregate.completenessRate ?? 0,
    regression,
    dataset: result.datasetName,
    variant: result.variant,
    timestamp: result.timestamp,
  };
}
