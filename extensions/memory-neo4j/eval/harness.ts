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
 * Shared-haystack optimisation (LoCoMo / large benchmarks):
 * When multiple test cases share the same haystackId, memories are stored
 * once for the whole group (rather than per QA pair) and cleaned up once
 * after the group completes. For LoCoMo (10 samples × ~580 turns × ~200 QA
 * pairs each) this reduces embed+write+delete operations from ~1.1 M to ~5.9 K
 * — roughly a 200× speedup.
 *
 * Backward-compatible: cases without haystackId retain the original per-case
 * store/cleanup behaviour.
 */

import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
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
import { computeLatencyStats, computeLatencyStatsByAbility } from "./metrics/latency.js";
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
  IngestionMetrics,
  PerformanceMetrics,
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
  let testCases = await loadDataset(options.dataset, {
    ability: options.ability,
    limit: options.limit,
  });

  // Filter by case ID if specified (supports comma-separated list)
  if (options.caseId) {
    const ids = new Set(options.caseId.split(",").map((s) => s.trim()));
    testCases = testCases.filter((tc) => ids.has(tc.id));
  }

  if (testCases.length === 0) {
    throw new Error(
      `No test cases found for dataset "${options.dataset}"${options.ability ? ` ability "${options.ability}"` : ""}${options.caseId ? ` case "${options.caseId}"` : ""}`,
    );
  }

  process.stderr.write(
    `[eval] Loaded ${testCases.length} test cases from "${options.dataset}" (run ${runId}, k=${k}, variant=${variantName})\n`,
  );

  // Create the judge only when extraction config has LLM credentials.
  // Gate context completeness and E2E on explicit user options.
  const judgeAvailable = extractionConfig.enabled;
  const wantJudge = options.judgeContext !== false; // default: true when judge available
  const wantE2E = options.endToEnd === true;

  if (!judgeAvailable && (wantJudge || wantE2E)) {
    process.stderr.write(
      `[eval] Warning: LLM judge unavailable (extraction config disabled). ` +
        `Context completeness and E2E evaluation will be skipped.\n`,
    );
  }

  const judge = judgeAvailable && (wantJudge || wantE2E) ? new LlmJudge(extractionConfig) : null;

  const retrievalCases: CaseRetrievalMetrics[] = [];
  const contextResults: ContextCompletenessResult[] = [];
  const e2eResults: EndToEndResult[] = [];

  // ── Performance tracking ──────────────────────────────────────────────────
  const latencySamples: Array<{ ability: string; latencyMs: number }> = [];
  let ingestionTotalMemories = 0;
  let ingestionTotalMs = 0;

  // In production mode, query the real agent's memories instead of injecting test data.
  const productionAgentId = options.productionMode ? (options.agentId ?? "main") : null;

  const log = (msg: string) => process.stderr.write(`[eval] ${msg}\n`);

  // ── Shared-haystack grouping ────────────────────────────────────────────────
  // Group test cases by haystackId so memories shared across QA pairs (e.g.
  // LoCoMo conversation turns) are stored once per group instead of once per
  // test case. Cases without a haystackId each get their own singleton group.

  type HaystackGroup = {
    haystackId: string;
    agentId: string;
    cases: TestCase[];
  };

  const groups: HaystackGroup[] = [];
  const seenHaystacks = new Map<string, HaystackGroup>();

  for (const tc of testCases) {
    if (tc.haystackId) {
      let group = seenHaystacks.get(tc.haystackId);
      if (!group) {
        group = {
          haystackId: tc.haystackId,
          agentId: productionAgentId ?? `${agentPrefix}-h-${tc.haystackId}`,
          cases: [],
        };
        groups.push(group);
        seenHaystacks.set(tc.haystackId, group);
      }
      group.cases.push(tc);
    } else {
      // No shared haystack — singleton group; agentId is per test case as before.
      groups.push({
        haystackId: tc.id,
        agentId: productionAgentId ?? `${agentPrefix}-${tc.id}`,
        cases: [tc],
      });
    }
  }

  // ── Resolve search parameters once (same for all cases in a run) ───────────
  const { graphEnabled, searchOptions } = buildSearchOptions(
    variantOverrides,
    extractionConfig,
    cfg,
  );

  // ── Warm-up: cold pass latency samples (collected separately) ──────────────
  const coldPassSamples: Array<{ ability: string; latencyMs: number }> = [];

  // Track all stored IDs across groups for fatal-error cleanup
  const allStoredIds: string[] = [];

  // ── Progress tracking across groups ─────────────────────────────────────────
  const totalCases = testCases.length;
  let globalCaseIdx = 0;
  let searchErrors = 0;
  let consecutiveSearchErrors = 0;
  let judgeErrors = 0;
  let e2eErrors = 0;

  const searchPhaseT0 = performance.now();
  let judgePhaseMs = 0;
  let e2ePhaseMs = 0;

  // ── Run each group ──────────────────────────────────────────────────────────
  try {
    for (const group of groups) {
      const { agentId, cases } = group;
      // All cases in a shared-haystack group have identical memories; use first case.
      const representativeCase = cases[0];
      const storedIds: string[] = [];

      try {
        if (!productionAgentId) {
          // Store the shared haystack memories ONCE for the whole group.
          const ingestT0 = performance.now();
          storedIds.push(...(await storeTestMemories(db, embeddings, representativeCase, agentId)));
          allStoredIds.push(...storedIds);

          // Run entity extraction once for the group when graph search is enabled.
          if (extractionConfig.enabled && representativeCase.memories.length > 0 && graphEnabled) {
            await extractMemoriesInBatches(
              representativeCase.memories,
              db,
              embeddings,
              extractionConfig,
              logger,
            );
          }
          const ingestMs = performance.now() - ingestT0;
          ingestionTotalMemories += representativeCase.memories.length;
          ingestionTotalMs += ingestMs;
          log(
            `Ingestion complete: ${representativeCase.memories.length} memories in ${(ingestMs / 1000).toFixed(1)}s (haystack ${group.haystackId})`,
          );
        }

        // ── Warm-up cold pass: query-only, no judge, collect cold latencies ────
        if (options.warmup) {
          for (const tc of cases) {
            const searchT0 = performance.now();
            await hybridSearch(
              db,
              embeddings,
              tc.question,
              k,
              agentId,
              graphEnabled,
              searchOptions,
            );
            coldPassSamples.push({ ability: tc.ability, latencyMs: performance.now() - searchT0 });
          }

          // Clear query-result-cache for this agent between passes so the warm
          // pass measures Neo4j-page-cache-warm latency, not cache-hit latency.
          if (db.searchCache) {
            db.searchCache.invalidateAgent(agentId);
          }
        }

        // ── Main pass: full retrieval + metrics + judge ─────────────────────────
        for (const tc of cases) {
          globalCaseIdx++;
          const questionPreview =
            tc.question.length > 80 ? tc.question.slice(0, 80) + "…" : tc.question;
          log(`Searching case ${globalCaseIdx}/${totalCases}: ${questionPreview}`);

          // 3. Run hybridSearch (with latency timing)
          let rawResults: Awaited<ReturnType<typeof hybridSearch>>;
          const searchT0 = performance.now();
          try {
            rawResults = await hybridSearch(
              db,
              embeddings,
              tc.question,
              k,
              agentId,
              graphEnabled,
              searchOptions,
            );
            consecutiveSearchErrors = 0;
          } catch (err) {
            searchErrors++;
            consecutiveSearchErrors++;
            const errMsg = err instanceof Error ? err.message : String(err);
            logger.error(`Search failed for case ${tc.id} ("${questionPreview}"): ${errMsg}`);
            if (consecutiveSearchErrors > 5) {
              throw new Error(
                `Eval terminated: ${consecutiveSearchErrors} consecutive search failures. Last error: ${errMsg}`,
              );
            }
            // Skip this case but continue the run
            continue;
          }
          const searchLatencyMs = performance.now() - searchT0;

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
          caseMetrics.latencyMs = searchLatencyMs;
          latencySamples.push({ ability: tc.ability, latencyMs: searchLatencyMs });
          retrievalCases.push(caseMetrics);

          // 5. Context completeness (LLM judge, Tier 1)
          if (judge && wantJudge) {
            const judgeT0 = performance.now();
            log(`Judging case ${globalCaseIdx}/${totalCases}...`);
            const retrievedTexts = retrieved.map((r) => r.text);
            try {
              const completeness = await evaluateContextCompleteness(
                judge,
                tc.id,
                tc.ability,
                tc.question,
                retrievedTexts,
                tc.golden_answer,
              );
              contextResults.push(completeness);
            } catch (err) {
              judgeErrors++;
              const errMsg = err instanceof Error ? err.message : String(err);
              logger.error(`Judge failed for case ${tc.id}: ${errMsg}`);
            }
            judgePhaseMs += performance.now() - judgeT0;

            // 6. End-to-end evaluation (Tier 2)
            if (wantE2E) {
              const e2eT0 = performance.now();
              log(`E2E grading case ${globalCaseIdx}/${totalCases}...`);
              try {
                const answer = await generateAnswer(
                  judge,
                  tc.question,
                  retrieved.map((r) => r.text),
                );
                const graded = await gradeAnswer(
                  judge,
                  tc.id,
                  tc.ability,
                  tc.question,
                  tc.golden_answer,
                  answer,
                );
                e2eResults.push(graded);
              } catch (err) {
                e2eErrors++;
                const errMsg = err instanceof Error ? err.message : String(err);
                logger.error(`E2E grading failed for case ${tc.id}: ${errMsg}`);
              }
              e2ePhaseMs += performance.now() - e2eT0;
            }
          }

          // Periodic progress summary every 10 cases
          if (globalCaseIdx % 10 === 0) {
            const totalErrors = searchErrors + judgeErrors + e2eErrors;
            log(
              `Progress: ${globalCaseIdx}/${totalCases} cases completed (${totalErrors} errors so far)`,
            );
          }
        }
      } finally {
        // Skip cleanup in production mode (we don't own those memories) or when keepData is set.
        if (!productionAgentId && !options.keepData && storedIds.length > 0) {
          log(
            `Cleaning up: deleting ${storedIds.length} memories for haystack ${group.haystackId}...`,
          );
          await db.deleteMemoriesByIds(storedIds).catch((err) => {
            const errMsg = err instanceof Error ? err.message : String(err);
            logger.warn(`Cleanup failed for haystack ${group.haystackId}: ${errMsg}`);
          });
          // Clean up Entity nodes scoped to this eval agent to prevent orphan
          // accumulation. DETACH DELETE on Memory nodes above destroys the
          // EXTRACTED_FROM edges, leaving Entity nodes as orphans that pollute
          // the fulltext index and cause cross-agent seed contamination.
          await db
            .runQuery("MATCH (e:Entity) WHERE e.agentId = $agentId DETACH DELETE e", { agentId })
            .catch((err) => {
              const errMsg = err instanceof Error ? err.message : String(err);
              logger.warn(`Entity cleanup failed for agent ${agentId}: ${errMsg}`);
            });
          // Clean up orphaned Tag nodes (Tags have no agentId — they are
          // global MERGE-on-name nodes). After Memory DETACH DELETE removes
          // the TAGGED edges, any Tag with zero remaining relationships is
          // an eval artifact that should be purged.
          await db
            .runQuery(
              `MATCH (t:Tag) WHERE NOT EXISTS { MATCH (:Memory)-[:TAGGED]->(t) } DETACH DELETE t`,
              {},
            )
            .catch((err) => {
              const errMsg = err instanceof Error ? err.message : String(err);
              logger.warn(`Tag cleanup failed for agent ${agentId}: ${errMsg}`);
            });
        }
      }
    }

    // ── Phase completion summaries ──────────────────────────────────────────────
    const searchPhaseSec = (performance.now() - searchPhaseT0) / 1000;
    log(
      `Search phase complete: ${totalCases} cases in ${searchPhaseSec.toFixed(1)}s (${searchErrors} errors)`,
    );
    if (judgePhaseMs > 0) {
      log(
        `Judge phase complete: ${contextResults.length} cases in ${(judgePhaseMs / 1000).toFixed(1)}s`,
      );
    }
    if (e2ePhaseMs > 0) {
      log(`E2E phase complete: ${e2eResults.length} cases in ${(e2ePhaseMs / 1000).toFixed(1)}s`);
    }
  } catch (fatalErr) {
    const errMsg = fatalErr instanceof Error ? fatalErr.message : String(fatalErr);
    const stack = fatalErr instanceof Error ? fatalErr.stack : undefined;
    logger.error(`Fatal eval error: ${errMsg}`);
    if (stack) {
      process.stderr.write(`${stack}\n`);
    }
    // Attempt cleanup of any stored test data
    if (!productionAgentId && !options.keepData && allStoredIds.length > 0) {
      log(`Attempting cleanup of ${allStoredIds.length} memories after fatal error...`);
      await db.deleteMemoriesByIds(allStoredIds).catch(() => {});
      // Also clean up Entity nodes for the eval prefix
      await db
        .runQuery("MATCH (e:Entity) WHERE e.agentId STARTS WITH $prefix DETACH DELETE e", {
          prefix: agentPrefix,
        })
        .catch(() => {});
      await db
        .runQuery(
          `MATCH (t:Tag) WHERE NOT EXISTS { MATCH (:Memory)-[:TAGGED]->(t) } DETACH DELETE t`,
          {},
        )
        .catch(() => {});
    }
    process.exitCode = 1;
    throw fatalErr;
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

  // ── Performance metrics aggregation ───────────────────────────────────────
  // When --warmup is active:
  //   cold = latencies from the first (cold) pass
  //   warm = latencies from the main (warm) pass
  // Without --warmup: cold = latencies from the single pass, warm = undefined
  const mainLatencies = latencySamples.map((s) => s.latencyMs);
  const mainTotalSec = mainLatencies.reduce((s, v) => s + v, 0) / 1000;
  const qps = mainTotalSec > 0 ? mainLatencies.length / mainTotalSec : 0;

  const coldStats = options.warmup
    ? computeLatencyStats(coldPassSamples.map((s) => s.latencyMs))
    : computeLatencyStats(mainLatencies);
  const warmStats = options.warmup ? computeLatencyStats(mainLatencies) : undefined;
  const perAbilityStats = computeLatencyStatsByAbility(latencySamples);

  const ingestion: IngestionMetrics | undefined =
    !productionAgentId && ingestionTotalMemories > 0
      ? {
          totalMemories: ingestionTotalMemories,
          totalDurationMs: ingestionTotalMs,
          memoriesPerSecond:
            ingestionTotalMs > 0 ? ingestionTotalMemories / (ingestionTotalMs / 1000) : 0,
        }
      : undefined;

  const perfMetrics: PerformanceMetrics = {
    retrieval: {
      cold: coldStats,
      warm: warmStats,
      perAbility: perAbilityStats,
      qps,
    },
    ingestion,
  };

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
    performance: perfMetrics,
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
  if (
    variant.vectorWeight !== undefined ||
    variant.bm25Weight !== undefined ||
    variant.freshnessWeight !== undefined
  ) {
    const vw = variant.vectorWeight ?? 1.0;
    const bw = variant.bm25Weight ?? 1.0;
    const gw = graphEnabled ? 1.0 : 0.0;
    const fw = variant.freshnessWeight ?? 0.2;
    weightOverride = [vw, bw, gw, fw];
  }

  // Reranker config: merge plugin config with variant overrides
  const rerankerConfig = variant.reranker
    ? { ...(cfg.reranker ?? { enabled: false, provider: "local" as const }), ...variant.reranker }
    : cfg.reranker;

  return {
    graphEnabled,
    searchOptions: {
      graphSearchDepth: variant.graphDepthLimit ?? cfg.graphSearchDepth,
      graphSeedCap: variant.graphSeedCap ?? cfg.graphSeedCap,
      graphRelTypes: cfg.graphRelTypes,
      recencyWeight,
      weightOverride,
      ...(rerankerConfig ? { rerankerConfig, extractionConfig } : {}),
    },
  };
}

// ── CI mode handler ────────────────────────────────────────────────────────────

async function handleCiMode(result: EvalRunResult, options: EvalRunOptions): Promise<void> {
  let hasRegression = false;

  if (options.baselinePath) {
    const baseline = await loadBaseline(options.baselinePath);
    if (baseline) {
      const report = computeRegression(
        result,
        baseline,
        {},
        options.perfRegressionThreshold ?? 0.2,
      );
      hasRegression = report.hasRegression;

      if (report.hasRegression) {
        process.stderr.write(
          `[eval] Regression detected against baseline (${options.baselinePath}):\n`,
        );
        for (const r of report.regressions) {
          const isLatency = r.metric === "p95LatencyMs";
          const fmtCurrent = isLatency
            ? `${r.current.toFixed(1)}ms`
            : `${(r.current * 100).toFixed(2)}%`;
          const fmtBaseline = isLatency
            ? `${r.baseline.toFixed(1)}ms`
            : `${(r.baseline * 100).toFixed(2)}%`;
          const fmtDelta = isLatency
            ? `+${r.delta.toFixed(1)}ms`
            : `${(r.delta * 100).toFixed(2)}%`;
          const fmtThreshold = isLatency
            ? `${r.threshold.toFixed(1)}ms`
            : `${(r.threshold * 100).toFixed(2)}%`;
          process.stderr.write(
            `  ${r.metric}: ${fmtCurrent} vs baseline ${fmtBaseline} (delta ${fmtDelta}, threshold ${fmtThreshold})\n`,
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

  // Build all inputs at once
  const inputs = tc.memories.map((mem, i) => ({
    id: mem.id,
    text: mem.text,
    embedding: allEmbeddings[i],
    importance: mem.importance,
    category: normalizeCategory(mem.category),
    source: "import" as const,
    extractionStatus: "pending" as const,
    agentId,
    sessionKey: mem.sessionKey,
    validFrom: mem.validFrom ?? mem.createdAt,
  }));

  // Use batch UNWIND insert (single Cypher statement — ~100x faster than one-by-one)
  await db.storeManyMemories(inputs);

  return inputs.map((inp) => inp.id);
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
