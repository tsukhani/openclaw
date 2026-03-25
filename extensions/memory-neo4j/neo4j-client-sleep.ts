/**
 * Sleep cycle support operations for the Neo4j memory client.
 *
 * Covers deduplication, orphan cleanup, and credential scanning.
 *
 * Decay/pruning and temporal staleness helpers live in ./neo4j-client-sleep-decay.ts.
 * Conflict detection, pending-conflict queue, and temporal migration helpers
 * live in ./neo4j-client-sleep-conflict.ts.
 */

import neo4j, { type Driver, type Session } from "neo4j-driver";
import type { Logger } from "./schema.js";
import { makePairKey, toJsNumber } from "./schema.js";

// Re-export decay/pruning and temporal staleness helpers
export {
  findDecayedMemories,
  pruneMemories,
  getDecayDistribution,
  fetchMemoriesForTemporalCheck,
  markTemporalChecked,
} from "./neo4j-client-sleep-decay.js";

// Re-export conflict detection, temporal migration, and pending-conflict helpers
export {
  findConflictingMemories,
  invalidateMemory,
  invalidateMemories,
  supersedeMemory,
  migrateTemporalFields,
  migrateEntityRelationshipTemporalFields,
  migrateEntityAgentId,
  expireOrphanedEntityRelationships,
  detectConflicts,
  fetchMemoriesForRetroactiveConflictScan,
  markConflictScanned,
  storePendingConflict,
  fetchPendingConflicts,
  clearPendingConflict,
  clearPendingConflictsBatch,
  incrementPendingConflictRetry,
  getMemoryField,
} from "./neo4j-client-sleep-conflict.js";

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
      // SC-P0-1: exclude core memories — they are user-curated and must never be dedup-deleted
      const agentFilter = agentId
        ? "WHERE m.agentId = $agentId AND m.category <> 'core' AND m.embedding IS NOT NULL AND size(m.embedding) > 0"
        : "WHERE m.category <> 'core' AND m.embedding IS NOT NULL AND size(m.embedding) > 0";
      // H1: Safety LIMIT to prevent OOM on large graphs. Dedup processes up to
      // this many memories per cycle; additional memories are caught in subsequent cycles.
      const DEDUP_MAX_MEMORIES = 50_000;
      const allResult = await session.executeRead((tx) =>
        tx.run(
          `MATCH (m:Memory) ${agentFilter}
         RETURN m.id AS id, m.importance AS importance
         LIMIT $maxMemories`,
          { ...(agentId ? { agentId } : {}), maxMemories: neo4j.int(DEDUP_MAX_MEMORIES) },
        ),
      );

      for (const r of allResult.records) {
        memoryMeta.set(r.get("id") as string, {
          importance: toJsNumber(r.get("importance")),
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

  // Batch vector similarity scan: process chunks of memories in a single Cypher
  // statement using UNWIND + CALL subquery, reducing network round-trips from
  // O(N) to O(N / DEDUP_BATCH_SIZE). Each batch runs server-side vector lookups
  // for all memories in the chunk within one transaction.
  const DEDUP_BATCH_SIZE = 500;
  let pairsFound = 0;
  const allIds = [...memoryMeta.keys()];

  for (let batchStart = 0; batchStart < allIds.length; batchStart += DEDUP_BATCH_SIZE) {
    if (pairsFound > 2000) {
      logger.warn(
        `memory-neo4j: findDuplicateClusters hit safety bound (2000 pairs) — some duplicates may not be detected. Consider running with a higher threshold.`,
      );
      break;
    }

    const batchIds = allIds.slice(batchStart, batchStart + DEDUP_BATCH_SIZE);
    const result = await retryFn(async () => {
      const session = driver.session();
      try {
        return await session.executeRead((tx) =>
          tx.run(
            `UNWIND $ids AS srcId
             MATCH (src:Memory {id: srcId})
             CALL db.index.vector.queryNodes('memory_embedding_index', $k, src.embedding)
             YIELD node, score
             WHERE node.id <> src.id AND score >= $threshold AND node.category <> 'core'
             RETURN src.id AS sourceId, node.id AS matchId, score`,
            { ids: batchIds, k: neo4j.int(10), threshold },
          ),
        );
      } finally {
        await session.close();
      }
    });

    for (const r of result.records) {
      const sourceId = r.get("sourceId") as string;
      const matchId = r.get("matchId") as string;
      if (memoryMeta.has(matchId)) {
        union(sourceId, matchId);
        pairsFound++;

        if (pairwiseSimilarities) {
          const score = r.get("score") as number;
          const pairKey = makePairKey(sourceId, matchId);
          const existing = pairwiseSimilarities.get(pairKey);
          if (existing === undefined || score > existing) {
            pairwiseSimilarities.set(pairKey, score);
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
    // Batch UNWIND into chunks to avoid Neo4j memory pressure on large ID sets
    const UNWIND_CHUNK_SIZE = 5000;
    const allIds = [...clusteredIds];
    const session = driver.session();
    try {
      for (let i = 0; i < allIds.length; i += UNWIND_CHUNK_SIZE) {
        const chunk = allIds.slice(i, i + UNWIND_CHUNK_SIZE);
        const result = await session.executeRead((tx) =>
          tx.run(
            `UNWIND $ids AS memId
           MATCH (m:Memory {id: memId})
           RETURN m.id AS id, m.text AS text`,
            { ids: chunk },
          ),
        );
        for (const r of result.records) {
          textMap.set(r.get("id") as string, r.get("text") as string);
        }
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
      importances: ids.map((id) => memoryMeta.get(id)?.importance ?? 0.5),
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
 * and deleting the rest. Transfers TAGGED relationships to the survivor.
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

    // OP-142: MENTIONS transfer removed — entities are independent of Memory nodes

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
// Sleep Cycle: Orphan Cleanup
// --------------------------------------------------------------------------

/**
 * Find orphaned Entity nodes — entities with no entity-entity relationships.
 *
 * OP-142: Entities are first-class. An entity is orphaned only when it has
 * zero entity-entity relationships. MENTIONS from Memory nodes are not
 * considered (entities are independent of Memory lifecycle).
 */
export async function findOrphanEntities(
  session: Session,
  limit: number = 500,
): Promise<Array<{ id: string; name: string; type: string }>> {
  const result = await session.executeRead((tx) =>
    tx.run(
      `MATCH (e:Entity)
     WHERE NOT EXISTS { MATCH (e)-[]-(:Entity) }
     RETURN e.id AS id, e.name AS name, e.type AS type
     LIMIT $limit`,
      { limit: neo4j.int(limit) },
    ),
  );

  return result.records.map((r) => ({
    id: r.get("id") as string,
    name: r.get("name") as string,
    type: r.get("type") as string,
  }));
}

/** Delete orphaned entities and their relationships. */
export async function deleteOrphanEntities(session: Session, entityIds: string[]): Promise<number> {
  const result = await session.executeWrite((tx) =>
    tx.run(
      `UNWIND $ids AS entId
       MATCH (e:Entity {id: entId})
       DETACH DELETE e
       RETURN count(*) AS deleted`,
      { ids: entityIds },
    ),
  );

  return toJsNumber(result.records[0]?.get("deleted"));
}

/** Find orphaned Tag nodes (no TAGGED relationships from any Memory). */
export async function findOrphanTags(
  session: Session,
  limit: number = 500,
): Promise<Array<{ id: string; name: string }>> {
  const result = await session.executeRead((tx) =>
    tx.run(
      `MATCH (t:Tag)
     WHERE NOT EXISTS { MATCH (:Memory)-[:TAGGED]->(t) }
     RETURN t.id AS id, t.name AS name
     LIMIT $limit`,
      { limit: neo4j.int(limit) },
    ),
  );

  return result.records.map((r) => ({
    id: r.get("id") as string,
    name: r.get("name") as string,
  }));
}

/** Delete orphaned tags. */
export async function deleteOrphanTags(session: Session, tagIds: string[]): Promise<number> {
  const result = await session.executeWrite((tx) =>
    tx.run(
      `UNWIND $ids AS tagId
       MATCH (t:Tag {id: tagId})
       DETACH DELETE t
       RETURN count(*) AS deleted`,
      { ids: tagIds },
    ),
  );

  return toJsNumber(result.records[0]?.get("deleted"));
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
  // Use server-side datetime() to avoid client/server clock drift
  const result = await session.executeRead((tx) =>
    tx.run(
      `MATCH (t:Tag)
     WHERE t.createdAt IS NOT NULL
       AND duration.between(datetime(t.createdAt), datetime()).days >= $minAgeDays
     WITH t
     MATCH (t)<-[:TAGGED]-(m:Memory)
     WITH t, count(m) AS usageCount
     WHERE usageCount = 1
     RETURN t.id AS id, t.name AS name
     LIMIT $limit`,
      { minAgeDays: neo4j.int(minAgeDays), limit: neo4j.int(limit) },
    ),
  );
  return result.records.map((r) => ({
    id: r.get("id") as string,
    name: r.get("name") as string,
  }));
}

// --------------------------------------------------------------------------
// Sleep Cycle: Credential Scanning
// --------------------------------------------------------------------------

/**
 * Fetch a paginated batch of memories (id + text + createdAt) for credential scanning.
 * Uses composite cursor-based pagination (createdAt, id) instead of SKIP to avoid
 * O(N²) re-scanning from the beginning on each page (Perf-6), and to correctly handle
 * batch-stored memories that share an identical createdAt timestamp.
 *
 * Pass cursorTs="" and cursorId="" for the first page; subsequent pages use the
 * createdAt and id of the last record from the previous batch.
 */
export async function fetchMemoriesForCredentialScan(
  session: Session,
  cursorTs: string,
  cursorId: string,
  limit: number,
  agentId?: string,
): Promise<Array<{ id: string; text: string; createdAt: string }>> {
  const result = await session.executeRead((tx) =>
    tx.run(
      `MATCH (m:Memory)
     WHERE ($agentId IS NULL OR m.agentId = $agentId)
       AND m.createdAt IS NOT NULL
       AND (m.createdAt > $cursorTs OR (m.createdAt = $cursorTs AND m.id > $cursorId))
     RETURN m.id AS id, m.text AS text, m.createdAt AS createdAt
     ORDER BY m.createdAt ASC, m.id ASC
     LIMIT $limit`,
      { agentId: agentId ?? null, cursorTs, cursorId, limit: neo4j.int(limit) },
    ),
  );
  return result.records.map((r) => ({
    id: r.get("id") as string,
    text: r.get("text") as string,
    createdAt: r.get("createdAt") as string,
  }));
}

/**
 * @deprecated Use fetchMemoriesForCredentialScan with pagination instead.
 * Fetch memories (id + text) for a given agent, or all agents.
 * H5: Safety LIMIT of 10000 to prevent OOM on large graphs.
 */
const FETCH_ALL_SAFETY_LIMIT = 10_000;

export async function fetchAllMemoriesForScan(
  session: Session,
  agentId?: string,
): Promise<Array<{ id: string; text: string }>> {
  const result = await session.executeRead((tx) =>
    tx.run(
      `MATCH (m:Memory)
     WHERE ($agentId IS NULL OR m.agentId = $agentId)
     RETURN m.id AS id, m.text AS text
     LIMIT $limit`,
      { agentId: agentId ?? null, limit: neo4j.int(FETCH_ALL_SAFETY_LIMIT) },
    ),
  );
  return result.records.map((r) => ({
    id: r.get("id") as string,
    text: r.get("text") as string,
  }));
}
