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
 * Uses an ephemeral agentId per test case to avoid polluting production data.
 * All test memories are cleaned up after each case via deleteMemoriesByIds.
 */

import { randomUUID } from "node:crypto";
import type { ExtractionConfig, MemoryNeo4jConfig } from "../config.js";
import type { Embeddings } from "../embeddings.js";
import type { Neo4jMemoryClient } from "../neo4j-client.js";
import type { MemoryCategory } from "../schema.js";
import { hybridSearch } from "../search.js";
import { loadDataset } from "./datasets/loader.js";
import { LlmJudge } from "./judges/llm-judge.js";
import {
  aggregateContextCompleteness,
  evaluateContextCompleteness,
} from "./metrics/context-completeness.js";
import { aggregateEndToEnd, generateAnswer, gradeAnswer } from "./metrics/end-to-end.js";
import { aggregateByAbility, aggregateOverall, computeCaseMetrics } from "./metrics/retrieval.js";
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

  // Run each test case
  for (const tc of testCases) {
    const caseAgentId = `${agentPrefix}-${tc.id}`;
    const storedIds: string[] = [];

    try {
      // 1. Store memories for this test case
      storedIds.push(...(await storeTestMemories(db, embeddings, tc, caseAgentId)));

      // 2. Run hybridSearch
      const graphEnabled = extractionConfig.enabled && cfg.graphSearchDepth > 0;
      const rawResults = await hybridSearch(
        db,
        embeddings,
        tc.question,
        k,
        caseAgentId,
        graphEnabled,
        {
          graphSearchDepth: cfg.graphSearchDepth,
          graphSeedCap: cfg.graphSeedCap,
          graphRelTypes: cfg.graphRelTypes,
          recencyWeight: cfg.recencyWeight,
        },
      );

      const retrieved: RetrievedMemory[] = rawResults.map((r, i) => ({
        id: r.id,
        text: r.text,
        score: r.score,
        rank: i + 1,
        signals: r.signals,
      }));

      // 3. Compute retrieval metrics
      const caseMetrics = computeCaseMetrics(
        tc.id,
        tc.ability,
        tc.question,
        retrieved,
        tc.gold_memory_ids,
        k,
      );
      retrievalCases.push(caseMetrics);

      // 4. Context completeness (LLM judge, Tier 1)
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

        // 5. End-to-end evaluation (Tier 2)
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
      // Always clean up test memories (even on error)
      if (storedIds.length > 0) {
        await db.deleteMemoriesByIds(storedIds).catch(() => {
          // Non-critical cleanup failure
        });
      }
    }
  }

  // Aggregate results
  const abilityMetrics = aggregateByAbility(retrievalCases);
  const overall = aggregateOverall(retrievalCases);

  const contextAggregate =
    contextResults.length > 0 ? aggregateContextCompleteness(contextResults) : undefined;

  const e2eAggregate = e2eResults.length > 0 ? aggregateEndToEnd(e2eResults) : undefined;

  const result: EvalRunResult = {
    runId,
    timestamp: new Date().toISOString(),
    datasetName: options.dataset,
    k,
    agentNamespace: agentPrefix,
    retrievalCases,
    abilityMetrics,
    overall,
    contextCompleteness: contextAggregate
      ? { cases: contextResults, aggregate: contextAggregate }
      : undefined,
    endToEnd: e2eAggregate ? { cases: e2eResults, aggregate: e2eAggregate } : undefined,
    durationMs: Date.now() - startedAt,
  };

  // Report
  await dispatchReporter(result, options);

  return result;
}

// ── Memory ingestion ──────────────────────────────────────────────────────────

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
