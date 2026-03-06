/**
 * Core eval runner for the memory-neo4j evaluation harness (OP-128).
 *
 * Orchestrates the full evaluation pipeline:
 * 1. Load dataset (custom fixtures or LongMemEval)
 * 2. For each test case: store memories → hybridSearch → compute metrics
 * 3. Run LLM judge for context completeness (Tier 1)
 * 4. Optionally generate + grade answers (Tier 2 E2E)
 * 5. Aggregate and report results
 *
 * Phase 3+4 additions:
 * - Named config variants applied to hybridSearch (A/B testing)
 * - Signal attribution stats
 * - CI mode: regression detection against a saved baseline, JSON output
 *
 * Uses an ephemeral agentId per test case to avoid polluting production data.
 * All test memories are cleaned up after each case via deleteMemoriesByIds.
 */

import { randomUUID } from "node:crypto";
import type { ExtractionConfig, MemoryNeo4jConfig } from "../config.js";
import type { Embeddings } from "../embeddings.js";
import { runBackgroundExtraction } from "../extractor.js";
import type { Neo4jMemoryClient } from "../neo4j-client.js";
import type { Logger, MemoryCategory } from "../schema.js";
import { hybridSearch } from "../search.js";
import { buildCiSummary, computeRegression, loadBaseline, saveBaseline } from "./baseline.js";
import { loadDataset } from "./datasets/loader.js";
import { LlmJudge } from "./judges/llm-judge.js";
import {
  aggregateContextCompleteness,
  evaluateContextCompleteness,
} from "./metrics/context-completeness.js";
import { aggregateEndToEnd, generateAnswer, gradeAnswer } from "./metrics/end-to-end.js";
import { aggregateByAbility, aggregateOverall, computeCaseMetrics } from "./metrics/retrieval.js";
import { computeSignalAttributionStats } from "./metrics/signal-attribution.js";
import { reportConsole } from "./reporters/console.js";
import { formatJson, reportJson, reportJsonStdout } from "./reporters/json.js";
import { reportMarkdown, reportMarkdownStdout } from "./reporters/markdown.js";
import type {
  CaseRetrievalMetrics,
  ContextCompletenessResult,
  EndToEndResult,
  EvalRunOptions,
  EvalRunResult,
  RetrievedMemory,
  TestCase,
} from "./types.js";
import type { SearchConfig } from "./variants.js";
import { resolveVariant } from "./variants.js";

/**
 * Run the full evaluation pipeline.
 *
 * @param db - Initialized Neo4j memory client
 * @param embeddings - Embeddings instance
 * @param extractionConfig - LLM config (used for entity extraction + LLM judge)
 * @param cfg - Plugin config
 * @param options - Eval run options
 * @returns Full evaluation results
 */
export async function runEval(
  db: Neo4jMemoryClient,
  embeddings: Embeddings,
  extractionConfig: ExtractionConfig,
  cfg: MemoryNeo4jConfig,
  options: EvalRunOptions,
): Promise<EvalRunResult> {
  const startedAt = Date.now();
  const runId = randomUUID().slice(0, 8);
  const k = options.k ?? 5;
  const agentPrefix = `eval-${runId}`;
  const variantName = options.variant ?? "default";

  // Minimal logger for extraction (writes to stderr to avoid polluting eval output)
  const logger: Logger = {
    info: (msg) => process.stderr.write(`[eval] ${msg}\n`),
    warn: (msg) => process.stderr.write(`[eval:warn] ${msg}\n`),
    error: (msg) => process.stderr.write(`[eval:error] ${msg}\n`),
    debug: () => {},
  };

  // Resolve variant overrides
  const variantOverrides = resolveVariant(variantName);

  await db.ensureInitialized();

  // Load dataset
  const testCases = await loadDataset(options.dataset, {
    ability: options.ability,
    limit: undefined,
  });

  if (testCases.length === 0) {
    throw new Error(
      `No test cases found for dataset "${options.dataset}"${options.ability ? ` ability "${options.ability}"` : ""}`,
    );
  }

  const judge = extractionConfig.enabled ? new LlmJudge(extractionConfig) : null;

  const retrievalCases: CaseRetrievalMetrics[] = [];
  const contextResults: ContextCompletenessResult[] = [];
  const e2eResults: EndToEndResult[] = [];

  // In production mode, query the real agent's memories instead of injecting test data.
  const productionAgentId = options.productionMode ? (options.agentId ?? "main") : null;

  // Run each test case
  for (const tc of testCases) {
    const caseAgentId = productionAgentId ?? `${agentPrefix}-${tc.id}`;
    const storedIds: string[] = [];

    try {
      if (!productionAgentId) {
        // 1. Store memories for this test case
        storedIds.push(...(await storeTestMemories(db, embeddings, tc, caseAgentId)));

        // 1b. Run entity extraction to populate the entity graph so graph signal is non-zero.
        //     Without this, graphSearch returns 0 results because no Entity nodes exist.
        if (extractionConfig.enabled && tc.memories.length > 0) {
          await extractMemoriesInBatches(tc.memories, db, embeddings, extractionConfig, logger);
        }
      }

      // 2. Resolve search parameters for this variant
      const { graphEnabled, searchOptions } = buildSearchOptions(
        variantOverrides,
        extractionConfig,
        cfg,
      );

      // 3. Run hybridSearch
      const rawResults = await hybridSearch(
        db,
        embeddings,
        tc.question,
        k,
        caseAgentId,
        graphEnabled,
        searchOptions,
      );

      const retrieved: RetrievedMemory[] = rawResults.map((r, i) => ({
        id: r.id,
        text: r.text,
        score: r.score,
        rank: i + 1,
        signals: r.signals,
      }));

      // 4. Compute retrieval metrics
      const caseMetrics = computeCaseMetrics(
        tc.id,
        tc.ability,
        tc.question,
        retrieved,
        tc.gold_memory_ids,
        k,
      );
      retrievalCases.push(caseMetrics);

      // 5. Context completeness (LLM judge, Tier 1)
      if (judge) {
        const retrievedTexts = retrieved.map((r) => r.text);
        const completeness = await evaluateContextCompleteness(
          judge,
          tc.id,
          tc.ability,
          tc.question,
          retrievedTexts,
        );
        contextResults.push(completeness);

        // 6. End-to-end evaluation (Tier 2)
        if (options.endToEnd) {
          const answer = await generateAnswer(judge, tc.question, retrievedTexts);
          const graded = await gradeAnswer(
            judge,
            tc.id,
            tc.ability,
            tc.question,
            tc.golden_answer,
            answer,
          );
          e2eResults.push(graded);
        }
      }
    } finally {
      // Skip cleanup in production mode — we don't own those memories
      if (!productionAgentId && storedIds.length > 0) {
        await db.deleteMemoriesByIds(storedIds).catch(() => {
          // Non-critical cleanup failure
        });
        // Also remove any Entity nodes that became orphaned after memory deletion
        const orphans = await db.findOrphanEntities().catch(() => []);
        if (orphans.length > 0) {
          await db.deleteOrphanEntities(orphans.map((e) => e.id)).catch(() => {
            // Non-critical cleanup failure
          });
        }
      }
    }
  }

  // Aggregate results
  const abilityMetrics = aggregateByAbility(retrievalCases);
  const overall = aggregateOverall(retrievalCases);

  const contextAggregate =
    contextResults.length > 0 ? aggregateContextCompleteness(contextResults) : undefined;

  const e2eAggregate = e2eResults.length > 0 ? aggregateEndToEnd(e2eResults) : undefined;

  // Signal attribution (optional)
  const signalAttribution = options.signalAttribution
    ? computeSignalAttributionStats(retrievalCases)
    : undefined;

  const result: EvalRunResult = {
    runId,
    timestamp: new Date().toISOString(),
    datasetName: options.dataset,
    variant: variantName,
    k,
    agentNamespace: agentPrefix,
    retrievalCases,
    abilityMetrics,
    overall,
    contextCompleteness: contextAggregate
      ? { cases: contextResults, aggregate: contextAggregate }
      : undefined,
    endToEnd: e2eAggregate ? { cases: e2eResults, aggregate: e2eAggregate } : undefined,
    signalAttribution,
    durationMs: Date.now() - startedAt,
  };

  // CI mode: regression detection + JSON output to stdout
  if (options.ciMode) {
    await handleCiMode(result, options);
    return result;
  }

  // Save baseline if requested (non-CI path)
  if (options.saveBaselinePath) {
    await saveBaseline(result, options.saveBaselinePath);
  }

  // Report
  await dispatchReporter(result, options);

  return result;
}

// ── Variant → search options translation ──────────────────────────────────────

type SearchOptions = Parameters<typeof hybridSearch>[6];

/**
 * Build hybridSearch call parameters from a variant config + plugin config.
 */
function buildSearchOptions(
  variant: Partial<SearchConfig>,
  extractionConfig: ExtractionConfig,
  cfg: MemoryNeo4jConfig,
): { graphEnabled: boolean; searchOptions: SearchOptions } {
  // Graph enabled: variant can force-disable, otherwise check extraction config + depth
  const graphEnabled =
    variant.graphEnabled !== undefined
      ? variant.graphEnabled
      : extractionConfig.enabled && cfg.graphSearchDepth > 0;

  // Recency weight: can be disabled or boosted
  let recencyWeight = cfg.recencyWeight;
  if (variant.temporalRecencyEnabled === false) {
    recencyWeight = 0;
  } else if (variant.temporalRecencyBoost !== undefined) {
    recencyWeight = recencyWeight * variant.temporalRecencyBoost;
  }

  // Weight override: when vector/bm25 weights are explicitly set, bypass adaptive weights.
  // freshnessWeight defaults to 0.2 (the non-updates baseline) when not explicitly set.
  let weightOverride: [number, number, number, number] | undefined;
  if (variant.vectorWeight !== undefined || variant.bm25Weight !== undefined) {
    const vw = variant.vectorWeight ?? 1.0;
    const bw = variant.bm25Weight ?? 1.0;
    const gw = graphEnabled ? 1.0 : 0.0;
    weightOverride = [vw, bw, gw, 0.2];
  }

  return {
    graphEnabled,
    searchOptions: {
      graphSearchDepth: variant.graphDepthLimit ?? cfg.graphSearchDepth,
      graphSeedCap: variant.graphSeedCap ?? cfg.graphSeedCap,
      graphRelTypes: cfg.graphRelTypes,
      recencyWeight,
      weightOverride,
    },
  };
}

// ── CI mode handler ────────────────────────────────────────────────────────────

async function handleCiMode(result: EvalRunResult, options: EvalRunOptions): Promise<void> {
  let hasRegression = false;

  if (options.baselinePath) {
    const baseline = await loadBaseline(options.baselinePath);
    if (baseline) {
      const report = computeRegression(result, baseline);
      hasRegression = report.hasRegression;

      if (report.hasRegression) {
        process.stderr.write(
          `[eval] Regression detected against baseline (${options.baselinePath}):\n`,
        );
        for (const r of report.regressions) {
          process.stderr.write(
            `  ${r.metric}: ${(r.current * 100).toFixed(2)}% vs baseline ${(r.baseline * 100).toFixed(2)}% (delta ${(r.delta * 100).toFixed(2)}%, threshold ${(r.threshold * 100).toFixed(2)}%)\n`,
          );
        }
      }
    } else {
      process.stderr.write(
        `[eval] Warning: baseline file not found at "${options.baselinePath}" — skipping regression check.\n`,
      );
    }
  }

  if (options.saveBaselinePath) {
    await saveBaseline(result, options.saveBaselinePath);
  }

  const summary = buildCiSummary(result, hasRegression);
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");

  if (hasRegression) {
    process.exitCode = 1;
  }
}

// ── Memory ingestion ──────────────────────────────────────────────────────────

/**
 * Run entity extraction for all memories in batches of 5.
 * Awaiting all extractions before hybridSearch ensures Entity nodes exist for graph signal.
 */
async function extractMemoriesInBatches(
  memories: TestCase["memories"],
  db: Neo4jMemoryClient,
  embeddings: Embeddings,
  extractionConfig: ExtractionConfig,
  logger: Logger,
): Promise<void> {
  const BATCH_SIZE = 5;
  for (let i = 0; i < memories.length; i += BATCH_SIZE) {
    const batch = memories.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map((mem) =>
        runBackgroundExtraction(mem.id, mem.text, db, embeddings, extractionConfig, logger, 0),
      ),
    );
  }
}

/**
 * Store all memories for a test case and return their IDs.
 * Generates embeddings in a single batch call for efficiency.
 */
async function storeTestMemories(
  db: Neo4jMemoryClient,
  embeddings: Embeddings,
  tc: TestCase,
  agentId: string,
): Promise<string[]> {
  if (tc.memories.length === 0) return [];

  // Batch embed all memory texts
  const texts = tc.memories.map((m) => m.text);
  const allEmbeddings = await embeddings.embedBatch(texts);

  const storedIds: string[] = [];

  for (let i = 0; i < tc.memories.length; i++) {
    const mem = tc.memories[i];
    const embedding = allEmbeddings[i];

    const input = {
      id: mem.id,
      text: mem.text,
      embedding,
      importance: mem.importance,
      category: normalizeCategory(mem.category),
      source: "import" as const,
      extractionStatus: "pending" as const,
      agentId,
      sessionKey: mem.sessionKey,
      validFrom: mem.createdAt,
    };

    await db.storeMemory(input);
    storedIds.push(mem.id);
  }

  return storedIds;
}

/** Map fixture category string to valid MemoryCategory. */
function normalizeCategory(raw: string): MemoryCategory {
  const valid: Record<string, MemoryCategory> = {
    core: "core",
    preference: "preference",
    fact: "fact",
    decision: "decision",
    entity: "entity",
    lesson: "lesson",
    other: "other",
  };
  return valid[raw] ?? "other";
}

// ── Reporter dispatch ─────────────────────────────────────────────────────────

async function dispatchReporter(result: EvalRunResult, options: EvalRunOptions): Promise<void> {
  const format = options.format ?? "console";

  switch (format) {
    case "console":
      reportConsole(result);
      break;
    case "json":
      if (options.outputFile) {
        await reportJson(result, options.outputFile);
      } else {
        reportJsonStdout(result);
      }
      break;
    case "markdown":
      if (options.outputFile) {
        await reportMarkdown(result, options.outputFile);
      } else {
        reportMarkdownStdout(result);
      }
      break;
    default:
      reportConsole(result);
  }
}

// Re-export formatJson so CLI can pass results through
export { formatJson };
