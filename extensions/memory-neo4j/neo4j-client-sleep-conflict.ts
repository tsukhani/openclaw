/**
 * Sleep cycle conflict detection and pending conflict management
 * for the Neo4j memory client.
 *
 * Covers conflict scanning (entity-overlap pairs), LLM-based conflict
 * classification, memory invalidation/supersession, temporal field
 * migration, entity-relationship expiration, and the PENDING_CONFLICT
 * retry queue (OP-125).
 */

import neo4j, { type Session } from "neo4j-driver";
import type { ExtractionConfig } from "./config.js";
import { stripCodeFences } from "./extractor.js";
import { callLlm } from "./llm-client.js";
import type { Logger } from "./schema.js";
import { safeCypherRelType, toJsNumber } from "./schema.js";

// --------------------------------------------------------------------------
// Sleep Cycle: Conflict Detection
// --------------------------------------------------------------------------

/**
 * Find memory pairs that are candidates for conflict resolution.
 *
 * OP-142: Uses embedding similarity on Memory nodes instead of shared-entity
 * MENTIONS traversal. Memory pairs with high vector similarity are likely to
 * contain overlapping/contradictory information.
 * Excludes core memories (those are user-curated).
 */
export async function findConflictingMemories(
  session: Session,
  agentId?: string,
  limit: number = 50,
): Promise<
  Array<{
    memoryA: { id: string; text: string; importance: number; createdAt: string };
    memoryB: { id: string; text: string; importance: number; createdAt: string };
  }>
> {
  const agentFilter = agentId ? "AND m1.agentId = $agentId" : "";
  const m2AgentFilter = agentId ? "AND m2.agentId = $agentId" : "";
  const result = await session.executeRead((tx) =>
    tx.run(
      `MATCH (m1:Memory)
     WHERE m1.validUntil IS NULL AND m1.category <> 'core'
       AND m1.embedding IS NOT NULL AND size(m1.embedding) > 0
       ${agentFilter}
     WITH m1
     ORDER BY m1.createdAt DESC
     LIMIT 200
     CALL db.index.vector.queryNodes('memory_embedding_index', 5, m1.embedding)
     YIELD node AS m2, score
     WHERE m2.id > m1.id AND score >= 0.85
       AND m2.validUntil IS NULL AND m2.category <> 'core'
       ${m2AgentFilter}
     RETURN DISTINCT m1.id AS m1Id, m1.text AS m1Text, m1.importance AS m1Importance, m1.createdAt AS m1CreatedAt,
            m2.id AS m2Id, m2.text AS m2Text, m2.importance AS m2Importance, m2.createdAt AS m2CreatedAt
     LIMIT $limit`,
      agentId ? { agentId, limit: neo4j.int(limit) } : { limit: neo4j.int(limit) },
    ),
  );

  // H5: Use toJsNumber() for importance — Neo4j may return Integer objects, not plain numbers
  return result.records.map((r) => ({
    memoryA: {
      id: r.get("m1Id"),
      text: r.get("m1Text"),
      importance: toJsNumber(r.get("m1Importance")),
      createdAt: String(r.get("m1CreatedAt") ?? ""),
    },
    memoryB: {
      id: r.get("m2Id"),
      text: r.get("m2Text"),
      importance: toJsNumber(r.get("m2Importance")),
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
  await session.executeWrite((tx) =>
    tx.run(
      `MATCH (m:Memory {id: $id})
       SET m.importance = 0.01, m.updatedAt = $now`,
      { id, now: new Date().toISOString() },
    ),
  );
}

/**
 * Batch-invalidate multiple memories in a single Cypher query.
 * Prefer this over sequential invalidateMemory calls when retiring a list of IDs.
 */
export async function invalidateMemories(session: Session, ids: string[]): Promise<void> {
  await session.executeWrite((tx) =>
    tx.run(
      `UNWIND $ids AS id
       MATCH (m:Memory {id: id})
       SET m.importance = 0.01, m.updatedAt = $now`,
      { ids, now: new Date().toISOString() },
    ),
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
  await session.executeWrite((tx) =>
    tx.run(
      `MATCH (m:Memory {id: $oldId})
       SET m.validUntil = $now, m.supersededBy = $newId, m.updatedAt = $now`,
      { oldId, newId, now },
    ),
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
  // SC-P1-7: batch in groups of 1000 to avoid unbounded single transaction on large graphs
  // C2/M10: Use executeWrite for proper transaction routing in clustered deployments
  let totalUpdated = 0;
  let batchUpdated: number;
  do {
    const result = await session.executeWrite((tx) =>
      tx.run(
        `MATCH (m:Memory)
         WHERE m.validFrom IS NULL
         WITH m LIMIT 1000
         SET m.validFrom = COALESCE(m.originalCreatedAt, m.createdAt),
             m.validUntil = null,
             m.supersededBy = null
         RETURN count(m) AS updated`,
      ),
    );
    const raw = result.records[0]?.get("updated");
    batchUpdated = typeof raw === "number" ? raw : Number(raw ?? 0);
    totalUpdated += batchUpdated;
  } while (batchUpdated > 0);
  return totalUpdated;
}

/**
 * Backfill temporal fields on existing entity-to-entity relationships that lack validFrom.
 * Sets validFrom = COALESCE(rel.createdAt, $now) and validUntil = null.
 * Runs once per relType per batch to avoid unbounded transactions on large graphs.
 *
 * @returns Total number of relationships updated
 */
export async function migrateEntityRelationshipTemporalFields(session: Session): Promise<number> {
  // Discover actual relationship types in the graph rather than iterating a hardcoded set.
  // M6: Use executeRead for the discovery query
  const typesResult = await session.executeRead((tx) =>
    tx.run(`MATCH (:Entity)-[r]->(:Entity) RETURN DISTINCT type(r) AS relType`),
  );
  const relTypes = typesResult.records
    .map((r) => r.get("relType") as string)
    .filter((t) => /^[A-Z][A-Z0-9_]*$/.test(t));

  const now = new Date().toISOString();
  let totalUpdated = 0;
  for (const relType of relTypes) {
    // Defense-in-depth: validate at point of Cypher interpolation (upstream filter is primary guard)
    let safeType: string;
    try {
      safeType = safeCypherRelType(relType);
    } catch {
      continue;
    }
    let batchUpdated: number;
    do {
      // C2: Use executeWrite for proper transaction routing in clustered deployments
      const result = await session.executeWrite((tx) =>
        tx.run(
          `MATCH (e1:Entity)-[rel:${safeType}]->(e2:Entity)
           WHERE rel.validFrom IS NULL
           WITH rel LIMIT 1000
           SET rel.validFrom = COALESCE(rel.createdAt, $now), rel.validUntil = null
           RETURN count(rel) AS updated`,
          { now },
        ),
      );
      const raw = result.records[0]?.get("updated");
      batchUpdated = typeof raw === "number" ? raw : Number(raw ?? 0);
      totalUpdated += batchUpdated;
    } while (batchUpdated > 0);
  }
  return totalUpdated;
}

/**
 * Backfill agentId on existing Entity nodes that lack it, using MENTIONS relationships.
 * For each entity without agentId, set it from the first distinct Memory.agentId found
 * via MENTIONS. Idempotent — entities already having agentId are not modified.
 *
 * OP-142: Entities carry their own agentId property (replaces MENTIONS-based agent scoping).
 *
 * @returns Total number of entities updated
 */
export async function migrateEntityAgentId(session: Session): Promise<number> {
  // M16/OP-142: MENTIONS are no longer created, so this migration is effectively
  // a no-op (OPTIONAL MATCH on MENTIONS always returns NULL → WHERE firstAgent IS
  // NOT NULL filters everything out → batchUpdated = 0 → loop exits immediately).
  // Kept for backward compatibility with pre-OP-142 graphs that may still have MENTIONS.
  let totalUpdated = 0;
  let batchUpdated: number;
  do {
    // C2: Use executeWrite for proper transaction routing in clustered deployments
    const result = await session.executeWrite((tx) =>
      tx.run(
        `MATCH (e:Entity)
         WHERE e.agentId IS NULL
         WITH e LIMIT 1000
         OPTIONAL MATCH (m:Memory)-[:MENTIONS]->(e)
         WHERE m.agentId IS NOT NULL
         WITH e, collect(DISTINCT m.agentId)[0] AS firstAgent
         WHERE firstAgent IS NOT NULL
         SET e.agentId = firstAgent
         RETURN count(e) AS updated`,
      ),
    );
    const raw = result.records[0]?.get("updated");
    batchUpdated = typeof raw === "number" ? raw : Number(raw ?? 0);
    totalUpdated += batchUpdated;
  } while (batchUpdated > 0);
  return totalUpdated;
}

/**
 * Expire entity-to-entity relationships where at least one endpoint is orphaned.
 *
 * OP-142: Entity-entity relationships are first-class graph facts. A relationship
 * is only expired when at least one endpoint has no other entity-entity
 * relationships (i.e. the endpoint is about to be deleted by orphan cleanup).
 *
 * @param _agentId  Unused — kept for interface compatibility. Query is intentionally
 *                  global since entity relationships are shared across agents (OP-142).
 * @returns         Number of relationships expired
 */
export async function expireOrphanedEntityRelationships(
  session: Session,
  _agentId: string,
): Promise<number> {
  // Expire relationships where at least one endpoint has no other entity-entity
  // relationships. This pre-expires before findOrphanEntities + DETACH DELETE.
  // C2: Use executeWrite for proper transaction routing in clustered deployments
  const now = new Date().toISOString();
  const result = await session.executeWrite((tx) =>
    tx.run(
      `MATCH (e1:Entity)-[rel]->(e2:Entity)
       WHERE rel.validUntil IS NULL
         AND (
           NOT EXISTS { MATCH (e1)-[other]-(:Entity) WHERE other <> rel }
           OR
           NOT EXISTS { MATCH (e2)-[other]-(:Entity) WHERE other <> rel }
         )
       SET rel.validUntil = $now
       RETURN count(rel) AS expired`,
      { now },
    ),
  );
  const raw = result.records[0]?.get("expired");
  return typeof raw === "number" ? raw : Number(raw ?? 0);
}

/** Type guard for LLM conflict classification response. */
function isClassificationResult(obj: unknown): obj is { classification: string } {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "classification" in obj &&
    typeof (obj as Record<string, unknown>).classification === "string"
  );
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
  } catch (err) {
    logger.debug?.(`memory-neo4j: detectConflicts similarity search failed: ${String(err)}`);
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
      // H14: Per-candidate timeout prevents a single slow LLM call from blocking the entire scan
      const timeoutSignal = AbortSignal.timeout(config.timeout || 30_000);
      const content = await callLlm(
        config,
        [
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
        ],
        timeoutSignal,
      );

      if (!content) continue;

      const parsed: unknown = JSON.parse(stripCodeFences(content));
      if (isClassificationResult(parsed) && parsed.classification === "SUPERSEDES") {
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
  const result = await session.executeRead((tx) =>
    tx.run(
      `MATCH (m:Memory)
     WHERE m.validUntil IS NULL
       AND m.category <> 'core'
       AND m.createdAt IS NOT NULL
       AND duration.between(datetime(m.createdAt), datetime()).days >= $minAgeDays
       AND (m.conflictScannedAt IS NULL OR duration.between(datetime(m.conflictScannedAt), datetime()).days >= 7)
       ${agentFilter}
     RETURN m.id AS id, m.text AS text, m.embedding AS embedding, m.category AS category
     ORDER BY m.createdAt ASC
     LIMIT $limit`,
      {
        minAgeDays: neo4j.int(minAgeDays),
        limit: neo4j.int(limit),
        ...(agentId ? { agentId } : {}),
      },
    ),
  );

  return result.records.map((r) => ({
    id: r.get("id") as string,
    text: r.get("text") as string,
    embedding: r.get("embedding") as number[] | null,
    category: r.get("category") as string,
  }));
}

/**
 * Mark memories as conflict-scanned so they are not re-processed on the next
 * sleep cycle. Uses the same timestamp-based pattern as `markTemporalChecked`.
 * Memories are re-eligible after 7 days (checked in `fetchMemoriesForRetroactiveConflictScan`).
 */
export async function markConflictScanned(session: Session, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await session.executeWrite((tx) =>
    tx.run(
      `UNWIND $ids AS id
       MATCH (m:Memory {id: id})
       SET m.conflictScannedAt = $now`,
      { ids, now: new Date().toISOString() },
    ),
  );
}

// --------------------------------------------------------------------------
// Sleep Cycle: Pending Conflict Pairs (OP-125)
// --------------------------------------------------------------------------

/**
 * Store a pending conflict pair as a PENDING_CONFLICT relationship.
 * Uses canonical direction (lower ID → higher ID) so MERGE is idempotent.
 * Called when resolveConflict returns "transient" — the pair will be retried
 * on the next sleep cycle.
 *
 * @returns true if the relationship was created/already exists, false if either memory is missing
 */
export async function storePendingConflict(
  session: Session,
  idA: string,
  idB: string,
): Promise<boolean> {
  const [srcId, dstId] = idA < idB ? [idA, idB] : [idB, idA];
  const result = await session.executeWrite((tx) =>
    tx.run(
      `MATCH (src:Memory {id: $srcId}), (dst:Memory {id: $dstId})
       MERGE (src)-[r:PENDING_CONFLICT]->(dst)
       ON CREATE SET r.retryCount = 0, r.createdAt = $now
       RETURN count(r) AS stored`,
      { srcId, dstId, now: new Date().toISOString() },
    ),
  );
  const stored = result.records[0]?.get("stored");
  return (typeof stored === "number" ? stored : Number(stored ?? 0)) > 0;
}

/**
 * Fetch all pending conflict pairs eligible for retry.
 * Only returns pairs where both memories are still valid (validUntil IS NULL).
 */
export async function fetchPendingConflicts(
  session: Session,
  agentId?: string,
  limit: number = 50,
): Promise<
  Array<{
    memoryA: { id: string; text: string; importance: number; createdAt: string };
    memoryB: { id: string; text: string; importance: number; createdAt: string };
    retryCount: number;
  }>
> {
  const agentFilter = agentId ? "AND a.agentId = $agentId AND b.agentId = $agentId" : "";
  const result = await session.executeRead((tx) =>
    tx.run(
      `MATCH (a:Memory)-[r:PENDING_CONFLICT]->(b:Memory)
     WHERE a.validUntil IS NULL AND b.validUntil IS NULL ${agentFilter}
     RETURN a.id AS aId, a.text AS aText, a.importance AS aImportance, a.createdAt AS aCreatedAt,
            b.id AS bId, b.text AS bText, b.importance AS bImportance, b.createdAt AS bCreatedAt,
            r.retryCount AS retryCount
     LIMIT $limit`,
      agentId ? { agentId, limit: neo4j.int(limit) } : { limit: neo4j.int(limit) },
    ),
  );

  // H5: Use toJsNumber() for importance — Neo4j may return Integer objects, not plain numbers
  return result.records.map((r) => ({
    memoryA: {
      id: r.get("aId") as string,
      text: r.get("aText") as string,
      importance: toJsNumber(r.get("aImportance")),
      createdAt: String(r.get("aCreatedAt") ?? ""),
    },
    memoryB: {
      id: r.get("bId") as string,
      text: r.get("bText") as string,
      importance: toJsNumber(r.get("bImportance")),
      createdAt: String(r.get("bCreatedAt") ?? ""),
    },
    retryCount: toJsNumber(r.get("retryCount")),
  }));
}

/**
 * Remove the PENDING_CONFLICT relationship between two memories.
 * Called when the conflict is resolved (or permanently unresolvable).
 */
export async function clearPendingConflict(
  session: Session,
  idA: string,
  idB: string,
): Promise<void> {
  await session.executeWrite((tx) =>
    tx.run(
      `MATCH (a:Memory)-[r:PENDING_CONFLICT]-(b:Memory)
       WHERE (a.id = $idA AND b.id = $idB) OR (a.id = $idB AND b.id = $idA)
       DELETE r`,
      { idA, idB },
    ),
  );
}

/**
 * Batch-clear multiple PENDING_CONFLICT relationships.
 * Reduces N round-trips to 1 when resolving multiple conflicts in a single sleep cycle.
 */
export async function clearPendingConflictsBatch(
  session: Session,
  pairs: Array<{ idA: string; idB: string }>,
): Promise<void> {
  if (pairs.length === 0) return;
  await session.executeWrite((tx) =>
    tx.run(
      `UNWIND $pairs AS pair
       MATCH (a:Memory {id: pair.idA})-[r:PENDING_CONFLICT]-(b:Memory {id: pair.idB})
       DELETE r`,
      { pairs },
    ),
  );
}

/**
 * Increment the retry counter on a PENDING_CONFLICT relationship.
 * Called after each failed retry attempt so we can enforce MAX_RETRIES.
 */
export async function incrementPendingConflictRetry(
  session: Session,
  idA: string,
  idB: string,
): Promise<void> {
  await session.executeWrite((tx) =>
    tx.run(
      `MATCH (a:Memory)-[r:PENDING_CONFLICT]-(b:Memory)
       WHERE (a.id = $idA AND b.id = $idB) OR (a.id = $idB AND b.id = $idA)
       SET r.retryCount = coalesce(r.retryCount, 0) + 1`,
      { idA, idB },
    ),
  );
}

/** Allowlist of Memory fields that can be accessed via getMemoryField. */
const ALLOWED_MEMORY_FIELDS = new Set([
  "text",
  "category",
  "importance",
  "source",
  "createdAt",
  "updatedAt",
  "validFrom",
  "validUntil",
  "supersededBy",
  "agentId",
  "extractionStatus",
  "sessionKey",
  "originalCreatedAt",
  "trustScore",
  "quarantined",
]);

/**
 * Get a single field value from a Memory node.
 * Returns undefined if the memory or field doesn't exist.
 * Only fields in ALLOWED_MEMORY_FIELDS can be accessed; requesting
 * other fields (e.g. embedding) throws to prevent info leaks.
 */
export async function getMemoryField(
  session: Session,
  id: string,
  field: string,
): Promise<string | undefined> {
  if (!ALLOWED_MEMORY_FIELDS.has(field)) {
    throw new Error(`getMemoryField: field "${field}" is not in the allowlist`);
  }
  const result = await session.executeRead((tx) =>
    tx.run(`MATCH (m:Memory {id: $id}) RETURN m[$field] AS value`, {
      id,
      field,
    }),
  );
  const record = result.records[0];
  if (!record) return undefined;
  const value = record.get("value");
  return value != null ? String(value) : undefined;
}
