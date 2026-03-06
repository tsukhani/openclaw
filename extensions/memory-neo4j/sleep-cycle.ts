/**
 * Multi-phase sleep cycle for memory consolidation — orchestrator.
 *
 * Phases:
 * 1.  DEDUPLICATION - Merge near-duplicate memories (reduce redundancy)
 * 1b. SEMANTIC DEDUP - LLM-based paraphrase detection
 * 1c. CONFLICT DETECTION - Resolve contradictory memories
 * 1d. ENTITY DEDUP - Merge near-duplicate entities (reduce entity bloat)
 * 2.  EXTRACTION - Form entity relationships (strengthen connections)
 * 2b. RETROACTIVE TAGGING - Generate tags for tag-less memories
 * 3.  DECAY/PRUNING - Remove old, low-importance memories (forgetting curve)
 * 3b. TEMPORAL STALENESS - Remove memories about past events/dates (temporal decay)
 * 3c. RETROACTIVE CONFLICT SCAN - Find older memories conflicting with newer ones
 * 4.  CLEANUP - Remove orphaned entities/tags (garbage collection)
 * 5.  NOISE CLEANUP - Remove dangerous pattern memories
 * 5b. CREDENTIAL SCAN - Remove memories containing leaked credentials
 * 6.  TASK LEDGER - Archive stale tasks in TASKS.md
 * 7.  TASK-MEMORY CLEANUP - Remove task-noise memories for completed tasks
 * 8.  TIP GENERATION - Store reusable lessons from session failure patterns
 *
 * Research basis:
 * - ACT-R memory model for retrieval-based importance
 * - Ebbinghaus forgetting curve for decay
 * - MemGPT/Letta for tiered memory architecture
 */

import type { ExtractionConfig } from "./config.js";
import type { Embeddings } from "./embeddings.js";
import type { Neo4jMemoryClient } from "./neo4j-client.js";
import type { Logger } from "./schema.js";
// Import types for use in this file and re-export for external consumers (backward-compatible).
import type { SleepCycleOptions, SleepCycleResult } from "./sleep-cycle-types.js";
import { runCredentialScan, runNoiseCleanup, runOrphanCleanup } from "./sleep-phases-cleanup.js";
import {
  runDecay,
  runPendingConflictRetry,
  runRetroactiveConflictScan,
  runTemporalStaleness,
} from "./sleep-phases-decay.js";
import { runConflictDetection, runDedup, runEntityDedup } from "./sleep-phases-dedup.js";
import { runExtraction, runRetroactiveTagging } from "./sleep-phases-extract.js";
import { runTaskLedger, runTaskMemoryCleanup } from "./sleep-phases-tasks.js";
import { runTipGeneration } from "./sleep-phases-tips.js";
export type { SleepCycleOptions, SleepCycleResult };

// ============================================================================
// Orchestrator
// ============================================================================

/**
 * Run the full sleep cycle — all phases of memory consolidation.
 */
export async function runSleepCycle(
  db: Neo4jMemoryClient,
  embeddings: Embeddings,
  config: ExtractionConfig,
  logger: Logger,
  options: SleepCycleOptions = {},
): Promise<SleepCycleResult> {
  const startTime = Date.now();
  const { abortSignal } = options;

  const result: SleepCycleResult = {
    dedup: { clustersFound: 0, memoriesMerged: 0 },
    conflict: { pairsFound: 0, resolved: 0, invalidated: 0 },
    semanticDedup: { pairsChecked: 0, duplicatesMerged: 0 },
    entityDedup: { pairsFound: 0, merged: 0 },
    decay: { memoriesPruned: 0 },
    temporalStaleness: { memoriesChecked: 0, memoriesRemoved: 0 },
    retroactiveConflictScan: { memoriesScanned: 0, memoriesSuperseded: 0 },
    pendingConflictRetry: { pairsRetried: 0, resolved: 0, permanentlySkipped: 0 },
    extraction: { total: 0, processed: 0, succeeded: 0, failed: 0 },
    retroactiveTagging: { total: 0, tagged: 0, failed: 0 },
    cleanup: { entitiesRemoved: 0, tagsRemoved: 0, singleUseTagsRemoved: 0 },
    credentialScan: { memoriesScanned: 0, credentialsFound: 0, memoriesRemoved: 0 },
    taskLedger: { staleCount: 0, archivedCount: 0, archivedIds: [] },
    taskMemoryCleanup: { tasksChecked: 0, memoriesEvaluated: 0, memoriesRemoved: 0 },
    tipGeneration: { sessionsScanned: 0, failurePatternsFound: 0, tipsGenerated: 0, tipsStored: 0 },
    durationMs: 0,
    aborted: false,
  };

  // Phase 1 + 1b: Vector dedup + semantic dedup (combined — share one DB call)
  await runDedup(db, config, logger, options, result);

  // Phase 1c: Conflict detection
  await runConflictDetection(db, config, logger, options, result);

  // Phase 1d: Entity deduplication
  await runEntityDedup(db, logger, options, result);

  // Phase 2: Entity extraction
  await runExtraction(db, embeddings, config, logger, options, result);

  // Phase 2b: Retroactive tagging
  await runRetroactiveTagging(db, config, logger, options, result);

  // Phase 3: Decay & pruning
  await runDecay(db, logger, options, result);

  // Phase 3b: Temporal staleness
  await runTemporalStaleness(db, config, logger, options, result);

  // Phase 3c: Retroactive conflict scan
  if (!abortSignal?.aborted && config.enabled) {
    await runRetroactiveConflictScan(db, config, logger, options, result);
  }

  // Phase 3d: Pending conflict retry (OP-125)
  if (!abortSignal?.aborted && config.enabled) {
    await runPendingConflictRetry(db, config, logger, options, result);
  }

  // Phase 4: Orphan cleanup
  await runOrphanCleanup(db, logger, options, result);

  // Phase 5: Noise pattern cleanup
  await runNoiseCleanup(db, logger, options, result);

  // Phase 5b: Credential scanning
  await runCredentialScan(db, logger, options, result);

  // Phase 6: Task ledger cleanup
  await runTaskLedger(db, logger, options, result);

  // Phase 7: Task-memory cleanup
  await runTaskMemoryCleanup(db, config, logger, options, result);

  // Phase 8: Tip generation
  await runTipGeneration(db, embeddings, config, logger, options, result);

  result.durationMs = Date.now() - startTime;
  result.aborted = abortSignal?.aborted ?? false;

  logger.info(
    `memory-neo4j: [sleep] Sleep cycle complete in ${(result.durationMs / 1000).toFixed(1)}s` +
      (result.aborted ? " (aborted)" : ""),
  );

  return result;
}
