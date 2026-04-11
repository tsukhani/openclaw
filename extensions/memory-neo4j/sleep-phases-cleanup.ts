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
  const { agentId, abortSignal, singleUseTagMinAgeDays = 14, onPhaseStart, onProgress } = options;

  if (abortSignal?.aborted) {
    return;
  }

  onPhaseStart?.("cleanup");
  logger.info("memory-neo4j: [sleep] Phase 4: Orphan Cleanup");

  try {
    // Expire entity relationships no longer supported by any active memory for this agent.
    // Run before orphan entity deletion so expiry is recorded before the entity nodes vanish.
    if (!abortSignal?.aborted && agentId) {
      const expired = await db.expireOrphanedEntityRelationships(agentId);
      if (expired > 0) {
        onProgress?.("cleanup", `Expired ${expired} orphaned entity relationships`);
      }
    }

    // H13: Paginated orphan entity cleanup — loop until no more orphans found
    // oxlint-disable-next-line eslint/no-unmodified-loop-condition
    while (!abortSignal?.aborted) {
      const orphanEntities = await db.findOrphanEntities();
      if (orphanEntities.length === 0) {
        break;
      }
      const deleted = await db.deleteOrphanEntities(orphanEntities.map((e) => e.id));
      result.cleanup.entitiesRemoved += deleted;
      onProgress?.(
        "cleanup",
        `Removed ${deleted} orphan entities (total: ${result.cleanup.entitiesRemoved})`,
      );
      if (orphanEntities.length < 500) {
        break;
      } // last page
    }

    // H13: Paginated orphan tag cleanup
    // oxlint-disable-next-line eslint/no-unmodified-loop-condition
    while (!abortSignal?.aborted) {
      const orphanTags = await db.findOrphanTags();
      if (orphanTags.length === 0) {
        break;
      }
      const deleted = await db.deleteOrphanTags(orphanTags.map((t) => t.id));
      result.cleanup.tagsRemoved += deleted;
      if (orphanTags.length < 500) {
        break;
      } // last page
    }
    if (result.cleanup.tagsRemoved > 0) {
      onProgress?.("cleanup", `Removed ${result.cleanup.tagsRemoved} orphan tags`);
    }

    // H13: Paginated single-use tag cleanup
    // oxlint-disable-next-line eslint/no-unmodified-loop-condition
    while (!abortSignal?.aborted) {
      const singleUseTags = await db.findSingleUseTags(singleUseTagMinAgeDays);
      if (singleUseTags.length === 0) {
        break;
      }
      const deleted = await db.deleteOrphanTags(singleUseTags.map((t) => t.id));
      result.cleanup.singleUseTagsRemoved += deleted;
      if (singleUseTags.length < 500) {
        break;
      } // last page
    }
    if (result.cleanup.singleUseTagsRemoved > 0) {
      onProgress?.(
        "cleanup",
        `Removed ${result.cleanup.singleUseTagsRemoved} single-use tags (>${singleUseTagMinAgeDays}d old)`,
      );
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

  if (abortSignal?.aborted) {
    return;
  }

  onPhaseStart?.("noiseCleanup");
  logger.info("memory-neo4j: [sleep] Phase 5: Noise Pattern Cleanup");

  try {
    // C2: Pass each noise pattern individually instead of combining into one mega-regex
    // that would exceed the 200-char MAX_PATTERN_LENGTH guard in deleteMemoriesByPattern().
    // L14: These use Java/Lucene regex syntax ((?i) inline flag) because Neo4j's =~ operator
    // runs patterns through Java's regex engine, not JavaScript's.
    const noisePatterns = [
      "(?i).*want me to\\s.+\\?.*",
      "(?i).*should I\\s.+\\?.*",
      "(?i).*shall I\\s.+\\?.*",
      "(?i).*would you like me to\\s.+\\?.*",
      "(?i).*do you want me to\\s.+\\?.*",
      "(?i).*ready to\\s.+\\?.*",
      "(?i).*proceed with\\s.+\\?.*",
    ];

    let noiseRemoved = 0;
    for (const pattern of noisePatterns) {
      if (abortSignal?.aborted) {
        break;
      }
      noiseRemoved += await db.deleteMemoriesByPattern(pattern, agentId);
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

  if (abortSignal?.aborted) {
    return;
  }

  onPhaseStart?.("credentialScan");
  logger.info("memory-neo4j: [sleep] Phase 5b: Credential Scanning");

  try {
    const CREDENTIAL_SCAN_BATCH = 200;
    // Composite cursor-based pagination: track both (createdAt, id) to correctly
    // handle batch-stored memories with identical timestamps. Start with empty strings
    // to fetch from the beginning, avoiding O(N²) re-scanning (Perf-6).
    let cursorTs = "";
    let cursorId = "";

    while (true) {
      if (abortSignal?.aborted) {
        break;
      }

      const batch = await db.fetchMemoriesForCredentialScan(
        cursorTs,
        cursorId,
        CREDENTIAL_SCAN_BATCH,
        agentId,
      );
      if (batch.length === 0) {
        break;
      }

      result.credentialScan.memoriesScanned += batch.length;

      const toRemove: string[] = [];
      for (const { id, text } of batch) {
        const matched = detectCredential(text);
        if (matched) {
          toRemove.push(id);
          result.credentialScan.credentialsFound++;
          onProgress?.("credentialScan", `Found ${matched} in memory ${id.slice(0, 8)}...`);
          logger.warn(
            `memory-neo4j: [sleep] Credential detected (${matched}) in memory ${id} — removing`,
          );
        }
      }

      if (toRemove.length > 0) {
        const deletedInThisBatch = await db.deleteMemoriesByIds(toRemove);
        result.credentialScan.memoriesRemoved += deletedInThisBatch;
      }

      if (batch.length < CREDENTIAL_SCAN_BATCH) {
        break;
      } // last page
      // Advance composite cursor to (createdAt, id) of the last record in this batch
      const lastRecord = batch[batch.length - 1];
      cursorTs = lastRecord.createdAt;
      cursorId = lastRecord.id;
    }

    logger.info(
      `memory-neo4j: [sleep] Phase 5b complete — ${result.credentialScan.memoriesScanned} scanned, ${result.credentialScan.credentialsFound} credentials found, ${result.credentialScan.memoriesRemoved} removed`,
    );
  } catch (err) {
    logger.warn(`memory-neo4j: [sleep] Phase 5b error: ${String(err)}`);
  }
}
