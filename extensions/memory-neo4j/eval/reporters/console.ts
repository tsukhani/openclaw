/**
 * Console reporter for the eval harness.
 *
 * Outputs a human-readable table with per-ability retrieval metrics
 * and context completeness rates.
 */

import type { EvalRunResult } from "../types.js";

/**
 * Print eval results to stdout as a formatted table.
 */
export function reportConsole(result: EvalRunResult): void {
  const { overall, abilityMetrics, contextCompleteness, endToEnd } = result;

  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║           Memory-Neo4j Retrieval Evaluation Results           ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log(`\n  Dataset:   ${result.datasetName}`);
  console.log(`  Run ID:    ${result.runId}`);
  console.log(`  Timestamp: ${result.timestamp}`);
  console.log(`  K:         ${result.k}`);
  console.log(`  Cases:     ${result.overall.caseCount}`);
  console.log(`  Duration:  ${(result.durationMs / 1000).toFixed(1)}s`);

  // Overall retrieval metrics
  console.log("\n┌─ Overall Retrieval Metrics");
  console.log("│");
  console.log(
    `│  Precision@${result.k}:  ${pct(overall.avgPrecisionAtK)}  ${bar(overall.avgPrecisionAtK)}`,
  );
  console.log(
    `│  Recall@${result.k}:     ${pct(overall.avgRecallAtK)}  ${bar(overall.avgRecallAtK)}`,
  );
  console.log(`│  F1@${result.k}:         ${pct(overall.avgF1AtK)}  ${bar(overall.avgF1AtK)}`);
  console.log(`│  MRR:          ${pct(overall.avgMRR)}  ${bar(overall.avgMRR)}`);
  console.log(`│  NDCG@${result.k}:      ${pct(overall.avgNDCG)}  ${bar(overall.avgNDCG)}`);
  console.log(`│  Hit Rate:     ${pct(overall.hitRate)}  ${bar(overall.hitRate)}`);
  console.log("└");

  // Per-ability breakdown
  if (abilityMetrics.length > 0) {
    console.log("\n┌─ Per-Ability Breakdown");
    console.log("│");
    const header = `│  ${"Ability".padEnd(14)} ${"P@K".padStart(6)} ${"R@K".padStart(6)} ${"F1".padStart(6)} ${"MRR".padStart(6)} ${"NDCG".padStart(6)} ${"HitRate".padStart(8)} ${"N".padStart(4)}`;
    console.log(header);
    console.log(`│  ${"─".repeat(60)}`);

    for (const m of abilityMetrics) {
      const row =
        `│  ${m.ability.padEnd(14)}` +
        ` ${pctShort(m.avgPrecisionAtK)}` +
        ` ${pctShort(m.avgRecallAtK)}` +
        ` ${pctShort(m.avgF1AtK)}` +
        ` ${pctShort(m.avgMRR)}` +
        ` ${pctShort(m.avgNDCG)}` +
        `     ${pctShort(m.hitRate)}` +
        `   ${String(m.caseCount).padStart(4)}`;
      console.log(row);
    }
    console.log("└");
  }

  // Context completeness
  if (contextCompleteness) {
    const { aggregate } = contextCompleteness;
    console.log("\n┌─ Context Completeness (LLM Judge)");
    console.log("│");
    console.log(
      `│  COMPLETE:     ${pct(aggregate.completenessRate)}  ${bar(aggregate.completenessRate)}  (${aggregate.complete}/${aggregate.total})`,
    );
    console.log(
      `│  PARTIAL:      ${pct(aggregate.partial / aggregate.total)}  (${aggregate.partial})`,
    );
    console.log(
      `│  INSUFFICIENT: ${pct(aggregate.insufficient / aggregate.total)}  (${aggregate.insufficient})`,
    );
    console.log("└");
  }

  // End-to-end accuracy
  if (endToEnd) {
    const { aggregate } = endToEnd;
    console.log("\n┌─ End-to-End Answer Accuracy (LLM Judge)");
    console.log("│");
    console.log(
      `│  Correct:   ${pct(aggregate.accuracyRate)}  ${bar(aggregate.accuracyRate)}  (${aggregate.correct}/${aggregate.total})`,
    );
    console.log(`│  Partial:   (${aggregate.partial})`);
    console.log(`│  Incorrect: (${aggregate.incorrect})`);
    console.log("└");
  }

  console.log("");
}

// ── Formatting helpers ──────────────────────────────────────────────────────

const BAR_WIDTH = 16;

function bar(ratio: number): string {
  const clamped = Math.min(1, Math.max(0, ratio));
  const filled = Math.round(clamped * BAR_WIDTH);
  return "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
}

function pct(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`.padStart(6);
}

function pctShort(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`.padStart(6);
}
