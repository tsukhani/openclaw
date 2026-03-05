/**
 * Sleep cycle support operations for the Neo4j memory client.
 *
 * Covers deduplication, decay/pruning, orphan cleanup, conflict detection,
 * temporal migration, and credential/temporal scanning.
 */

import neo4j, { type Driver, type Session } from "neo4j-driver";
import type { ExtractionConfig } from "./config.js";
import { callOpenRouter } from "./llm-client.js";
import type { Logger } from "./schema.js";
import { makePairKey } from "./schema.js";

// Strip markdown code fences from LLM output (some providers wrap JSON in ```)
function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
  return match ? match[1].trim() : trimmed;
}

// --------------------------------------------------------------------------
// Sleep Cycle: Deduplication
// --------------------------------------------------------------------------

/**
 * Find clusters of near-duplicate memories by vector similarity.
 * Returns groups where each group contains memories that are duplicates of each other.
 *
 * Algorithm (O(N log N) via HNSW index, replaces O(N²) Cartesian product):
 * 1. Fetch all memory IDs and metadata
 * 2. For each memory, query the vector index for nearest neighbors above threshold
 * 3. Build clusters via union-find (transitive closure)
 * 4. Return clusters with 2+ members
 *
 * @param driver    Initialized Neo4j driver
 * @param logger    Logger instance
 * @param retryFn   The caller's retryOnTransient wrapper
 * @param threshold Minimum similarity score (0-1)
 * @param agentId   Optional agent filter
 * @param returnSimilarities If true, includes pairwise similarity scores in the result
 */
export async function findDuplicateClusters(
  driver: Driver,
  logger: Logger,
  retryFn: <T>(fn: () => Promise<T>) => Promise<T>,
  threshold: number = 0.95,
  agentId?: string,
  returnSimilarities: boolean = false,
): Promise<
  Array<{
    memoryIds: string[];
    texts: string[];
    importances: number[];
    similarities?: Map<string, number>;
  }>
> {
  // Step 1: Fetch only IDs and importance (not text) to reduce data transfer
  const memoryMeta = new Map<string, { importance: number }>();
  {
    const session = driver.session();
    try {
      const agentFilter = agentId ? "WHERE m.agentId = $agentId" : "";
      const allResult = await session.run(
        `MATCH (m:Memory) ${agentFilter}
         RETURN m.id AS id, m.importance AS importance`,
        agentId ? { agentId } : {},
      );

      for (const r of allResult.records) {
        memoryMeta.set(r.get("id") as string, {
          importance: r.get("importance") as number,
        });
      }
    } finally {
      await session.close();
    }
  }

  if (memoryMeta.size < 2) {
    return [];
  }

  // Step 2: For each memory, find near-duplicates via HNSW vector index
  // Each query uses a fresh short-lived session via retryFn to
  // avoid a single long-lived session that could expire mid-operation.
  // Each query is O(log N) vs O(N) for brute-force, total O(N log N)
  const parent = new Map<string, string>();
  // Capture pairwise similarities if requested (for sleep cycle optimization)
  const pairwiseSimilarities = returnSimilarities ? new Map<string, number>() : null;

  const find = (x: string): string => {
    if (!parent.has(x)) {
      parent.set(x, x);
    }
    if (parent.get(x) !== x) {
      parent.set(x, find(parent.get(x)!));
    }
    return parent.get(x)!;
  };

  const union = (x: string, y: string): void => {
    const px = find(x);
    const py = find(y);
    if (px !== py) {
      parent.set(px, py);
    }
  };

  // Process vector queries in concurrent batches to avoid overwhelming Neo4j
  // while still being much faster than fully sequential execution.
  const DEDUP_CONCURRENCY = 8;
  let pairsFound = 0;
  const allIds = [...memoryMeta.keys()];

  for (let batchStart = 0; batchStart < allIds.length; batchStart += DEDUP_CONCURRENCY) {
    if (pairsFound > 2000) {
      logger.warn(
        `memory-neo4j: findDuplicateClusters hit safety bound (2000 pairs) — some duplicates may not be detected. Consider running with a higher threshold.`,
      );
      break;
    }

    const batch = allIds.slice(batchStart, batchStart + DEDUP_CONCURRENCY);
    const results = await Promise.all(
      batch.map((id) =>
        retryFn(async () => {
          const session = driver.session();
          try {
            return await session.run(
              `MATCH (src:Memory {id: $id})
               CALL db.index.vector.queryNodes('memory_embedding_index', $k, src.embedding)
               YIELD node, score
               WHERE node.id <> $id AND score >= $threshold
               RETURN node.id AS matchId, score`,
              { id, k: neo4j.int(10), threshold },
            );
          } finally {
            await session.close();
          }
        }),
      ),
    );

    for (let idx = 0; idx < batch.length; idx++) {
      const id = batch[idx];
      const similar = results[idx];

      for (const r of similar.records) {
        const matchId = r.get("matchId") as string;
        if (memoryMeta.has(matchId)) {
          union(id, matchId);
          pairsFound++;

          // Capture similarity score if requested
          if (pairwiseSimilarities) {
            const score = r.get("score") as number;
            const pairKey = makePairKey(id, matchId);
            // Keep the highest score if we see this pair multiple times
            const existing = pairwiseSimilarities.get(pairKey);
            if (existing === undefined || score > existing) {
              pairwiseSimilarities.set(pairKey, score);
            }
          }
        }
      }
    }
  }

  // Step 3: Group by root
  const clusters = new Map<string, string[]>();
  for (const id of memoryMeta.keys()) {
    if (!parent.has(id)) {
      continue;
    }
    const root = find(id);
    if (!clusters.has(root)) {
      clusters.set(root, []);
    }
    clusters.get(root)!.push(id);
  }

  // Step 4: Fetch text only for memories that are in clusters (not all memories)
  const duplicateClusters = Array.from(clusters.values()).filter((ids) => ids.length >= 2);
  const clusteredIds = new Set<string>();
  for (const ids of duplicateClusters) {
    for (const id of ids) clusteredIds.add(id);
  }

  const textMap = new Map<string, string>();
  if (clusteredIds.size > 0) {
    const session = driver.session();
    try {
      const result = await session.run(
        `UNWIND $ids AS memId
         MATCH (m:Memory {id: memId})
         RETURN m.id AS id, m.text AS text`,
        { ids: [...clusteredIds] },
      );
      for (const r of result.records) {
        textMap.set(r.get("id") as string, r.get("text") as string);
      }
    } finally {
      await session.close();
    }
  }

  // Return clusters with 2+ members
  return duplicateClusters.map((ids) => {
    const cluster: {
      memoryIds: string[];
      texts: string[];
      importances: number[];
      similarities?: Map<string, number>;
    } = {
      memoryIds: ids,
      texts: ids.map((id) => textMap.get(id) ?? ""),
      importances: ids.map((id) => memoryMeta.get(id)!.importance),
    };

    // Include similarities for this cluster if requested
    if (pairwiseSimilarities) {
      const clusterSims = new Map<string, number>();
      for (let i = 0; i < ids.length - 1; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const pairKey = makePairKey(ids[i], ids[j]);
          const score = pairwiseSimilarities.get(pairKey);
          if (score !== undefined) {
            clusterSims.set(pairKey, score);
          }
        }
      }
      cluster.similarities = clusterSims;
    }

    return cluster;
  });
}

/**
 * Merge duplicate memories by keeping the one with highest importance
 * and deleting the rest. Transfers MENTIONS relationships to the survivor.
 */
export async function mergeMemoryCluster(
  session: Session,
  logger: Logger,
  memoryIds: string[],
  importances: number[],
): Promise<{ survivorId: string; deletedCount: number }> {
  // Find the survivor (highest importance)
  let survivorIdx = 0;
  for (let i = 1; i < importances.length; i++) {
    if (importances[i] > importances[survivorIdx]) {
      survivorIdx = i;
    }
  }
  const survivorId = memoryIds[survivorIdx];
  const toDelete = memoryIds.filter((_, i) => i !== survivorIdx);

  // Execute verify + transfer + delete in a single write transaction
  // to prevent TOCTOU races (member deleted between verify and merge)
  const deletedCount = await session.executeWrite(async (tx) => {
    // Verify all cluster members still exist
    const verifyResult = await tx.run(
      `UNWIND $ids AS memId
       OPTIONAL MATCH (m:Memory {id: memId})
       RETURN memId, m IS NOT NULL AS exists`,
      { ids: memoryIds },
    );

    const missingIds: string[] = [];
    for (const r of verifyResult.records) {
      if (!r.get("exists")) {
        missingIds.push(r.get("memId") as string);
      }
    }

    if (missingIds.length > 0) {
      logger.warn(
        `memory-neo4j: skipping cluster merge — ${missingIds.length} member(s) no longer exist: ${missingIds.join(", ")}`,
      );
      return 0;
    }

    // Transfer MENTIONS relationships from deleted memories to survivor
    await tx.run(
      `UNWIND $toDelete AS deadId
       MATCH (dead:Memory {id: deadId})-[r:MENTIONS]->(e:Entity)
       MATCH (survivor:Memory {id: $survivorId})
       MERGE (survivor)-[:MENTIONS]->(e)
       DELETE r`,
      { toDelete, survivorId },
    );

    // Transfer TAGGED relationships from deleted memories to survivor
    await tx.run(
      `UNWIND $toDelete AS deadId
       MATCH (dead:Memory {id: deadId})-[r:TAGGED]->(t:Tag)
       MATCH (survivor:Memory {id: $survivorId})
       MERGE (survivor)-[:TAGGED]->(t)
       DELETE r`,
      { toDelete, survivorId },
    );

    // Preserve the oldest originalCreatedAt on the survivor
    // so temporal staleness can track the true age of the information
    await tx.run(
      `MATCH (m:Memory) WHERE m.id IN $allIds
       WITH min(COALESCE(m.originalCreatedAt, m.createdAt)) AS oldest
       MATCH (survivor:Memory {id: $survivorId})
       SET survivor.originalCreatedAt = oldest`,
      { allIds: memoryIds, survivorId },
    );

    // Delete the duplicate memories
    await tx.run(
      `UNWIND $toDelete AS deadId
       MATCH (m:Memory {id: deadId})
       DETACH DELETE m`,
      { toDelete },
    );

    return toDelete.length;
  });

  return { survivorId, deletedCount };
}

// --------------------------------------------------------------------------
// Sleep Cycle: Decay & Pruning
// --------------------------------------------------------------------------

/**
 * Find memories that have decayed below the retention threshold.
 *
 * Decay formula (Ebbinghaus-inspired):
 *   decay_score = importance × e^(-age_days / half_life)
 *
 * Where half_life scales with importance:
 *   half_life = baseHalfLifeDays × (1 + importance × importanceMultiplier)
 *
 * A memory with importance=1.0 decays slower than one with importance=0.3.
 *
 * IMPORTANT: Core memories (category='core') and user-pinned memories
 * are EXEMPT from decay. They persist indefinitely regardless of age.
 */
export async function findDecayedMemories(
  session: Session,
  options: {
    retentionThreshold?: number;
    baseHalfLifeDays?: number;
    importanceMultiplier?: number;
    /** Per-category half-life overrides. Categories not listed use baseHalfLifeDays. */
    decayCurves?: Record<string, { halfLifeDays: number }>;
    agentId?: string;
    limit?: number;
  } = {},
): Promise<
  Array<{ id: string; text: string; importance: number; ageDays: number; decayScore: number }>
> {
  const {
    retentionThreshold = 0.1,
    baseHalfLifeDays = 30,
    importanceMultiplier = 2,
    decayCurves,
    agentId,
    limit = 500,
  } = options;

  const agentFilter = agentId ? "AND m.agentId = $agentId" : "";

  // Build per-category half-life using parameterized map lookup instead of
  // string interpolation, avoiding any injection risk from category names.
  const curveEntries = decayCurves ? Object.entries(decayCurves) : [];
  const hasCurves = curveEntries.length > 0;

  // Pass category→halfLife mapping as a Cypher map parameter
  const curveMap: Record<string, number> = {};
  for (const [cat, { halfLifeDays }] of curveEntries) {
    curveMap[cat] = halfLifeDays;
  }

  const halfLifeExpr = hasCurves
    ? "CASE WHEN $curveMap[m.category] IS NOT NULL THEN $curveMap[m.category] ELSE $baseHalfLife END"
    : "$baseHalfLife";

  // Decay formula uses retrieval reinforcement: memories that are frequently
  // accessed decay slower. The effective age is anchored to the most recent
  // of createdAt or lastRetrievedAt, so recently recalled memories get a
  // recency boost even if they were created long ago.
  const result = await session.run(
    `MATCH (m:Memory)
     WHERE m.createdAt IS NOT NULL
       AND m.category <> 'core'
       ${agentFilter}
     WITH m,
          duration.between(datetime(m.createdAt), datetime()).days AS ageDays,
          CASE
            WHEN m.lastRetrievedAt IS NOT NULL
            THEN duration.between(datetime(m.lastRetrievedAt), datetime()).days
            ELSE duration.between(datetime(m.createdAt), datetime()).days
          END AS effectiveAgeDays,
          m.importance AS importance,
          coalesce(m.retrievalCount, 0) AS retrievalCount
     WITH m, ageDays, effectiveAgeDays, importance, retrievalCount,
          ${halfLifeExpr} * (1.0 + importance * $importanceMult) * (1.0 + log(1.0 + retrievalCount) * 0.2) AS halfLife
     WITH m, ageDays, importance, halfLife,
          importance * exp(-1.0 * effectiveAgeDays / halfLife) AS decayScore
     WHERE decayScore < $threshold
     RETURN m.id AS id, m.text AS text, importance, ageDays, decayScore
     ORDER BY decayScore ASC
     LIMIT $limit`,
    {
      threshold: retentionThreshold,
      baseHalfLife: baseHalfLifeDays,
      importanceMult: importanceMultiplier,
      curveMap,
      agentId,
      limit: neo4j.int(limit),
    },
  );

  return result.records.map((r) => ({
    id: r.get("id") as string,
    text: r.get("text") as string,
    importance: r.get("importance") as number,
    ageDays: r.get("ageDays") as number,
    decayScore: r.get("decayScore") as number,
  }));
}

/**
 * Delete decayed memories and decrement entity mention counts.
 */
export async function pruneMemories(session: Session, memoryIds: string[]): Promise<number> {
  // Atomic: decrement mentionCount and delete in a single Cypher statement
  // to prevent inconsistent state if a crash occurs between operations
  const result = await session.run(
    `UNWIND $ids AS memId
     MATCH (m:Memory {id: memId})
     OPTIONAL MATCH (m)-[:MENTIONS]->(e:Entity)
     SET e.mentionCount = CASE WHEN e.mentionCount > 0 THEN e.mentionCount - 1 ELSE 0 END
     WITH m, count(e) AS _
     DETACH DELETE m
     RETURN count(*) AS deleted`,
    { ids: memoryIds },
  );

  return (result.records[0]?.get("deleted") as number) ?? 0;
}

// --------------------------------------------------------------------------
// Sleep Cycle: Orphan Cleanup
// --------------------------------------------------------------------------

/** Find orphaned Entity nodes (no MENTIONS relationships from any Memory). */
export async function findOrphanEntities(
  session: Session,
  limit: number = 500,
): Promise<Array<{ id: string; name: string; type: string }>> {
  // Use EXISTS check as the authoritative source — mentionCount can go
  // stale if crashes occur between decrement and delete operations.
  const result = await session.run(
    `MATCH (e:Entity)
     WHERE NOT EXISTS { MATCH (:Memory)-[:MENTIONS]->(e) }
     RETURN e.id AS id, e.name AS name, e.type AS type
     LIMIT $limit`,
    { limit: neo4j.int(limit) },
  );

  return result.records.map((r) => ({
    id: r.get("id") as string,
    name: r.get("name") as string,
    type: r.get("type") as string,
  }));
}

/** Delete orphaned entities and their relationships. */
export async function deleteOrphanEntities(session: Session, entityIds: string[]): Promise<number> {
  const result = await session.run(
    `UNWIND $ids AS entId
     MATCH (e:Entity {id: entId})
     DETACH DELETE e
     RETURN count(*) AS deleted`,
    { ids: entityIds },
  );

  return (result.records[0]?.get("deleted") as number) ?? 0;
}

/** Find orphaned Tag nodes (no TAGGED relationships from any Memory). */
export async function findOrphanTags(
  session: Session,
  limit: number = 500,
): Promise<Array<{ id: string; name: string }>> {
  const result = await session.run(
    `MATCH (t:Tag)
     WHERE NOT EXISTS { MATCH (:Memory)-[:TAGGED]->(t) }
     RETURN t.id AS id, t.name AS name
     LIMIT $limit`,
    { limit: neo4j.int(limit) },
  );

  return result.records.map((r) => ({
    id: r.get("id") as string,
    name: r.get("name") as string,
  }));
}

/** Delete orphaned tags. */
export async function deleteOrphanTags(session: Session, tagIds: string[]): Promise<number> {
  const result = await session.run(
    `UNWIND $ids AS tagId
     MATCH (t:Tag {id: tagId})
     DETACH DELETE t
     RETURN count(*) AS deleted`,
    { ids: tagIds },
  );

  return (result.records[0]?.get("deleted") as number) ?? 0;
}

/**
 * Find tags with exactly 1 TAGGED relationship, older than minAgeDays.
 * Single-use tags add noise without providing useful cross-memory connections.
 * Only prunes tags that have had enough time to accrue additional references.
 */
export async function findSingleUseTags(
  session: Session,
  minAgeDays: number = 14,
  limit: number = 500,
): Promise<Array<{ id: string; name: string }>> {
  const cutoffDate = new Date(Date.now() - minAgeDays * 24 * 60 * 60 * 1000).toISOString();
  const result = await session.run(
    `MATCH (t:Tag)
     WHERE t.createdAt < $cutoffDate
     WITH t
     MATCH (t)<-[:TAGGED]-(m:Memory)
     WITH t, count(m) AS usageCount
     WHERE usageCount = 1
     RETURN t.id AS id, t.name AS name
     LIMIT $limit`,
    { cutoffDate, limit: neo4j.int(limit) },
  );
  return result.records.map((r) => ({
    id: r.get("id") as string,
    name: r.get("name") as string,
  }));
}

// --------------------------------------------------------------------------
// Sleep Cycle: Conflict Detection
// --------------------------------------------------------------------------

/**
 * Find memory pairs that share at least one entity (via MENTIONS relationships).
 * These are candidates for conflict resolution — the LLM decides if they truly conflict.
 * Excludes core memories (those are user-curated).
 */
export async function findConflictingMemories(
  session: Session,
  agentId?: string,
): Promise<
  Array<{
    memoryA: { id: string; text: string; importance: number; createdAt: string };
    memoryB: { id: string; text: string; importance: number; createdAt: string };
  }>
> {
  const agentFilter = agentId ? "AND m1.agentId = $agentId AND m2.agentId = $agentId" : "";
  const result = await session.run(
    `MATCH (m1:Memory)-[:MENTIONS]->(e:Entity)<-[:MENTIONS]-(m2:Memory)
     WHERE m1.id < m2.id ${agentFilter}
     AND m1.validUntil IS NULL AND m2.validUntil IS NULL
     AND m1.category <> 'core' AND m2.category <> 'core'
     WITH m1, m2, count(e) AS sharedEntities
     WHERE sharedEntities >= 1
     RETURN DISTINCT m1.id AS m1Id, m1.text AS m1Text, m1.importance AS m1Importance, m1.createdAt AS m1CreatedAt,
            m2.id AS m2Id, m2.text AS m2Text, m2.importance AS m2Importance, m2.createdAt AS m2CreatedAt
     LIMIT 50`,
    agentId ? { agentId } : {},
  );

  return result.records.map((r) => ({
    memoryA: {
      id: r.get("m1Id"),
      text: r.get("m1Text"),
      importance: r.get("m1Importance"),
      createdAt: String(r.get("m1CreatedAt") ?? ""),
    },
    memoryB: {
      id: r.get("m2Id"),
      text: r.get("m2Text"),
      importance: r.get("m2Importance"),
      createdAt: String(r.get("m2CreatedAt") ?? ""),
    },
  }));
}

/**
 * Invalidate a memory by setting its importance to near-zero.
 * Used by conflict resolution to effectively retire the losing memory
 * without deleting it (it will be pruned naturally by the decay phase).
 */
export async function invalidateMemory(session: Session, id: string): Promise<void> {
  await session.run(
    `MATCH (m:Memory {id: $id})
     SET m.importance = 0.01, m.updatedAt = $now`,
    { id, now: new Date().toISOString() },
  );
}

/**
 * Batch-invalidate multiple memories in a single Cypher query.
 * Prefer this over sequential invalidateMemory calls when retiring a list of IDs.
 */
export async function invalidateMemories(session: Session, ids: string[]): Promise<void> {
  await session.run(
    `UNWIND $ids AS id
     MATCH (m:Memory {id: id})
     SET m.importance = 0.01, m.updatedAt = $now`,
    { ids, now: new Date().toISOString() },
  );
}

// --------------------------------------------------------------------------
// Temporal Memory Operations
// --------------------------------------------------------------------------

/**
 * Supersede a memory: set its validUntil to now and record which memory
 * replaced it. Used by conflict detection when a newer memory updates/
 * contradicts an existing one.
 *
 * @param oldId  ID of the memory being superseded
 * @param newId  ID of the replacement memory
 */
export async function supersedeMemory(
  session: Session,
  oldId: string,
  newId: string,
): Promise<void> {
  const now = new Date().toISOString();
  await session.run(
    `MATCH (m:Memory {id: $oldId})
     SET m.validUntil = $now, m.supersededBy = $newId, m.updatedAt = $now`,
    { oldId, newId, now },
  );
}

/**
 * Migrate existing memories to include temporal fields.
 * Sets validFrom = COALESCE(originalCreatedAt, createdAt) and
 * validUntil = null, supersededBy = null for memories that lack these fields.
 *
 * @returns Number of memories updated
 */
export async function migrateTemporalFields(session: Session): Promise<number> {
  const result = await session.run(
    `MATCH (m:Memory)
     WHERE m.validFrom IS NULL
     SET m.validFrom = COALESCE(m.originalCreatedAt, m.createdAt),
         m.validUntil = null,
         m.supersededBy = null
     RETURN count(m) AS updated`,
  );
  const updated = result.records[0]?.get("updated");
  return typeof updated === "number" ? updated : Number(updated ?? 0);
}

/**
 * Detect conflicts between a newly stored memory and existing memories.
 * Uses vector similarity search to find candidates, then LLM to classify.
 * Supersedes any existing memories that the new memory replaces.
 *
 * @param newMemoryId       ID of the newly stored memory
 * @param newMemoryText     Text of the new memory
 * @param newEmbedding      Embedding of the new memory
 * @param agentId           Agent scope for the search
 * @param config            Extraction config for LLM calls
 * @param findSimilarFn     Callback to find similar memories (delegates to main client)
 * @param supersedeMemoryFn Callback to supersede a memory (delegates to main client)
 * @param options           Conflict detection options
 * @returns Number of memories superseded
 */
export async function detectConflicts(
  logger: Logger,
  config: ExtractionConfig,
  newMemoryId: string,
  newMemoryText: string,
  newEmbedding: number[],
  agentId: string,
  findSimilarFn: (
    embedding: number[],
    threshold: number,
    limit: number,
    agentId: string,
  ) => Promise<Array<{ id: string; text: string; score: number }>>,
  supersedeMemoryFn: (oldId: string, newId: string) => Promise<void>,
  options?: {
    similarityThreshold?: number;
    maxCandidates?: number;
  },
): Promise<number> {
  if (!config.enabled) {
    return 0;
  }

  const threshold = options?.similarityThreshold ?? 0.82;
  const maxCandidates = options?.maxCandidates ?? 5;

  // Find existing non-expired memories similar to the new one (excluding itself)
  let candidates: Array<{ id: string; text: string; score: number }>;
  try {
    candidates = await findSimilarFn(newEmbedding, threshold, maxCandidates + 1, agentId);
  } catch {
    return 0;
  }

  // Exclude the new memory itself from candidates
  const filtered = candidates.filter((c) => c.id !== newMemoryId).slice(0, maxCandidates);
  if (filtered.length === 0) {
    return 0;
  }

  let supersededCount = 0;
  for (const candidate of filtered) {
    try {
      const content = await callOpenRouter(config, [
        {
          role: "system",
          content: `Given two memories about potentially the same topic, classify their relationship.

- SUPERSEDES: the NEW memory replaces/updates/contradicts the EXISTING one (the existing is now outdated)
- COMPLEMENTS: the new memory adds detail; both remain valid
- UNRELATED: different topics despite textual similarity

Return JSON: {"classification": "SUPERSEDES"|"COMPLEMENTS"|"UNRELATED"}`,
        },
        {
          role: "user",
          content: `EXISTING: "${candidate.text}"\n\nNEW: "${newMemoryText}"`,
        },
      ]);

      if (!content) continue;

      const parsed = JSON.parse(stripCodeFences(content)) as { classification?: string };
      if (parsed.classification === "SUPERSEDES") {
        await supersedeMemoryFn(candidate.id, newMemoryId);
        supersededCount++;
        logger.info(
          `memory-neo4j: conflict detected — superseded ${candidate.id.slice(0, 8)} with ${newMemoryId.slice(0, 8)}`,
        );
      }
    } catch (err) {
      // Non-fatal: log and continue with remaining candidates
      logger.debug?.(`memory-neo4j: conflict classification failed: ${String(err)}`);
    }
  }

  return supersededCount;
}

/**
 * Fetch non-superseded memories for the retroactive conflict scan (Phase 3c).
 * Returns memories with their embeddings for batch conflict detection.
 *
 * @param minAgeDays Minimum age in days (skip brand-new memories)
 * @param limit      Maximum number of memories to return per batch
 * @param agentId    Optional agent filter
 */
export async function fetchMemoriesForRetroactiveConflictScan(
  session: Session,
  minAgeDays: number = 7,
  limit: number = 50,
  agentId?: string,
): Promise<Array<{ id: string; text: string; embedding: number[] | null; category: string }>> {
  const agentFilter = agentId ? "AND m.agentId = $agentId" : "";
  const result = await session.run(
    `MATCH (m:Memory)
     WHERE m.validUntil IS NULL
       AND m.category <> 'core'
       AND m.createdAt IS NOT NULL
       AND duration.between(datetime(m.createdAt), datetime()).days >= $minAgeDays
       ${agentFilter}
     RETURN m.id AS id, m.text AS text, m.embedding AS embedding, m.category AS category
     ORDER BY m.createdAt ASC
     LIMIT $limit`,
    {
      minAgeDays: neo4j.int(minAgeDays),
      limit: neo4j.int(limit),
      ...(agentId ? { agentId } : {}),
    },
  );

  return result.records.map((r) => ({
    id: r.get("id") as string,
    text: r.get("text") as string,
    embedding: r.get("embedding") as number[] | null,
    category: r.get("category") as string,
  }));
}

/**
 * Get a single field value from a Memory node.
 * Returns undefined if the memory or field doesn't exist.
 */
export async function getMemoryField(
  session: Session,
  id: string,
  field: string,
): Promise<string | undefined> {
  const result = await session.run(`MATCH (m:Memory {id: $id}) RETURN m[$field] AS value`, {
    id,
    field,
  });
  const record = result.records[0];
  if (!record) return undefined;
  const value = record.get("value");
  return value != null ? String(value) : undefined;
}

/**
 * Get decay score distribution bucketed into health categories.
 * Computes decay scores server-side and buckets them.
 */
export async function getDecayDistribution(
  session: Session,
  agentId?: string,
): Promise<Array<{ bucket: string; count: number }>> {
  const agentFilter = agentId ? "AND m.agentId = $agentId" : "";
  const result = await session.run(
    `MATCH (m:Memory)
     WHERE m.createdAt IS NOT NULL AND m.category <> 'core' ${agentFilter}
     WITH m,
          m.importance AS importance,
          CASE
            WHEN m.lastRetrievedAt IS NOT NULL
            THEN duration.between(datetime(m.lastRetrievedAt), datetime()).days
            ELSE duration.between(datetime(m.createdAt), datetime()).days
          END AS effectiveAgeDays,
          coalesce(m.retrievalCount, 0) AS retrievalCount
     WITH m, importance,
          30.0 * (1.0 + importance * 2.0) * (1.0 + log(1.0 + retrievalCount) * 0.2) AS halfLife,
          effectiveAgeDays
     WITH CASE
       WHEN importance * exp(-1.0 * effectiveAgeDays / halfLife) >= 0.8 THEN 'healthy'
       WHEN importance * exp(-1.0 * effectiveAgeDays / halfLife) >= 0.5 THEN 'moderate'
       WHEN importance * exp(-1.0 * effectiveAgeDays / halfLife) >= 0.2 THEN 'fading'
       ELSE 'near-pruning'
     END AS bucket
     RETURN bucket, count(*) AS cnt
     ORDER BY CASE bucket
       WHEN 'healthy' THEN 1
       WHEN 'moderate' THEN 2
       WHEN 'fading' THEN 3
       WHEN 'near-pruning' THEN 4
     END`,
    agentId ? { agentId } : {},
  );
  return result.records.map((r) => ({
    bucket: r.get("bucket") as string,
    count: (r.get("cnt") as number) ?? 0,
  }));
}

// --------------------------------------------------------------------------
// Sleep Cycle: Credential & Temporal Scanning
// --------------------------------------------------------------------------

/**
 * Fetch a paginated batch of memories (id + text + createdAt) for credential scanning.
 * Uses cursor-based pagination (WHERE m.createdAt > $cursor) instead of
 * SKIP to avoid O(N²) re-scanning from the beginning on each page (Perf-6).
 * Pass cursor="" for the first page; subsequent pages use the createdAt of
 * the last record from the previous batch.
 */
export async function fetchMemoriesForCredentialScan(
  session: Session,
  cursor: string,
  limit: number,
  agentId?: string,
): Promise<Array<{ id: string; text: string; createdAt: string }>> {
  const result = await session.run(
    `MATCH (m:Memory)
     WHERE ($agentId IS NULL OR m.agentId = $agentId)
       AND m.createdAt > $cursor
     RETURN m.id AS id, m.text AS text, m.createdAt AS createdAt
     ORDER BY m.createdAt ASC
     LIMIT $limit`,
    { agentId: agentId ?? null, cursor, limit },
  );
  return result.records.map((r) => ({
    id: r.get("id") as string,
    text: r.get("text") as string,
    createdAt: r.get("createdAt") as string,
  }));
}

/**
 * @deprecated Use fetchMemoriesForCredentialScan with pagination instead.
 * Fetch all memories (id + text) for a given agent, or all agents.
 */
export async function fetchAllMemoriesForScan(
  session: Session,
  agentId?: string,
): Promise<Array<{ id: string; text: string }>> {
  const agentFilter = agentId ? "WHERE m.agentId = $agentId" : "";
  const result = await session.run(
    `MATCH (m:Memory)
     ${agentFilter}
     RETURN m.id AS id, m.text AS text`,
    agentId ? { agentId } : {},
  );
  return result.records.map((r) => ({
    id: r.get("id") as string,
    text: r.get("text") as string,
  }));
}

/**
 * Fetch non-core memories older than minAgeDays for temporal staleness checking.
 * Only returns memories that contain date-like patterns to avoid wasting LLM calls
 * on memories that have no temporal component.
 */
export async function fetchMemoriesForTemporalCheck(
  session: Session,
  minAgeDays: number = 3,
  agentId?: string,
): Promise<Array<{ id: string; text: string }>> {
  const agentFilter = agentId ? "AND m.agentId = $agentId" : "";
  // Use originalCreatedAt (true information age) with createdAt as fallback
  // Expanded regex to catch more temporal patterns:
  //   - "Feb 13", "Mar 20" (abbreviated month + day without ordinal)
  //   - "February 13", "March 20-25" (full month + day/range)
  //   - Original patterns: HH:MM, AM/PM, tomorrow/today, ordinal+month, ISO dates, etc.
  const result = await session.run(
    `MATCH (m:Memory)
     WHERE m.category <> 'core'
       AND m.validUntil IS NULL
       AND COALESCE(m.originalCreatedAt, m.createdAt) IS NOT NULL
       AND duration.between(datetime(COALESCE(m.originalCreatedAt, m.createdAt)), datetime()).days >= $minAgeDays
       AND (m.text =~ '(?i).*(\\d{1,2}[:/]\\d{2}|\\d{1,2}\\s*(am|pm)|tomorrow|today|tonight|this morning|this afternoon|this evening|yesterday|last night|next week|\\d{1,2}(st|nd|rd|th)?\\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december)\\s+\\d{1,2}|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}/\\d{1,2}/\\d{2,4}|at \\d+%|progress|downloading|in progress|pending|waiting for).*')
       ${agentFilter}
     RETURN m.id AS id, m.text AS text
     ORDER BY COALESCE(m.originalCreatedAt, m.createdAt) ASC
     LIMIT 200`,
    { minAgeDays: neo4j.int(minAgeDays), agentId },
  );

  return result.records.map((r) => ({
    id: r.get("id") as string,
    text: r.get("text") as string,
  }));
}
