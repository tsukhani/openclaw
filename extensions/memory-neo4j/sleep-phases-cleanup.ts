/**
 * Sleep cycle Phase 4-5 group — orphan cleanup and credential scanning.
 *
 * - Phase 4:  Orphan cleanup (entities and tags with no memory references)
 * - Phase 5:  Noise pattern cleanup (action-offer memories)
 * - Phase 5b: Credential scan (accidentally stored secrets)
 */

import type { Neo4jMemoryClient } from "./neo4j-client.js";
import type { Logger } from "./schema.js";
import { detectCredential } from "./sleep-cycle-types.js";
import type { SleepCycleOptions, SleepCycleResult } from "./sleep-cycle-types.js";

// ============================================================================
// Phase 4: Orphan Cleanup
// ============================================================================

export async function runOrphanCleanup(
  db: Neo4jMemoryClient,
  logger: Logger,
  options: SleepCycleOptions,
  result: SleepCycleResult,
): Promise<void> {
  const { abortSignal, singleUseTagMinAgeDays = 14, onPhaseStart, onProgress } = options;

  if (abortSignal?.aborted) return;

  onPhaseStart?.("cleanup");
  logger.info("memory-neo4j: [sleep] Phase 4: Orphan Cleanup");

  try {
    // Clean up orphan entities
    if (!abortSignal?.aborted) {
      const orphanEntities = await db.findOrphanEntities();
      if (orphanEntities.length > 0) {
        result.cleanup.entitiesRemoved = await db.deleteOrphanEntities(
          orphanEntities.map((e) => e.id),
        );
        onProgress?.("cleanup", `Removed ${result.cleanup.entitiesRemoved} orphan entities`);
      }
    }

    // Clean up orphan tags
    if (!abortSignal?.aborted) {
      const orphanTags = await db.findOrphanTags();
      if (orphanTags.length > 0) {
        result.cleanup.tagsRemoved = await db.deleteOrphanTags(orphanTags.map((t) => t.id));
        onProgress?.("cleanup", `Removed ${result.cleanup.tagsRemoved} orphan tags`);
      }
    }

    // Prune single-use tags (only 1 memory reference, older than threshold)
    // These add noise without providing useful cross-memory connections.
    if (!abortSignal?.aborted) {
      const singleUseTags = await db.findSingleUseTags(singleUseTagMinAgeDays);
      if (singleUseTags.length > 0) {
        result.cleanup.singleUseTagsRemoved = await db.deleteOrphanTags(
          singleUseTags.map((t) => t.id),
        );
        onProgress?.(
          "cleanup",
          `Removed ${result.cleanup.singleUseTagsRemoved} single-use tags (>${singleUseTagMinAgeDays}d old)`,
        );
      }
    }

    logger.info(
      `memory-neo4j: [sleep] Phase 4 complete — ${result.cleanup.entitiesRemoved} entities, ${result.cleanup.tagsRemoved} orphan tags, ${result.cleanup.singleUseTagsRemoved} single-use tags removed`,
    );
  } catch (err) {
    logger.warn(`memory-neo4j: [sleep] Phase 4 error: ${String(err)}`);
  }
}

// ============================================================================
// Phase 5: Noise Pattern Cleanup
// ============================================================================

export async function runNoiseCleanup(
  db: Neo4jMemoryClient,
  logger: Logger,
  options: SleepCycleOptions,
  result: SleepCycleResult,
): Promise<void> {
  const { agentId, abortSignal, onPhaseStart, onProgress } = options;

  // result is not mutated by this phase (no dedicated result field for noise count),
  // but we keep the parameter for signature consistency.
  void result;

  if (abortSignal?.aborted) return;

  onPhaseStart?.("noiseCleanup");
  logger.info("memory-neo4j: [sleep] Phase 5: Noise Pattern Cleanup");

  try {
    const noisePatterns = [
      "(?i)want me to\\s.+\\?",
      "(?i)should I\\s.+\\?",
      "(?i)shall I\\s.+\\?",
      "(?i)would you like me to\\s.+\\?",
      "(?i)do you want me to\\s.+\\?",
      "(?i)ready to\\s.+\\?",
      "(?i)proceed with\\s.+\\?",
    ];

    let noiseRemoved = 0;
    for (const pattern of noisePatterns) {
      if (abortSignal?.aborted) break;
      noiseRemoved += await db.deleteMemoriesByPattern(`.*${pattern}.*`, agentId);
    }

    if (noiseRemoved > 0) {
      onProgress?.("noiseCleanup", `Removed ${noiseRemoved} noise-pattern memories`);
    }

    logger.info(`memory-neo4j: [sleep] Phase 5 complete — ${noiseRemoved} noise memories removed`);
  } catch (err) {
    logger.warn(`memory-neo4j: [sleep] Phase 5 error: ${String(err)}`);
  }
}

// ============================================================================
// Phase 5b: Credential Scanning
// ============================================================================

export async function runCredentialScan(
  db: Neo4jMemoryClient,
  logger: Logger,
  options: SleepCycleOptions,
  result: SleepCycleResult,
): Promise<void> {
  const { agentId, abortSignal, onPhaseStart, onProgress } = options;

  if (abortSignal?.aborted) return;

  onPhaseStart?.("credentialScan");
  logger.info("memory-neo4j: [sleep] Phase 5b: Credential Scanning");

  try {
    const CREDENTIAL_SCAN_BATCH = 200;
    // Cursor-based pagination: start before the earliest possible timestamp.
    // Each page fetches records where createdAt > lastSeen, avoiding the
    // O(N²) re-scan from the start that SKIP-based pagination causes (Perf-6).
    let lastSeen = "";

    while (true) {
      if (abortSignal?.aborted) break;

      const batch = await db.fetchMemoriesForCredentialScan(
        lastSeen,
        CREDENTIAL_SCAN_BATCH,
        agentId,
      );
      if (batch.length === 0) break;

      result.credentialScan.memoriesScanned += batch.length;

      const toRemove: string[] = [];
      for (const { id, text } of batch) {
        const matched = detectCredential(text);
        if (matched) {
          toRemove.push(id);
          result.credentialScan.credentialsFound++;
          onProgress?.(
            "credentialScan",
            `Found ${matched} in memory ${id.slice(0, 8)}...: "${text.slice(0, 40)}..."`,
          );
          logger.warn(
            `memory-neo4j: [sleep] Credential detected (${matched}) in memory ${id} — removing`,
          );
        }
      }

      if (toRemove.length > 0) {
        const deletedInThisBatch = await db.deleteMemoriesByIds(toRemove);
        result.credentialScan.memoriesRemoved += deletedInThisBatch;
      }

      if (batch.length < CREDENTIAL_SCAN_BATCH) break; // last page
      // Advance cursor to the createdAt of the last record in this batch
      lastSeen = batch[batch.length - 1].createdAt;
    }

    logger.info(
      `memory-neo4j: [sleep] Phase 5b complete — ${result.credentialScan.memoriesScanned} scanned, ${result.credentialScan.credentialsFound} credentials found, ${result.credentialScan.memoriesRemoved} removed`,
    );
  } catch (err) {
    logger.warn(`memory-neo4j: [sleep] Phase 5b error: ${String(err)}`);
  }
}
