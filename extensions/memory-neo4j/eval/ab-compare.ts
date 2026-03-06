/**
 * A/B comparison runner for the eval harness (OP-128 Phase 3b).
 *
 * Runs two full eval runs (variant A and B) and computes:
 * - Per-metric deltas (B − A)
 * - Paired bootstrap confidence intervals (1000 samples, 95% CI)
 * - Winner determination based on significant improvements
 */

import type { ExtractionConfig, MemoryNeo4jConfig } from "../config.js";
import type { Embeddings } from "../embeddings.js";
import type { Neo4jMemoryClient } from "../neo4j-client.js";
import { runEval } from "./harness.js";
import type {
  AbComparisonResult,
  BootstrapCI,
  CaseRetrievalMetrics,
  EvalRunOptions,
  EvalRunResult,
  MetricComparison,
} from "./types.js";

// ============================================================================
// Bootstrap CI
// ============================================================================

/**
 * Compute a paired bootstrap confidence interval for (B − A) on a single metric.
 *
 * Uses simple resampling with replacement on the per-case metric values.
 * Cases are paired by position (same test cases must appear in same order).
 */
function pairedBootstrapCI(
  metricFn: (cases: CaseRetrievalMetrics[]) => number,
  casesA: CaseRetrievalMetrics[],
  casesB: CaseRetrievalMetrics[],
  nSamples = 1000,
): BootstrapCI {
  const n = Math.min(casesA.length, casesB.length);
  const observedA = metricFn(casesA.slice(0, n));
  const observedB = metricFn(casesB.slice(0, n));
  const observedDelta = observedB - observedA;

  const deltas: number[] = [];

  for (let i = 0; i < nSamples; i++) {
    const sampA: CaseRetrievalMetrics[] = [];
    const sampB: CaseRetrievalMetrics[] = [];
    for (let j = 0; j < n; j++) {
      const idx = Math.floor(Math.random() * n);
      sampA.push(casesA[idx]);
      sampB.push(casesB[idx]);
    }
    deltas.push(metricFn(sampB) - metricFn(sampA));
  }

  deltas.sort((a, b) => a - b);
  const lower = deltas[Math.floor(0.025 * nSamples)] ?? deltas[0] ?? 0;
  const upper = deltas[Math.floor(0.975 * nSamples)] ?? deltas[nSamples - 1] ?? 0;

  return { lower, upper, mean: observedDelta };
}

// ============================================================================
// Metric extractors
// ============================================================================

type MetricSpec = {
  name: string;
  fn: (cases: CaseRetrievalMetrics[]) => number;
  overallA: (r: EvalRunResult) => number;
  overallB: (r: EvalRunResult) => number;
};

function avg(fn: (c: CaseRetrievalMetrics) => number): (cases: CaseRetrievalMetrics[]) => number {
  return (cases) => (cases.length === 0 ? 0 : cases.reduce((s, c) => s + fn(c), 0) / cases.length);
}

const METRIC_SPECS: MetricSpec[] = [
  {
    name: "precision",
    fn: avg((c) => c.precisionAtK),
    overallA: (r) => r.overall.avgPrecisionAtK,
    overallB: (r) => r.overall.avgPrecisionAtK,
  },
  {
    name: "recall",
    fn: avg((c) => c.recallAtK),
    overallA: (r) => r.overall.avgRecallAtK,
    overallB: (r) => r.overall.avgRecallAtK,
  },
  {
    name: "f1",
    fn: avg((c) => c.f1AtK),
    overallA: (r) => r.overall.avgF1AtK,
    overallB: (r) => r.overall.avgF1AtK,
  },
  {
    name: "mrr",
    fn: avg((c) => c.reciprocalRank),
    overallA: (r) => r.overall.avgMRR,
    overallB: (r) => r.overall.avgMRR,
  },
  {
    name: "ndcg",
    fn: avg((c) => c.ndcgAtK),
    overallA: (r) => r.overall.avgNDCG,
    overallB: (r) => r.overall.avgNDCG,
  },
];

// ============================================================================
// Context completeness CI (scalar, not per-case)
// ============================================================================

/**
 * Add context completeness comparison if both runs include judge results.
 * Uses a simpler per-case bootstrap on binary complete/not values.
 */
function buildCompletenessComparison(
  runA: EvalRunResult,
  runB: EvalRunResult,
  nSamples: number,
): MetricComparison | null {
  if (!runA.contextCompleteness || !runB.contextCompleteness) return null;

  const valA = runA.contextCompleteness.aggregate.completenessRate;
  const valB = runB.contextCompleteness.aggregate.completenessRate;

  // Bootstrap using binary per-case complete flags
  const binaryA = runA.contextCompleteness.cases.map((c) => (c.verdict === "COMPLETE" ? 1 : 0));
  const binaryB = runB.contextCompleteness.cases.map((c) => (c.verdict === "COMPLETE" ? 1 : 0));
  const n = Math.min(binaryA.length, binaryB.length);

  const deltas: number[] = [];
  for (let i = 0; i < nSamples; i++) {
    let sumA = 0;
    let sumB = 0;
    for (let j = 0; j < n; j++) {
      const idx = Math.floor(Math.random() * n);
      sumA += binaryA[idx] ?? 0;
      sumB += binaryB[idx] ?? 0;
    }
    deltas.push(sumB / n - sumA / n);
  }

  deltas.sort((a, b) => a - b);
  const lower = deltas[Math.floor(0.025 * nSamples)] ?? 0;
  const upper = deltas[Math.floor(0.975 * nSamples)] ?? 0;
  const delta = valB - valA;

  return {
    metricName: "context_completeness",
    variantA: valA,
    variantB: valB,
    delta,
    ci: { lower, upper, mean: delta },
    significant: lower > 0 || upper < 0,
  };
}

// ============================================================================
// Main A/B runner
// ============================================================================

export type AbCompareOptions = {
  /**
   * Shared options forwarded to runEval for both variants.
   * `dataset` and `variant` are provided as explicit parameters and must not be set here.
   */
  evalOptions?: Omit<EvalRunOptions, "variant" | "dataset">;
  /** Number of bootstrap resamples (default: 1000). */
  bootstrapSamples?: number;
};

/**
 * Run a full A/B comparison between two named eval variants.
 *
 * Both runs use the same dataset, k, and judge settings.
 * Returns per-metric comparisons with bootstrap CIs and a winner determination.
 */
export async function runAbComparison(
  db: Neo4jMemoryClient,
  embeddings: Embeddings,
  extractionConfig: ExtractionConfig,
  cfg: MemoryNeo4jConfig,
  datasetName: string,
  variantAName: string,
  variantBName: string,
  options: AbCompareOptions = {},
): Promise<AbComparisonResult> {
  const { evalOptions = {}, bootstrapSamples = 1000 } = options;

  const baseOpts: EvalRunOptions = {
    dataset: datasetName,
    format: "json", // suppress default console output; callers handle display
    ...evalOptions,
  };

  // Run variant A
  const runA = await runEval(db, embeddings, extractionConfig, cfg, {
    ...baseOpts,
    variant: variantAName,
  });

  // Run variant B
  const runB = await runEval(db, embeddings, extractionConfig, cfg, {
    ...baseOpts,
    variant: variantBName,
  });

  // Build per-metric comparisons
  const comparisons: MetricComparison[] = METRIC_SPECS.map((spec) => {
    const valA = spec.overallA(runA);
    const valB = spec.overallB(runB);
    const delta = valB - valA;
    const ci = pairedBootstrapCI(
      spec.fn,
      runA.retrievalCases,
      runB.retrievalCases,
      bootstrapSamples,
    );
    return {
      metricName: spec.name,
      variantA: valA,
      variantB: valB,
      delta,
      ci,
      significant: ci.lower > 0 || ci.upper < 0,
    };
  });

  // Add completeness comparison if available
  const completeness = buildCompletenessComparison(runA, runB, bootstrapSamples);
  if (completeness) {
    comparisons.push(completeness);
  }

  // Determine winner
  const sigFavorA = comparisons.filter((m) => m.significant && m.delta < 0).length;
  const sigFavorB = comparisons.filter((m) => m.significant && m.delta > 0).length;

  let winner: "A" | "B" | "no_significant_difference";
  if (sigFavorB > sigFavorA) {
    winner = "B";
  } else if (sigFavorA > sigFavorB) {
    winner = "A";
  } else {
    winner = "no_significant_difference";
  }

  return {
    variantA: variantAName,
    variantB: variantBName,
    datasetName,
    k: runA.k,
    timestamp: new Date().toISOString(),
    runA,
    runB,
    metrics: comparisons,
    winner,
  };
}

// ============================================================================
// Console reporter for A/B results
// ============================================================================

/**
 * Print A/B comparison to stdout in a readable table.
 */
export function reportAbComparison(result: AbComparisonResult): void {
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║              Memory-Neo4j A/B Variant Comparison             ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log(`\n  Dataset:   ${result.datasetName}`);
  console.log(`  Variant A: ${result.variantA}`);
  console.log(`  Variant B: ${result.variantB}`);
  console.log(`  K:         ${result.k}`);
  console.log(`  Timestamp: ${result.timestamp}`);
  console.log(
    `\n  Winner: ${result.winner === "no_significant_difference" ? "No significant difference" : `Variant ${result.winner}`}`,
  );

  console.log("\n┌─ Metric Comparison (B − A)");
  const hdr = `│  ${"Metric".padEnd(22)} ${"A".padStart(7)} ${"B".padStart(7)} ${"Delta".padStart(8)} ${"95% CI".padStart(18)} ${"Sig?".padStart(5)}`;
  console.log(hdr);
  console.log(`│  ${"─".repeat(70)}`);

  for (const m of result.metrics) {
    const sig = m.significant ? (m.delta > 0 ? " ▲" : " ▼") : "  ";
    const ci = `[${(m.ci.lower * 100).toFixed(1)}%, ${(m.ci.upper * 100).toFixed(1)}%]`;
    const row =
      `│  ${m.metricName.padEnd(22)}` +
      ` ${pct(m.variantA)}` +
      ` ${pct(m.variantB)}` +
      ` ${delta(m.delta)}` +
      `  ${ci.padStart(18)}` +
      `${sig}`;
    console.log(row);
  }
  console.log("└\n");
}

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`.padStart(7);
}

function delta(v: number): string {
  const sign = v >= 0 ? "+" : "";
  return `${sign}${(v * 100).toFixed(1)}%`.padStart(8);
}
