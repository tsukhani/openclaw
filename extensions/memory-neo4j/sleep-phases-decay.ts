/**
 * Sleep cycle Phase 3 group — memory decay and staleness.
 *
 * - Phase 3:  Decay & pruning (Ebbinghaus forgetting curve)
 * - Phase 3b: Temporal staleness detection (past-event memories)
 * - Phase 3c: Retroactive conflict scan (older memories vs newer ones)
 */

import type { ExtractionConfig } from "./config.js";
import { classifyTemporalStaleness, resolveConflict } from "./extractor.js";
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
// Phase 3d: Pending Conflict Retry (OP-125)
// ============================================================================

/** Max retry attempts for a pending conflict pair before permanently abandoning. */
const MAX_PENDING_CONFLICT_RETRIES = 3;

/**
 * Retry resolveConflict for pairs that previously failed with a transient LLM error.
 *
 * For each pending pair:
 * - If resolved (a/b/both): apply the decision and clear the pending record.
 * - If still transient AND retryCount < MAX_PENDING_CONFLICT_RETRIES: increment counter, leave pending.
 * - If still transient AND exhausted: clear pending + log.
 * - If permanent skip: clear pending + log.
 */
export async function runPendingConflictRetry(
  db: Neo4jMemoryClient,
  config: ExtractionConfig,
  logger: Logger,
  options: SleepCycleOptions,
  result: SleepCycleResult,
): Promise<void> {
  const {
    agentId,
    abortSignal,
    skipPendingConflictRetry = false,
    pendingConflictMaxRetries = MAX_PENDING_CONFLICT_RETRIES,
    llmConcurrency = 8,
    onPhaseStart,
    onProgress,
  } = options;

  if (abortSignal?.aborted) return;
  if (!config.enabled) return;
  if (skipPendingConflictRetry) {
    logger.info("memory-neo4j: [sleep] Phase 3d skipped — pending conflict retry disabled");
    return;
  }

  onPhaseStart?.("pendingConflictRetry");
  logger.info("memory-neo4j: [sleep] Phase 3d: Pending Conflict Retry");

  try {
    const pairs = await db.fetchPendingConflicts(agentId);
    result.pendingConflictRetry.pairsRetried = pairs.length;

    if (pairs.length === 0) {
      logger.info("memory-neo4j: [sleep] Phase 3d complete — no pending conflict pairs");
      return;
    }

    for (let i = 0; i < pairs.length && !abortSignal?.aborted; i += llmConcurrency) {
      const chunk = pairs.slice(i, i + llmConcurrency);
      const outcomes = await Promise.allSettled(
        chunk.map((pair) =>
          resolveConflict(pair.memoryA.text, pair.memoryB.text, config, abortSignal),
        ),
      );

      for (let k = 0; k < outcomes.length; k++) {
        if (abortSignal?.aborted) break;
        const pair = chunk[k];
        const outcome = outcomes[k];
        if (outcome.status !== "fulfilled") continue;

        const decision = outcome.value;

        if (decision === "a") {
          await db.invalidateMemories([pair.memoryB.id]);
          await db.clearPendingConflict(pair.memoryA.id, pair.memoryB.id);
          result.pendingConflictRetry.resolved++;
          onProgress?.(
            "pendingConflictRetry",
            `Kept A, invalidated B: "${pair.memoryB.text.slice(0, 40)}..."`,
          );
        } else if (decision === "b") {
          await db.invalidateMemories([pair.memoryA.id]);
          await db.clearPendingConflict(pair.memoryA.id, pair.memoryB.id);
          result.pendingConflictRetry.resolved++;
          onProgress?.(
            "pendingConflictRetry",
            `Kept B, invalidated A: "${pair.memoryA.text.slice(0, 40)}..."`,
          );
        } else if (decision === "both") {
          await db.clearPendingConflict(pair.memoryA.id, pair.memoryB.id);
          result.pendingConflictRetry.resolved++;
          onProgress?.("pendingConflictRetry", `Kept both — no real conflict`);
        } else if (decision === "transient") {
          // Still unavailable — leave pending if budget remains, otherwise abandon
          if (pair.retryCount + 1 >= pendingConflictMaxRetries) {
            await db.clearPendingConflict(pair.memoryA.id, pair.memoryB.id);
            result.pendingConflictRetry.permanentlySkipped++;
            logger.warn(
              `memory-neo4j: [sleep] Phase 3d abandoned pair after ${pendingConflictMaxRetries} transient failures: ${pair.memoryA.id.slice(0, 8)} vs ${pair.memoryB.id.slice(0, 8)}`,
            );
          } else {
            await db.incrementPendingConflictRetry(pair.memoryA.id, pair.memoryB.id);
            onProgress?.(
              "pendingConflictRetry",
              `Still transient (retry ${pair.retryCount + 1}/${pendingConflictMaxRetries})`,
            );
          }
        } else {
          // Permanent skip (bad JSON, empty response) — abandon the pair
          await db.clearPendingConflict(pair.memoryA.id, pair.memoryB.id);
          result.pendingConflictRetry.permanentlySkipped++;
          logger.debug?.(
            `memory-neo4j: [sleep] Phase 3d permanent skip for pair: ${pair.memoryA.id.slice(0, 8)} vs ${pair.memoryB.id.slice(0, 8)}`,
          );
        }
      }
    }

    logger.info(
      `memory-neo4j: [sleep] Phase 3d complete — ${result.pendingConflictRetry.pairsRetried} retried, ${result.pendingConflictRetry.resolved} resolved, ${result.pendingConflictRetry.permanentlySkipped} abandoned`,
    );
  } catch (err) {
    logger.warn(`memory-neo4j: [sleep] Phase 3d error: ${String(err)}`);
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
