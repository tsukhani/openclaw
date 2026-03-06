/**
 * Markdown reporter for the eval harness.
 *
 * Generates a human-readable markdown report suitable for GitHub comments,
 * docs, or archiving.
 */

import { writeFile } from "node:fs/promises";
import type { EvalRunResult } from "../types.js";

/**
 * Generate a markdown report from eval results.
 */
export function formatMarkdown(result: EvalRunResult): string {
  const lines: string[] = [];

  lines.push("# Memory-Neo4j Retrieval Evaluation Report");
  lines.push("");
  lines.push(`- **Dataset:** ${result.datasetName}`);
  lines.push(`- **Run ID:** ${result.runId}`);
  lines.push(`- **Timestamp:** ${result.timestamp}`);
  lines.push(`- **K:** ${result.k}`);
  lines.push(`- **Test Cases:** ${result.overall.caseCount}`);
  lines.push(`- **Duration:** ${(result.durationMs / 1000).toFixed(1)}s`);
  lines.push("");

  // Overall retrieval metrics table
  lines.push("## Overall Retrieval Metrics");
  lines.push("");
  lines.push("| Metric | Score | Target |");
  lines.push("|--------|-------|--------|");
  lines.push(`| Precision@${result.k} | ${pct(result.overall.avgPrecisionAtK)} | ≥ 60% |`);
  lines.push(`| Recall@${result.k} | ${pct(result.overall.avgRecallAtK)} | ≥ 80% |`);
  lines.push(`| F1@${result.k} | ${pct(result.overall.avgF1AtK)} | ≥ 70% |`);
  lines.push(`| MRR | ${pct(result.overall.avgMRR)} | ≥ 70% |`);
  lines.push(`| NDCG@${result.k} | ${pct(result.overall.avgNDCG)} | ≥ 75% |`);
  lines.push(`| Hit Rate | ${pct(result.overall.hitRate)} | — |`);
  lines.push("");

  // Per-ability breakdown
  if (result.abilityMetrics.length > 0) {
    lines.push("## Per-Ability Breakdown");
    lines.push("");
    lines.push(`| Ability | Cases | P@${result.k} | R@${result.k} | F1 | MRR | NDCG | Hit Rate |`);
    lines.push("|---------|-------|------|------|------|------|------|----------|");

    for (const m of result.abilityMetrics) {
      lines.push(
        `| ${m.ability} | ${m.caseCount} | ${pct(m.avgPrecisionAtK)} | ${pct(m.avgRecallAtK)} | ${pct(m.avgF1AtK)} | ${pct(m.avgMRR)} | ${pct(m.avgNDCG)} | ${pct(m.hitRate)} |`,
      );
    }
    lines.push("");
  }

  // Context completeness
  if (result.contextCompleteness) {
    const { aggregate } = result.contextCompleteness;
    lines.push("## Context Completeness (LLM Judge)");
    lines.push("");
    lines.push("| Verdict | Count | Rate |");
    lines.push("|---------|-------|------|");
    lines.push(`| COMPLETE | ${aggregate.complete} | ${pct(aggregate.completenessRate)} |`);
    lines.push(
      `| PARTIAL | ${aggregate.partial} | ${pct(aggregate.total > 0 ? aggregate.partial / aggregate.total : 0)} |`,
    );
    lines.push(
      `| INSUFFICIENT | ${aggregate.insufficient} | ${pct(aggregate.total > 0 ? aggregate.insufficient / aggregate.total : 0)} |`,
    );
    lines.push("");
  }

  // End-to-end accuracy
  if (result.endToEnd) {
    const { aggregate } = result.endToEnd;
    lines.push("## End-to-End Answer Accuracy");
    lines.push("");
    lines.push("| Verdict | Count | Rate |");
    lines.push("|---------|-------|------|");
    lines.push(`| Correct | ${aggregate.correct} | ${pct(aggregate.accuracyRate)} |`);
    lines.push(
      `| Partial | ${aggregate.partial} | ${pct(aggregate.total > 0 ? aggregate.partial / aggregate.total : 0)} |`,
    );
    lines.push(
      `| Incorrect | ${aggregate.incorrect} | ${pct(aggregate.total > 0 ? aggregate.incorrect / aggregate.total : 0)} |`,
    );
    lines.push("");
  }

  // Per-case details (collapsed for readability)
  lines.push("## Per-Case Details");
  lines.push("");
  lines.push("<details>");
  lines.push("<summary>Expand to see all test cases</summary>");
  lines.push("");
  lines.push("| Case ID | Ability | P@K | R@K | F1 | MRR | Completeness |");
  lines.push("|---------|---------|-----|-----|-----|-----|--------------|");

  for (const c of result.retrievalCases) {
    const completenessResult = result.contextCompleteness?.cases.find(
      (cc) => cc.caseId === c.caseId,
    );
    const completeness = completenessResult ? completenessResult.verdict : "—";
    lines.push(
      `| ${c.caseId} | ${c.ability} | ${pct(c.precisionAtK)} | ${pct(c.recallAtK)} | ${pct(c.f1AtK)} | ${dec(c.reciprocalRank)} | ${completeness} |`,
    );
  }

  lines.push("</details>");
  lines.push("");

  return lines.join("\n");
}

/**
 * Write eval results as a markdown file.
 */
export async function reportMarkdown(result: EvalRunResult, outputPath: string): Promise<void> {
  const md = formatMarkdown(result);
  await writeFile(outputPath, md, "utf-8");
}

/**
 * Print eval results as markdown to stdout.
 */
export function reportMarkdownStdout(result: EvalRunResult): void {
  console.log(formatMarkdown(result));
}

// ── Formatting helpers ────────────────────────────────────────────────────────

function pct(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

function dec(value: number): string {
  return value.toFixed(3);
}
