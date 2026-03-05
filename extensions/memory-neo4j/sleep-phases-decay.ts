/**
 * Sleep cycle Phase 3 group — memory decay and staleness.
 *
 * - Phase 3:  Decay & pruning (Ebbinghaus forgetting curve)
 * - Phase 3b: Temporal staleness detection (past-event memories)
 * - Phase 3c: Retroactive conflict scan (older memories vs newer ones)
 */

import type { ExtractionConfig } from "./config.js";
import { classifyTemporalStaleness } from "./extractor.js";
import type { Neo4jMemoryClient } from "./neo4j-client.js";
import type { Logger } from "./schema.js";
import type { SleepCycleOptions, SleepCycleResult } from "./sleep-cycle-types.js";

// ============================================================================
// Phase 3: Decay & Pruning
// ============================================================================

export async function runDecay(
  db: Neo4jMemoryClient,
  logger: Logger,
  options: SleepCycleOptions,
  result: SleepCycleResult,
): Promise<void> {
  const {
    agentId,
    abortSignal,
    decayRetentionThreshold = 0.1,
    decayBaseHalfLifeDays = 30,
    decayImportanceMultiplier = 2,
    decayCurves,
    onPhaseStart,
    onProgress,
  } = options;

  if (abortSignal?.aborted) return;

  onPhaseStart?.("decay");
  logger.info("memory-neo4j: [sleep] Phase 3: Decay & Pruning");

  try {
    const decayed = await db.findDecayedMemories({
      retentionThreshold: decayRetentionThreshold,
      baseHalfLifeDays: decayBaseHalfLifeDays,
      importanceMultiplier: decayImportanceMultiplier,
      decayCurves,
      agentId,
    });

    if (decayed.length > 0) {
      const ids = decayed.map((m) => m.id);
      result.decay.memoriesPruned = await db.pruneMemories(ids);
      onProgress?.("decay", `Pruned ${result.decay.memoriesPruned} decayed memories`);
    }

    logger.info(
      `memory-neo4j: [sleep] Phase 3 complete — ${result.decay.memoriesPruned} memories pruned`,
    );
  } catch (err) {
    logger.warn(`memory-neo4j: [sleep] Phase 3 error: ${String(err)}`);
  }
}

// ============================================================================
// Phase 3b: Temporal Staleness Detection
// ============================================================================

export async function runTemporalStaleness(
  db: Neo4jMemoryClient,
  config: ExtractionConfig,
  logger: Logger,
  options: SleepCycleOptions,
  result: SleepCycleResult,
): Promise<void> {
  const {
    agentId,
    abortSignal,
    skipTemporalStaleness = false,
    temporalStalenessMinAgeDays = 3,
    llmConcurrency = 8,
    onPhaseStart,
    onProgress,
  } = options;

  if (abortSignal?.aborted) return;

  if (!config.enabled) {
    logger.info("memory-neo4j: [sleep] Phase 3b skipped — extraction not enabled");
    return;
  }
  if (skipTemporalStaleness) {
    logger.info("memory-neo4j: [sleep] Phase 3b skipped — temporal staleness disabled");
    return;
  }

  onPhaseStart?.("temporalStaleness");
  logger.info("memory-neo4j: [sleep] Phase 3b: Temporal Staleness Detection");

  try {
    const candidates = await db.fetchMemoriesForTemporalCheck(temporalStalenessMinAgeDays, agentId);
    const currentDate = new Date().toISOString().split("T")[0];
    const toRemove: string[] = [];

    // Process in parallel batches
    for (let i = 0; i < candidates.length && !abortSignal?.aborted; i += llmConcurrency) {
      const batch = candidates.slice(i, i + llmConcurrency);

      const outcomes = await Promise.allSettled(
        batch.map((mem) => classifyTemporalStaleness(mem.text, currentDate, config, abortSignal)),
      );

      for (let k = 0; k < outcomes.length; k++) {
        result.temporalStaleness.memoriesChecked++;
        const outcome = outcomes[k];
        const mem = batch[k];

        if (outcome.status === "fulfilled" && outcome.value === "stale") {
          toRemove.push(mem.id);
          onProgress?.("temporalStaleness", `Stale: "${mem.text.slice(0, 60)}..."`);
        }
      }
    }

    // Remove stale memories
    if (toRemove.length > 0 && !abortSignal?.aborted) {
      await db.invalidateMemories(toRemove);
      result.temporalStaleness.memoriesRemoved = toRemove.length;
      onProgress?.("temporalStaleness", `Removed ${toRemove.length} temporally stale memories`);
    }

    logger.info(
      `memory-neo4j: [sleep] Phase 3b complete — ${result.temporalStaleness.memoriesChecked} checked, ${result.temporalStaleness.memoriesRemoved} removed`,
    );
  } catch (err) {
    logger.warn(`memory-neo4j: [sleep] Phase 3b error: ${String(err)}`);
  }
}

// ============================================================================
// Phase 3c: Retroactive Conflict Scan
// ============================================================================

export async function runRetroactiveConflictScan(
  db: Neo4jMemoryClient,
  config: ExtractionConfig,
  logger: Logger,
  options: SleepCycleOptions,
  result: SleepCycleResult,
): Promise<void> {
  const {
    agentId,
    abortSignal,
    skipRetroactiveConflictScan = false,
    retroactiveConflictBatchSize = 20,
    conflictSimilarityThreshold = 0.82,
    conflictMaxCandidates = 5,
    onPhaseStart,
  } = options;

  if (abortSignal?.aborted) return;

  if (!config.enabled) return; // no log — orchestrator handles skip message if needed

  if (skipRetroactiveConflictScan) {
    logger.info("memory-neo4j: [sleep] Phase 3c skipped — retroactive conflict scan disabled");
    return;
  }

  onPhaseStart?.("retroactiveConflictScan");
  logger.info("memory-neo4j: [sleep] Phase 3c: Retroactive Conflict Scan");

  try {
    // Fetch a batch of memories that haven't been conflict-checked
    const candidates = await db.fetchMemoriesForRetroactiveConflictScan(
      0,
      retroactiveConflictBatchSize,
      agentId,
    );

    result.retroactiveConflictScan.memoriesScanned = candidates.length;

    const CONFLICT_CHUNK = 5;
    for (let i = 0; i < candidates.length && !abortSignal?.aborted; i += CONFLICT_CHUNK) {
      const chunk = candidates.slice(i, i + CONFLICT_CHUNK).filter((m) => m.embedding?.length);

      const outcomes = await Promise.allSettled(
        chunk.map((mem) =>
          db.detectConflicts(mem.id, mem.text, mem.embedding ?? [], agentId ?? "default", config, {
            similarityThreshold: conflictSimilarityThreshold,
            maxCandidates: conflictMaxCandidates,
          }),
        ),
      );

      for (const outcome of outcomes) {
        if (outcome.status === "fulfilled") {
          result.retroactiveConflictScan.memoriesSuperseded += outcome.value;
        }
        // Non-fatal on rejection
      }
    }

    logger.info(
      `memory-neo4j: [sleep] Phase 3c complete — ${result.retroactiveConflictScan.memoriesScanned} scanned, ${result.retroactiveConflictScan.memoriesSuperseded} superseded`,
    );
  } catch (err) {
    logger.warn(`memory-neo4j: [sleep] Phase 3c error: ${String(err)}`);
  }
}
