/**
 * Sleep cycle Phase 1 group — all deduplication work.
 *
 * - Phase 1 / 1a: Vector deduplication (high-similarity merge)
 * - Phase 1b: Semantic dedup (LLM-based paraphrase detection)
 * - Phase 1c: Conflict detection (contradictory memory resolution)
 * - Phase 1d: Entity deduplication (merge near-duplicate entities)
 */

import type { ExtractionConfig } from "./config.js";
import { isSemanticDuplicate, resolveConflict } from "./extractor.js";
import type { Neo4jMemoryClient } from "./neo4j-client.js";
import type { Logger } from "./schema.js";
import { makePairKey } from "./schema.js";
import type { SleepCycleOptions, SleepCycleResult } from "./sleep-cycle-types.js";

// ============================================================================
// Phase 1 + 1b: Vector dedup (>=0.95) + Semantic dedup (0.75–0.95)
// Both phases share a single findDuplicateClusters call at 0.75 threshold,
// so they are implemented as one runner to avoid a second DB round-trip.
// ============================================================================

export async function runDedup(
  db: Neo4jMemoryClient,
  config: ExtractionConfig,
  logger: Logger,
  options: SleepCycleOptions,
  result: SleepCycleResult,
): Promise<void> {
  const {
    agentId,
    abortSignal,
    dedupThreshold = 0.95,
    skipSemanticDedup = false,
    maxSemanticDedupPairs = 500,
    llmConcurrency = 8,
    onPhaseStart,
    onProgress,
  } = options;

  if (abortSignal?.aborted) return;

  onPhaseStart?.("dedup");
  logger.info("memory-neo4j: [sleep] Phase 1: Deduplication (vector + semantic)");

  try {
    // Fetch clusters at 0.75 threshold with similarity scores
    const allClusters = await db.findDuplicateClusters(0.75, agentId, true);

    // Separate clusters into high-similarity (>=0.95) and medium-similarity (0.75-0.95)
    const highSimClusters: typeof allClusters = [];
    const mediumSimClusters: typeof allClusters = [];

    for (const cluster of allClusters) {
      if (abortSignal?.aborted) break;
      if (!cluster.similarities || cluster.memoryIds.length < 2) continue;

      // Check if ANY pair in this cluster has similarity >= dedupThreshold
      let hasHighSim = false;
      for (const [, score] of cluster.similarities.entries()) {
        if (score >= dedupThreshold) {
          hasHighSim = true;
          break;
        }
      }

      if (hasHighSim) {
        // If a cluster has ANY high-sim pair, treat the whole cluster as high-sim
        // (matches old behavior where Phase 1 would merge them all)
        highSimClusters.push(cluster);
      } else {
        mediumSimClusters.push(cluster);
      }
    }

    // Part 1a: Vector merge for high-similarity clusters (>=0.95)
    result.dedup.clustersFound = highSimClusters.length;

    for (const cluster of highSimClusters) {
      if (abortSignal?.aborted) break;

      const { deletedCount } = await db.mergeMemoryCluster(cluster.memoryIds, cluster.importances);
      result.dedup.memoriesMerged += deletedCount;
      onProgress?.("dedup", `Merged cluster of ${cluster.memoryIds.length} -> 1 (vector)`);
    }

    logger.info(
      `memory-neo4j: [sleep] Phase 1a (vector) complete — ${result.dedup.clustersFound} clusters, ${result.dedup.memoriesMerged} merged`,
    );

    // Part 1b: Semantic dedup for medium-similarity clusters (0.75-0.95)
    if (skipSemanticDedup) {
      onPhaseStart?.("semanticDedup");
      logger.info("memory-neo4j: [sleep] Phase 1b: Skipped (--skip-semantic)");
      onProgress?.("semanticDedup", "Skipped — semantic dedup disabled");
    } else {
      onPhaseStart?.("semanticDedup");
      logger.info("memory-neo4j: [sleep] Phase 1b: Semantic Deduplication (0.75-0.95 band)");

      // Collect all candidate pairs upfront (with pairwise similarity for pre-screening)
      type DedupPair = {
        textA: string;
        textB: string;
        idA: string;
        idB: string;
        importanceA: number;
        importanceB: number;
        similarity?: number;
      };
      const allPairs: DedupPair[] = [];

      for (const cluster of mediumSimClusters) {
        if (cluster.memoryIds.length < 2) continue;
        for (let i = 0; i < cluster.memoryIds.length - 1; i++) {
          for (let j = i + 1; j < cluster.memoryIds.length; j++) {
            const pairKey = makePairKey(cluster.memoryIds[i], cluster.memoryIds[j]);
            allPairs.push({
              textA: cluster.texts[i],
              textB: cluster.texts[j],
              idA: cluster.memoryIds[i],
              idB: cluster.memoryIds[j],
              importanceA: cluster.importances[i],
              importanceB: cluster.importances[j],
              similarity: cluster.similarities?.get(pairKey),
            });
          }
        }
      }

      // Cap the number of LLM-checked pairs to prevent sleep cycle timeouts.
      // Sort by similarity descending so higher-similarity pairs (more likely
      // to be duplicates) are checked first.
      if (allPairs.length > maxSemanticDedupPairs) {
        allPairs.sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));
        const skipped = allPairs.length - maxSemanticDedupPairs;
        allPairs.length = maxSemanticDedupPairs;
        onProgress?.(
          "semanticDedup",
          `Capped at ${maxSemanticDedupPairs} pairs (${skipped} lower-similarity pairs skipped)`,
        );
        logger.info(
          `memory-neo4j: [sleep] Phase 1b capped to ${maxSemanticDedupPairs} pairs (${skipped} skipped)`,
        );
      }

      // Process pairs in concurrent batches
      const invalidatedIds = new Set<string>();

      for (let i = 0; i < allPairs.length && !abortSignal?.aborted; i += llmConcurrency) {
        const batch = allPairs.slice(i, i + llmConcurrency);

        // Filter out pairs where one side was already invalidated
        const activeBatch = batch.filter(
          (p) => !invalidatedIds.has(p.idA) && !invalidatedIds.has(p.idB),
        );

        if (activeBatch.length === 0) continue;

        const outcomes = await Promise.allSettled(
          activeBatch.map((p) =>
            isSemanticDuplicate(p.textA, p.textB, config, p.similarity, abortSignal),
          ),
        );

        for (let k = 0; k < outcomes.length; k++) {
          const pair = activeBatch[k];
          result.semanticDedup.pairsChecked++;

          if (
            outcomes[k].status === "fulfilled" &&
            (outcomes[k] as PromiseFulfilledResult<boolean>).value
          ) {
            // Skip if either side was invalidated by an earlier result in this batch
            if (invalidatedIds.has(pair.idA) || invalidatedIds.has(pair.idB)) continue;

            const keepId = pair.importanceA >= pair.importanceB ? pair.idA : pair.idB;
            const removeId = keepId === pair.idA ? pair.idB : pair.idA;
            const keepText = keepId === pair.idA ? pair.textA : pair.textB;
            const removeText = removeId === pair.idA ? pair.textA : pair.textB;

            await db.invalidateMemories([removeId]);
            invalidatedIds.add(removeId);
            result.semanticDedup.duplicatesMerged++;

            onProgress?.(
              "semanticDedup",
              `Merged: "${removeText.slice(0, 50)}..." -> kept "${keepText.slice(0, 50)}..."`,
            );
          }
        }
      }

      logger.info(
        `memory-neo4j: [sleep] Phase 1b (semantic) complete — ${result.semanticDedup.pairsChecked} pairs checked, ${result.semanticDedup.duplicatesMerged} merged`,
      );
    }
  } catch (err) {
    logger.warn(`memory-neo4j: [sleep] Phase 1 error: ${String(err)}`);
  }
}

// ============================================================================
// Phase 1c: Conflict Detection
// ============================================================================

export async function runConflictDetection(
  db: Neo4jMemoryClient,
  config: ExtractionConfig,
  logger: Logger,
  options: SleepCycleOptions,
  result: SleepCycleResult,
): Promise<void> {
  const {
    agentId,
    abortSignal,
    skipSemanticDedup = false,
    llmConcurrency = 8,
    conflictDetectionBatchSize = 50,
    onPhaseStart,
    onProgress,
  } = options;

  if (abortSignal?.aborted || skipSemanticDedup) return;

  onPhaseStart?.("conflict");
  logger.info("memory-neo4j: [sleep] Phase 1c: Conflict Detection");

  try {
    const pairs = await db.findConflictingMemories(agentId, conflictDetectionBatchSize);
    result.conflict.pairsFound = pairs.length;

    // Process conflict pairs in parallel chunks of llmConcurrency
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
          result.conflict.invalidated++;
          result.conflict.resolved++;
          onProgress?.("conflict", `Kept A, invalidated B: "${pair.memoryB.text.slice(0, 40)}..."`);
        } else if (decision === "b") {
          await db.invalidateMemories([pair.memoryA.id]);
          result.conflict.invalidated++;
          result.conflict.resolved++;
          onProgress?.("conflict", `Kept B, invalidated A: "${pair.memoryA.text.slice(0, 40)}..."`);
        } else if (decision === "both") {
          result.conflict.resolved++;
          onProgress?.("conflict", `Kept both: no real conflict`);
        }
        // "skip" = LLM unavailable, don't count as resolved
      }
    }

    logger.info(
      `memory-neo4j: [sleep] Phase 1c complete — ${result.conflict.pairsFound} pairs, ${result.conflict.resolved} resolved, ${result.conflict.invalidated} invalidated`,
    );
  } catch (err) {
    logger.warn(`memory-neo4j: [sleep] Phase 1c error: ${String(err)}`);
  }
}

// ============================================================================
// Phase 1d: Entity Deduplication
// ============================================================================

export async function runEntityDedup(
  db: Neo4jMemoryClient,
  logger: Logger,
  options: SleepCycleOptions,
  result: SleepCycleResult,
): Promise<void> {
  const { agentId, abortSignal, onPhaseStart, onProgress } = options;

  if (abortSignal?.aborted) return;

  onPhaseStart?.("entityDedup");
  logger.info("memory-neo4j: [sleep] Phase 1d: Entity Deduplication");

  try {
    // Reconcile NULL mentionCounts before dedup so decisions are based on accurate counts
    // reconcileEntityMentionCounts is intentionally global — Entity nodes have no agentId
    const reconciled = await db.reconcileEntityMentionCounts();
    if (reconciled > 0) {
      logger.info(
        `memory-neo4j: [sleep] Phase 1d: Reconciled mentionCount for ${reconciled} entities`,
      );
      onProgress?.("entityDedup", `Reconciled ${reconciled} entity mention counts`);
    }

    const pairs = await db.findDuplicateEntityPairs(agentId);
    result.entityDedup.pairsFound = pairs.length;

    if (pairs.length > 0) {
      // Pre-filter pairs to skip cascading merges: if entity B was already
      // removed by an earlier merge (A→B), skip any later pair involving B.
      const removedIds = new Set<string>();
      const eligiblePairs: typeof pairs = [];
      for (const pair of pairs) {
        if (abortSignal?.aborted) break;
        if (removedIds.has(pair.keepId) || removedIds.has(pair.removeId)) continue;
        eligiblePairs.push(pair);
        removedIds.add(pair.removeId);
      }

      if (eligiblePairs.length > 0 && !abortSignal?.aborted) {
        // Batch all eligible merges in a single transaction via UNWIND (OP-106).
        const mergedCount = await db.batchMergeEntityPairs(
          eligiblePairs.map((p) => ({ keepId: p.keepId, removeId: p.removeId })),
        );
        result.entityDedup.merged += mergedCount;
        for (const pair of eligiblePairs) {
          onProgress?.(
            "entityDedup",
            `Merged "${pair.removeName}" → "${pair.keepName}" (${pair.removeMentions} mentions transferred)`,
          );
        }
      }
    }

    logger.info(
      `memory-neo4j: [sleep] Phase 1d complete — ${result.entityDedup.pairsFound} pairs found, ${result.entityDedup.merged} merged`,
    );
  } catch (err) {
    logger.warn(`memory-neo4j: [sleep] Phase 1d error: ${String(err)}`);
  }
}
