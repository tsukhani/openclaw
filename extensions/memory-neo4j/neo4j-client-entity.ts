/**
 * Entity and extraction operations for the Neo4j memory client.
 */

import { randomUUID } from "node:crypto";
import neo4j, { type Session } from "neo4j-driver";
import type { ExtractionStatus } from "./schema.js";
import { safeCypherRelType, sanitizeRelationshipType, toJsNumber } from "./schema.js";

/** Maximum allowed length for entity names. LLM-extracted names exceeding this are truncated. */
const MAX_ENTITY_NAME_LENGTH = 500;

/**
 * Internal Entity node fields that must never be overwritten by LLM-extracted properties.
 * The property merge (`SET n += row.props`) would silently overwrite these if allowed.
 * All keys are lowercase to match the regex-validated property keys.
 */
const INTERNAL_ENTITY_FIELDS = new Set([
  "id",
  "name",
  "type",
  "aliases",
  "description",
  "agentid",
  "firstseen",
  "lastseen",
  "relationshipcount",
  "reclassificationstatus",
  "reclassificationretries",
  "reclassifiedfrom",
  "reclassifiedat",
  "embedding",
  "createdat",
  "updatedat",
]);

/**
 * Truncate a string to MAX_ENTITY_NAME_LENGTH.
 * Returns the original string if within bounds; otherwise truncates and logs
 * at debug level when a logger is available via the module-level holder.
 */
function truncateEntityName(name: string): string {
  if (name.length <= MAX_ENTITY_NAME_LENGTH) return name;
  // Debug-level — callers don't inject a logger here, and truncation is normal for LLM output
  globalThis.console?.debug?.(
    `memory-neo4j: truncated entity name from ${name.length} to ${MAX_ENTITY_NAME_LENGTH} chars`,
  );
  // M12: Use Array.from for safe truncation that doesn't split multi-byte characters
  // (e.g. emoji or CJK characters represented as surrogate pairs in UTF-16)
  const chars = Array.from(name);
  return chars.length <= MAX_ENTITY_NAME_LENGTH
    ? name
    : chars.slice(0, MAX_ENTITY_NAME_LENGTH).join("");
}

/**
 * Update the extraction status of a Memory node.
 * Optionally increments the extractionRetries counter (for transient failure tracking).
 */
export async function updateExtractionStatus(
  session: Session,
  id: string,
  status: ExtractionStatus,
  options?: { incrementRetries?: boolean },
): Promise<void> {
  const retryClause = options?.incrementRetries
    ? ", m.extractionRetries = coalesce(m.extractionRetries, 0) + 1"
    : "";
  await session.executeWrite((tx) =>
    tx.run(
      `MATCH (m:Memory {id: $id})
       SET m.extractionStatus = $status, m.updatedAt = $now${retryClause}`,
      { id, status, now: new Date().toISOString() },
    ),
  );
}

/**
 * Batch-update extraction status for multiple memories.
 * Used by sleep cycle to mark a batch of memories as failed/skipped in one query.
 */
export async function updateExtractionStatusBatch(
  session: Session,
  ids: string[],
  status: ExtractionStatus,
  options?: { incrementRetries?: boolean },
): Promise<void> {
  if (ids.length === 0) return;
  const retryClause = options?.incrementRetries
    ? ", m.extractionRetries = coalesce(m.extractionRetries, 0) + 1"
    : "";
  await session.executeWrite((tx) =>
    tx.run(
      `UNWIND $ids AS id
       MATCH (m:Memory {id: id})
       SET m.extractionStatus = $status, m.updatedAt = $now${retryClause}`,
      { ids, status, now: new Date().toISOString() },
    ),
  );
}

/**
 * Batch all entity operations from an extraction result into a single managed
 * transaction. Replaces the previous pattern of N individual session-per-call
 * operations with a single atomic write.
 *
 * Operations performed atomically:
 * 1. MERGE all Entity nodes (with agentId from source Memory)
 * 2. Create inter-Entity relationships (validated against allowlist)
 * 3. MERGE Tag nodes and create TAGGED relationships
 * 4. Update memory category (if classified and current is 'other')
 * 5. Set extractionStatus to 'complete'
 */
export async function batchEntityOperations(
  session: Session,
  memoryId: string,
  entities: Array<{
    id: string;
    name: string;
    type: string;
    aliases?: string[];
    description?: string;
    properties?: Record<string, string>;
  }>,
  relationships: Array<{
    source: string;
    target: string;
    type: string;
    confidence: number;
    qualifier?: string;
  }>,
  tags: Array<{ name: string; category: string }>,
  category?: string,
): Promise<void> {
  await session.executeWrite(async (tx) => {
    const now = new Date().toISOString();

    // 1. MERGE all entities in one UNWIND.
    //    Entity nodes are scoped by (name, agentId) — each agent gets its own entity graph.
    //    This prevents eval entities from colliding with production entities and ensures
    //    graph search (which filters by agentId) can find all extracted entities.
    if (entities.length > 0) {
      await tx.run(
        `MATCH (mem:Memory {id: $memoryId})
         WITH mem
         UNWIND $entities AS e
         MERGE (n:Entity {name: e.name, agentId: mem.agentId})
         ON CREATE SET
           n.id = e.id, n.type = e.type, n.aliases = e.aliases,
           n.description = e.description,
           n.firstSeen = $now, n.lastSeen = $now
         ON MATCH SET
           n.type = COALESCE(e.type, n.type),
           n.description = COALESCE(e.description, n.description),
           n.lastSeen = $now`,
        {
          memoryId,
          entities: entities.map((e) => ({
            id: e.id,
            name: truncateEntityName(e.name.trim().toLowerCase()),
            type: e.type,
            aliases: (e.aliases ?? []).map((a) => truncateEntityName(a.trim().toLowerCase())),
            description: e.description ?? null,
          })),
          now,
        },
      );

      // 1b. Set structured properties on entities (phone, email, birthday, etc.).
      //     These are stored as top-level node properties so graph search can discover
      //     them via keys(n) and include them in synthesized text.
      //     Uses a single UNWIND with map merge (n += row.props) instead of per-entity
      //     tx.run() to avoid O(N) server round-trips.
      const entitiesWithProps = entities
        .filter((e) => e.properties && Object.keys(e.properties).length > 0)
        .map((e) => {
          const safeProps: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(e.properties!)) {
            if (/^[a-z_][a-z0-9_]*$/.test(k) && !INTERNAL_ENTITY_FIELDS.has(k)) safeProps[k] = v;
          }
          return { name: truncateEntityName(e.name.trim().toLowerCase()), props: safeProps };
        })
        .filter((e) => Object.keys(e.props).length > 0);
      if (entitiesWithProps.length > 0) {
        await tx.run(
          `MATCH (mem:Memory {id: $memoryId})
           WITH mem
           UNWIND $rows AS row
           MATCH (n:Entity {name: row.name, agentId: mem.agentId})
           SET n += row.props`,
          { memoryId, rows: entitiesWithProps },
        );
      }

      // 2. Create EXTRACTED_FROM provenance links back to the source Memory.
      //    This replaces the old MENTIONS relationship (removed in OP-142) with a
      //    lightweight provenance edge. Graph search uses EXTRACTED_FROM to resolve
      //    Entity traversal results back to Memory nodes, so the graph signal returns
      //    Memory IDs consistent with vector/BM25 signals.
      await tx.run(
        `MATCH (mem:Memory {id: $memoryId})
         WITH mem
         UNWIND $entityNames AS eName
         MATCH (n:Entity {name: eName, agentId: mem.agentId})
         MERGE (n)-[:EXTRACTED_FROM]->(mem)`,
        {
          memoryId,
          entityNames: entities.map((e) => truncateEntityName(e.name.trim().toLowerCase())),
        },
      );
    }

    // 3. Create inter-Entity relationships (sanitize types for safe Cypher interpolation)
    const sanitizedRels = relationships
      .map((r) => ({ ...r, type: sanitizeRelationshipType(r.type) }))
      .filter((r): r is typeof r & { type: string } => r.type !== null);
    if (sanitizedRels.length > 0) {
      // Group by relationship type since Cypher requires literal rel types
      const byType = new Map<string, typeof sanitizedRels>();
      for (const rel of sanitizedRels) {
        const group = byType.get(rel.type) ?? [];
        group.push(rel);
        byType.set(rel.type, group);
      }

      for (const [relType, rels] of byType) {
        const safeType = safeCypherRelType(relType);
        await tx.run(
          `MATCH (mem:Memory {id: $memoryId})
           WITH mem
           UNWIND $rels AS r
           MATCH (e1:Entity {name: r.source, agentId: mem.agentId})
           MATCH (e2:Entity {name: r.target, agentId: mem.agentId})
           MERGE (e1)-[rel:${safeType}]->(e2)
           ON CREATE SET rel.confidence = r.confidence, rel.createdAt = $now,
                         rel.validFrom = $now, rel.validUntil = null,
                         rel.qualifier = r.qualifier
           ON MATCH SET rel.confidence = CASE WHEN r.confidence > rel.confidence THEN r.confidence ELSE rel.confidence END,
                        rel.lastSeen = $now, rel.updatedAt = $now,
                        rel.qualifier = CASE WHEN r.qualifier IS NOT NULL THEN r.qualifier ELSE rel.qualifier END`,
          {
            memoryId,
            rels: rels.map((r) => ({
              source: r.source.trim().toLowerCase(),
              target: r.target.trim().toLowerCase(),
              confidence: r.confidence,
              qualifier: r.qualifier ?? null,
            })),
            now,
          },
        );
      }
    }

    // 4. MERGE Tags and create TAGGED relationships in one UNWIND
    if (tags.length > 0) {
      await tx.run(
        `UNWIND $tags AS t
         MERGE (tag:Tag {name: t.name})
         ON CREATE SET tag.id = t.id, tag.category = t.category, tag.createdAt = $now
         WITH tag, t
         MATCH (m:Memory {id: $memoryId})
         MERGE (m)-[r:TAGGED]->(tag)
         ON CREATE SET r.confidence = 1.0`,
        {
          memoryId,
          tags: tags.map((t) => ({
            name: t.name.trim().toLowerCase(),
            category: t.category,
            id: randomUUID(),
          })),
          now,
        },
      );
    }

    // 5. Update category + 6. Set extraction status (in one statement)
    const categoryClause = category
      ? ", m.category = CASE WHEN m.category = 'other' THEN $category ELSE m.category END"
      : "";
    await tx.run(
      `MATCH (m:Memory {id: $memoryId})
       SET m.extractionStatus = 'complete', m.updatedAt = $now${categoryClause}`,
      { memoryId, now, ...(category ? { category } : {}) },
    );
  });
}

/**
 * List memories with pending extraction status.
 * Used by the sleep cycle to batch-process extractions.
 */
export async function listPendingExtractions(
  session: Session,
  limit: number = 100,
  agentId?: string,
): Promise<Array<{ id: string; text: string; agentId: string; extractionRetries: number }>> {
  const agentFilter = agentId ? "AND m.agentId = $agentId" : "";
  const result = await session.executeRead((tx) =>
    tx.run(
      `MATCH (m:Memory)
     WHERE m.extractionStatus IN ['pending', 'skipped'] ${agentFilter}
     AND m.validUntil IS NULL
     RETURN m.id AS id, m.text AS text, m.agentId AS agentId,
            coalesce(m.extractionRetries, 0) AS extractionRetries
     ORDER BY m.createdAt ASC
     LIMIT $limit`,
      { limit: neo4j.int(limit), ...(agentId ? { agentId } : {}) },
    ),
  );
  return result.records.map((r) => ({
    id: r.get("id") as string,
    text: r.get("text") as string,
    agentId: r.get("agentId") as string,
    extractionRetries: toJsNumber(r.get("extractionRetries")),
  }));
}

/**
 * Count memories by extraction status.
 * Used for sleep cycle progress reporting.
 * Only counts non-expired memories (validUntil IS NULL) to stay consistent with
 * listPendingExtractions which skips expired items.
 */
export async function countByExtractionStatus(
  session: Session,
  agentId?: string,
): Promise<Record<ExtractionStatus, number>> {
  const agentFilter = agentId ? "AND m.agentId = $agentId" : "";
  const result = await session.executeRead((tx) =>
    tx.run(
      `MATCH (m:Memory)
     WHERE m.validUntil IS NULL ${agentFilter}
     RETURN m.extractionStatus AS status, count(m) AS count`,
      agentId ? { agentId } : {},
    ),
  );
  const counts: Record<string, number> = {
    pending: 0,
    complete: 0,
    failed: 0,
    skipped: 0,
    decomposed: 0,
  };
  for (const record of result.records) {
    const status = record.get("status") as string;
    const count = toJsNumber(record.get("count"));
    if (status in counts) {
      counts[status] = count;
    }
  }
  return counts as Record<ExtractionStatus, number>;
}

/**
 * Max number of sleep cycles a failed extraction can be reset before giving up permanently.
 * After this many resets the memory stays "failed" and is no longer retried.
 * Total worst-case LLM attempts per memory: MAX_CYCLE_RESETS × MAX_EXTRACTION_RETRIES × (maxRetries+1).
 */
const MAX_CYCLE_RESETS = 3;

/**
 * Reset "failed" extractions back to "pending" so the sleep cycle retries them.
 *
 * Tracks a cross-cycle reset counter (`extractionResetCount`) so items that
 * persistently fail eventually stop being retried after MAX_CYCLE_RESETS cycles.
 * Only resets non-expired memories (validUntil IS NULL) to stay consistent with
 * listPendingExtractions which skips expired items.
 *
 * Per-cycle extractionRetries is reset to 0 so the within-cycle retry budget restarts.
 *
 * @returns Number of memories reset
 */
export async function resetFailedExtractions(session: Session, agentId?: string): Promise<number> {
  const agentFilter = agentId ? "AND m.agentId = $agentId" : "";
  const result = await session.executeWrite((tx) =>
    tx.run(
      `MATCH (m:Memory)
       WHERE m.extractionStatus = 'failed' ${agentFilter}
         AND m.validUntil IS NULL
         AND coalesce(m.extractionResetCount, 0) < $maxResets
       SET m.extractionStatus = 'pending',
           m.extractionRetries = 0,
           m.extractionResetCount = coalesce(m.extractionResetCount, 0) + 1,
           m.updatedAt = $now
       RETURN count(m) AS reset`,
      {
        now: new Date().toISOString(),
        maxResets: neo4j.int(MAX_CYCLE_RESETS),
        ...(agentId ? { agentId } : {}),
      },
    ),
  );
  return toJsNumber(result.records[0]?.get("reset"));
}

/**
 * List memories with completed extraction but no TAGGED relationships.
 * Used by the retroactive tagging phase to find memories that need tags.
 */
export async function listUntaggedMemories(
  session: Session,
  limit: number = 50,
  agentId?: string,
  maxRetries: number = 3,
): Promise<Array<{ id: string; text: string }>> {
  const agentFilter = agentId ? "AND m.agentId = $agentId" : "";
  const result = await session.executeRead((tx) =>
    tx.run(
      `MATCH (m:Memory)
     WHERE m.extractionStatus = 'complete' ${agentFilter}
       AND NOT EXISTS { MATCH (m)-[:TAGGED]->(:Tag) }
       AND coalesce(m.taggingRetries, 0) < $maxRetries
     RETURN m.id AS id, m.text AS text
     ORDER BY m.createdAt ASC
     LIMIT $limit`,
      {
        limit: neo4j.int(limit),
        maxRetries: neo4j.int(maxRetries),
        ...(agentId ? { agentId } : {}),
      },
    ),
  );
  return result.records.map((r) => ({
    id: r.get("id") as string,
    text: r.get("text") as string,
  }));
}

/**
 * Increment the tagging retry counter for a memory that failed retroactive tagging.
 * After maxRetries, listUntaggedMemories will skip it.
 */
export async function incrementTaggingRetries(session: Session, memoryId: string): Promise<void> {
  await session.executeWrite((tx) =>
    tx.run(
      `MATCH (m:Memory {id: $id})
       SET m.taggingRetries = coalesce(m.taggingRetries, 0) + 1`,
      { id: memoryId },
    ),
  );
}

/**
 * Batch-increment tagging retry counters for multiple memories.
 * Reduces N round-trips to 1 when multiple memories fail tagging in a single sleep cycle.
 */
export async function incrementTaggingRetriesBatch(
  session: Session,
  memoryIds: string[],
): Promise<void> {
  if (memoryIds.length === 0) return;
  await session.executeWrite((tx) =>
    tx.run(
      `UNWIND $ids AS id
       MATCH (m:Memory {id: id})
       SET m.taggingRetries = coalesce(m.taggingRetries, 0) + 1`,
      { ids: memoryIds },
    ),
  );
}

/**
 * Get entity graph statistics: entity count, mention count, and density.
 * Density = relationshipCount / max(entityCount, 1).
 */
export async function getEntityGraphStats(
  session: Session,
  agentId?: string,
): Promise<{ entityCount: number; relationshipCount: number; density: number }> {
  // OP-142: Use Entity.agentId property + entity-entity relationship count (not MENTIONS)
  // C1: Agent-scoped query uses directed pattern to avoid double-counting each relationship
  const query = agentId
    ? `OPTIONAL MATCH (e:Entity {agentId: $agentId})
       WITH count(DISTINCT e) AS entityCount
       OPTIONAL MATCH (e1:Entity {agentId: $agentId})-[r]->(:Entity)
       WHERE type(r) <> 'MENTIONS' AND type(r) <> 'TAGGED' AND type(r) <> 'DERIVED_FROM'
       RETURN entityCount, count(r) AS relationshipCount`
    : `OPTIONAL MATCH (e:Entity)
       WITH count(DISTINCT e) AS entityCount
       OPTIONAL MATCH (:Entity)-[r]->(:Entity)
       WHERE type(r) <> 'MENTIONS' AND type(r) <> 'TAGGED' AND type(r) <> 'DERIVED_FROM'
       RETURN entityCount, count(r) AS relationshipCount`;

  const result = await session.executeRead((tx) => tx.run(query, agentId ? { agentId } : {}));
  const entityCount = toJsNumber(result.records[0]?.get("entityCount"));
  const relationshipCount = toJsNumber(result.records[0]?.get("relationshipCount"));
  return {
    entityCount,
    relationshipCount,
    density: relationshipCount / Math.max(entityCount, 1),
  };
}

/**
 * Find entity pairs that are likely duplicates based on name containment.
 * Returns pairs where one entity name is a substring of another (same type),
 * which catches the most common dedup patterns:
 *   - "fish speech" → "fish speech s1 mini"
 *   - "aaditya" → "aaditya sukhani"
 *   - "abundent" → "abundent academy"
 */
export async function findDuplicateEntityPairs(
  session: Session,
  agentId?: string,
  limit: number = 200,
): Promise<
  Array<{
    keepId: string;
    keepName: string;
    removeId: string;
    removeName: string;
    keepRelationships: number;
    removeRelationships: number;
  }>
> {
  // Find pairs where one name contains the other (same type),
  // OR one entity's alias matches the other's name.
  // Keep the entity with more mentions, or the shorter/more canonical name
  // if mention counts are equal.
  // Use fulltext index pre-filter to avoid O(N²) Cartesian product.
  // For each entity e1, db.index.fulltext.queryNodes uses the Lucene BM25
  // index to find a small candidate set e2, reducing complexity from
  // O(N²) to O(N × k) where k is the average candidate set size (~2–10).
  // OP-142: Agent scoping uses Entity.agentId property (not MENTIONS traversal).
  const matchClause = agentId
    ? `MATCH (e1:Entity {agentId: $agentId})
       WHERE size(e1.name) > 2`
    : `MATCH (e1:Entity)
       WHERE size(e1.name) > 2`;

  const result = await session.executeRead((tx) =>
    tx.run(
      `${matchClause}
     WITH e1, reduce(s = e1.name, c IN ['+', '-', '&', '|', '!', '(', ')', '{', '}', '[', ']', '^', '"', '~', '*', '?', ':', '/', '\\\\'] | replace(s, c, ' ')) AS searchName
     WHERE size(trim(searchName)) > 2
     CALL db.index.fulltext.queryNodes('entity_fulltext_index', searchName) YIELD node AS e2, score AS ftScore
     WHERE ftScore >= 0.3 AND e2.id <> e1.id
       AND e1.name < e2.name
       AND e1.type = e2.type
       AND size(e2.name) > 2
       AND (
         e1.name CONTAINS e2.name
         OR e2.name CONTAINS e1.name
         OR ANY(alias IN coalesce(e1.aliases, []) WHERE toLower(alias) = e2.name)
         OR ANY(alias IN coalesce(e2.aliases, []) WHERE toLower(alias) = e1.name)
       )
     WITH e1, e2,
          coalesce(e1.relationshipCount, 0) AS rc1,
          coalesce(e2.relationshipCount, 0) AS rc2
     RETURN e1.id AS id1, e1.name AS name1, rc1,
            e2.id AS id2, e2.name AS name2, rc2
     LIMIT $limit`,
      { limit: neo4j.int(limit), ...(agentId ? { agentId } : {}) },
    ),
  );

  return result.records.map((r) => {
    const name1 = r.get("name1") as string;
    const name2 = r.get("name2") as string;
    const rc1 = toJsNumber(r.get("rc1"));
    const rc2 = toJsNumber(r.get("rc2"));
    const id1 = r.get("id1") as string;
    const id2 = r.get("id2") as string;

    // Keep the entity with more relationships; if tied, keep the shorter (more canonical) name
    const keepFirst = rc1 > rc2 || (rc1 === rc2 && name1.length <= name2.length);
    return {
      keepId: keepFirst ? id1 : id2,
      keepName: keepFirst ? name1 : name2,
      removeId: keepFirst ? id2 : id1,
      removeName: keepFirst ? name2 : name1,
      keepRelationships: keepFirst ? rc1 : rc2,
      removeRelationships: keepFirst ? rc2 : rc1,
    };
  });
}

/**
 * Merge two entities: re-point entity-entity relationships from source to target,
 * then delete the source entity.
 *
 * OP-142: No MENTIONS transfer — entities are independent of Memory nodes.
 * DETACH DELETE on the source removes any remaining edges.
 */
export async function mergeEntityPair(
  session: Session,
  keepId: string,
  removeId: string,
  logger?: { warn: (msg: string) => void },
): Promise<boolean> {
  try {
    await session.executeWrite(async (tx) => {
      const now = new Date().toISOString();
      // H7: Transfer relationships before delete (consistent with batchMergeEntityPairs)
      const relTypesResult = await tx.run(
        `MATCH (remove:Entity {id: $removeId})-[r]-(other:Entity)
         RETURN DISTINCT type(r) AS relType`,
        { removeId },
      );
      const relTypes = relTypesResult.records.map((r) => r.get("relType") as string);
      for (const relType of relTypes) {
        let safeType: string;
        try {
          safeType = safeCypherRelType(relType);
        } catch {
          continue; // skip malformed types
        }
        // Outgoing
        await tx.run(
          `MATCH (remove:Entity {id: $removeId})-[r:${safeType}]->(other:Entity)
           MATCH (keep:Entity {id: $keepId})
           WHERE keep <> other
           MERGE (keep)-[new:${safeType}]->(other)
           ON CREATE SET new = properties(r)
           ON MATCH SET new.updatedAt = $now,
                        new.confidence = CASE WHEN r.confidence > coalesce(new.confidence, 0) THEN r.confidence ELSE new.confidence END
           DELETE r`,
          { removeId, keepId, now },
        );
        // Incoming
        await tx.run(
          `MATCH (other:Entity)-[r:${safeType}]->(remove:Entity {id: $removeId})
           MATCH (keep:Entity {id: $keepId})
           WHERE other <> keep
           MERGE (other)-[new:${safeType}]->(keep)
           ON CREATE SET new = properties(r)
           ON MATCH SET new.updatedAt = $now,
                        new.confidence = CASE WHEN r.confidence > coalesce(new.confidence, 0) THEN r.confidence ELSE new.confidence END
           DELETE r`,
          { removeId, keepId, now },
        );
      }
      // M25: Transfer EXTRACTED_FROM provenance edges to the kept entity before delete.
      // Without this, merged entities lose their Memory provenance and become invisible
      // to graph search (which resolves Entity → Memory via EXTRACTED_FROM).
      await tx.run(
        `MATCH (remove:Entity {id: $removeId})-[r:EXTRACTED_FROM]->(m:Memory)
         MATCH (keep:Entity {id: $keepId})
         MERGE (keep)-[:EXTRACTED_FROM]->(m)
         DELETE r`,
        { removeId, keepId },
      );
      // Update kept entity relationship count
      await tx.run(
        `MATCH (keep:Entity {id: $keepId})
         OPTIONAL MATCH (keep)-[r]-(:Entity)
         WITH keep, count(r) AS actual
         SET keep.relationshipCount = actual, keep.lastSeen = $now`,
        { keepId, now },
      );
      // Delete the removed entity
      await tx.run(`MATCH (e:Entity {id: $removeId}) DETACH DELETE e`, { removeId });
    });

    return true;
  } catch (err) {
    // H15: Re-throw transient errors so retryOnTransient wrapper can retry.
    // Only swallow permanent errors (constraint violations, etc.)
    const msg = err instanceof Error ? err.message : String(err);
    const lowerMsg = msg.toLowerCase();
    if (
      lowerMsg.includes("transient") ||
      lowerMsg.includes("deadlock") ||
      lowerMsg.includes("lock") ||
      lowerMsg.includes("timeout")
    ) {
      throw err;
    }
    const warn = logger?.warn ?? globalThis.console?.warn;
    if (typeof warn === "function") {
      warn(`memory-neo4j: mergeEntityPair failed (keep=${keepId}, remove=${removeId}): ${msg}`);
    }
    return false;
  }
}

/**
 * Maximum number of entity pairs to merge in a single transaction.
 * Each pair generates up to ~15 queries (7 rel types × 2 directions + 1 delete),
 * so large batches risk transaction timeouts.
 */
const BATCH_MERGE_CHUNK_SIZE = 50;

/**
 * Batch-merge multiple entity pairs in a single transaction (OP-106).
 *
 * OP-142: No MENTIONS transfer — entities are independent of Memory nodes.
 * Processes all pairs using UNWIND:
 * 1. Re-point inter-entity relationships — one UNWIND query per rel type
 * 2. Update relationshipCount on kept entities
 * 3. Delete all removed entities in one query
 *
 * If pairs.length exceeds BATCH_MERGE_CHUNK_SIZE (50), the array is split into
 * chunks and each chunk is processed in its own transaction to avoid timeouts.
 *
 * @returns Number of pairs merged (sum across all chunks; 0 on error)
 */
export async function batchMergeEntityPairs(
  session: Session,
  pairs: Array<{ keepId: string; removeId: string }>,
  logger?: { warn: (msg: string) => void },
): Promise<number> {
  if (pairs.length === 0) return 0;

  // Split into chunks to avoid transaction timeouts on large batches
  let merged = 0;
  for (let i = 0; i < pairs.length; i += BATCH_MERGE_CHUNK_SIZE) {
    const chunk = pairs.slice(i, i + BATCH_MERGE_CHUNK_SIZE);
    const chunkResult = await batchMergeEntityPairsChunk(session, chunk, logger);
    if (chunkResult === 0 && chunk.length > 0) {
      // Chunk failed — stop processing further chunks to avoid inconsistent state
      return merged;
    }
    merged += chunkResult;
  }
  return merged;
}

/**
 * Internal: merge a single chunk of entity pairs in one transaction.
 * Chunk size must not exceed BATCH_MERGE_CHUNK_SIZE.
 */
async function batchMergeEntityPairsChunk(
  session: Session,
  pairs: Array<{ keepId: string; removeId: string }>,
  logger?: { warn: (msg: string) => void },
): Promise<number> {
  try {
    await session.executeWrite(async (tx) => {
      const now = new Date().toISOString();

      // 1. Re-point inter-entity relationships (relationship-type agnostic).
      //    Query the actual relationship types present on each remove entity,
      //    then re-point per type (Cypher requires literal rel types for MERGE).
      //    Properties (confidence, validFrom, validUntil, etc.) are preserved
      //    on the new edge via SET new = properties(r).
      const relTypesResult = await tx.run(
        `UNWIND $pairs AS pair
         MATCH (remove:Entity {id: pair.removeId})-[r]-(other:Entity)
         RETURN DISTINCT type(r) AS relType`,
        { pairs },
      );
      const relTypes = relTypesResult.records.map((r) => r.get("relType") as string);
      for (const relType of relTypes) {
        let safeType: string;
        try {
          safeType = safeCypherRelType(relType);
        } catch {
          continue; // safety: skip malformed types
        }
        // Outgoing: (remove)-[relType]->(other) → (keep)-[relType]->(other)
        // Copy properties from old relationship to new one
        await tx.run(
          `UNWIND $pairs AS pair
           MATCH (remove:Entity {id: pair.removeId})-[r:${safeType}]->(other:Entity)
           MATCH (keep:Entity {id: pair.keepId})
           WHERE keep <> other
           MERGE (keep)-[new:${safeType}]->(other)
           ON CREATE SET new = properties(r)
           ON MATCH SET new.updatedAt = $now,
                        new.confidence = CASE WHEN r.confidence > coalesce(new.confidence, 0) THEN r.confidence ELSE new.confidence END
           DELETE r`,
          { pairs, now },
        );
        // Incoming: (other)-[relType]->(remove) → (other)-[relType]->(keep)
        await tx.run(
          `UNWIND $pairs AS pair
           MATCH (other:Entity)-[r:${safeType}]->(remove:Entity {id: pair.removeId})
           MATCH (keep:Entity {id: pair.keepId})
           WHERE other <> keep
           MERGE (other)-[new:${safeType}]->(keep)
           ON CREATE SET new = properties(r)
           ON MATCH SET new.updatedAt = $now,
                        new.confidence = CASE WHEN r.confidence > coalesce(new.confidence, 0) THEN r.confidence ELSE new.confidence END
           DELETE r`,
          { pairs, now },
        );
      }

      // 2. Transfer EXTRACTED_FROM provenance edges to kept entities (M25).
      //    Without this, merged entities lose Memory provenance and become
      //    invisible to graph search (resolves Entity → Memory via EXTRACTED_FROM).
      await tx.run(
        `UNWIND $pairs AS pair
         MATCH (remove:Entity {id: pair.removeId})-[r:EXTRACTED_FROM]->(m:Memory)
         MATCH (keep:Entity {id: pair.keepId})
         MERGE (keep)-[:EXTRACTED_FROM]->(m)
         DELETE r`,
        { pairs },
      );

      // 3. Update relationshipCount for all kept entities
      await tx.run(
        `UNWIND $pairs AS pair
         MATCH (keep:Entity {id: pair.keepId})
         OPTIONAL MATCH (keep)-[r]-(:Entity)
         WITH keep, count(r) AS actual
         SET keep.relationshipCount = actual, keep.lastSeen = $now`,
        { pairs, now },
      );

      // 4. Delete all removed entities (DETACH handles any remaining stray rels)
      await tx.run(
        `UNWIND $pairs AS pair
         MATCH (e:Entity {id: pair.removeId})
         DETACH DELETE e`,
        { pairs },
      );
    });

    return pairs.length;
  } catch (err) {
    // H15: Re-throw transient errors so retryOnTransient wrapper can retry.
    const msg = err instanceof Error ? err.message : String(err);
    const lowerMsg = msg.toLowerCase();
    if (
      lowerMsg.includes("transient") ||
      lowerMsg.includes("deadlock") ||
      lowerMsg.includes("lock") ||
      lowerMsg.includes("timeout")
    ) {
      throw err;
    }
    const warn = logger?.warn ?? globalThis.console?.warn;
    if (typeof warn === "function") {
      warn(`memory-neo4j: batchMergeEntityPairsChunk failed (${pairs.length} pairs): ${msg}`);
    }
    return 0;
  }
}

/**
 * Close a specific entity-to-entity relationship by setting validUntil.
 * Used when a relationship is known to be superseded or contradicted by newer information
 * (e.g. a person changed employer, making the old WORKS_AT edge invalid).
 *
 * M14: Intentionally directional — only closes (A)-[rel]->(B), not (B)-[rel]->(A).
 * Callers must specify the correct direction. For bidirectional closure, call twice
 * with swapped entity names.
 *
 * @param entityAName  Canonical (lowercased) name of the source entity
 * @param entityBName  Canonical (lowercased) name of the target entity
 * @param relType      Relationship type (must pass sanitizeRelationshipType validation)
 * @param closedAt     ISO-8601 timestamp; defaults to now
 * @returns            true if at least one relationship was closed
 */
export async function closeEntityRelationship(
  session: Session,
  entityAName: string,
  entityBName: string,
  relType: string,
  closedAt?: string,
): Promise<boolean> {
  const safeType = safeCypherRelType(
    sanitizeRelationshipType(relType) ?? relType, // sanitize first, fallback to raw for error msg
  );
  const now = closedAt ?? new Date().toISOString();
  const result = await session.executeWrite((tx) =>
    tx.run(
      `MATCH (e1:Entity {name: $nameA})-[rel:${safeType}]->(e2:Entity {name: $nameB})
     WHERE rel.validUntil IS NULL
     SET rel.validUntil = $now, rel.updatedAt = $now
     RETURN count(rel) AS closed`,
      {
        nameA: entityAName.trim().toLowerCase(),
        nameB: entityBName.trim().toLowerCase(),
        now,
      },
    ),
  );
  const closed = toJsNumber(result.records[0]?.get("closed"));
  return closed > 0;
}

/**
 * Supersede an entity relationship: close all existing active relationships of
 * the same type from the source entity, then the caller creates the new one via
 * batchEntityOperations (which sets validFrom = now on the new edge).
 *
 * Example: if Tarun moves from PJ to Capsquare, call
 *   supersedeRelationship(session, "tarun", "LIVES_IN", "capsquare", "agent-1")
 * This closes (tarun)-[:LIVES_IN {validUntil: null}]->(pj) and the new
 * (tarun)-[:LIVES_IN {validFrom: now}]->(capsquare) is created by extraction.
 *
 * @param entityName     Source entity name (lowercased)
 * @param relType        Relationship type (UPPER_SNAKE_CASE)
 * @param newTargetName  New target entity — existing rels to OTHER targets are closed
 * @param agentId        Agent scope
 * @param closedAt       ISO-8601 timestamp; defaults to now
 * @returns              Number of relationships superseded
 */
export async function supersedeRelationship(
  session: Session,
  entityName: string,
  relType: string,
  newTargetName: string,
  agentId: string,
  closedAt?: string,
): Promise<number> {
  const safeType = safeCypherRelType(sanitizeRelationshipType(relType) ?? relType);
  const now = closedAt ?? new Date().toISOString();
  const srcName = entityName.trim().toLowerCase();
  const tgtName = newTargetName.trim().toLowerCase();

  // Close active relationships of the same type from source to any target
  // OTHER than the new target (don't close the rel we're about to create).
  const result = await session.executeWrite((tx) =>
    tx.run(
      `MATCH (src:Entity {name: $srcName, agentId: $agentId})-[rel:${safeType}]->(tgt:Entity)
       WHERE rel.validUntil IS NULL AND tgt.name <> $tgtName
       SET rel.validUntil = $now, rel.updatedAt = $now
       RETURN count(rel) AS superseded`,
      { srcName, tgtName, agentId, now },
    ),
  );
  return toJsNumber(result.records[0]?.get("superseded"));
}

// ============================================================================
// Reclassification operations (Phase 9)
// ============================================================================

/**
 * List entities that need type reclassification.
 * Returns entities with type='concept' that haven't been reclassified yet,
 * along with sample memory texts for LLM context.
 */
export async function listEntitiesForReclassification(
  session: Session,
  limit: number = 20,
): Promise<
  Array<{
    id: string;
    name: string;
    type: string;
    description: string | null;
    memoryContexts: string[];
  }>
> {
  const result = await session.executeRead((tx) =>
    tx.run(
      `MATCH (e:Entity)
       WHERE e.type = 'concept' AND e.reclassificationStatus IS NULL
       WITH e
       ORDER BY coalesce(e.relationshipCount, 0) DESC
       LIMIT $limit
       CALL {
         WITH e
         CALL db.index.fulltext.queryNodes('memory_fulltext_index', e.name)
         YIELD node AS m, score
         WHERE score >= 0.5
         RETURN collect(m.text)[..3] AS contexts
       }
       RETURN e.id AS id, e.name AS name, e.type AS type,
              e.description AS description, contexts`,
      { limit: neo4j.int(limit) },
    ),
  );
  return result.records.map((r) => ({
    id: r.get("id") as string,
    name: r.get("name") as string,
    type: r.get("type") as string,
    description: (r.get("description") as string) ?? null,
    memoryContexts: (r.get("contexts") as string[]) ?? [],
  }));
}

/** Update an entity's type and mark reclassification as complete. */
export async function updateEntityType(
  session: Session,
  entityId: string,
  newType: string,
): Promise<void> {
  await session.executeWrite((tx) =>
    tx.run(
      `MATCH (e:Entity {id: $entityId})
       SET e.type = $newType, e.reclassificationStatus = 'complete', e.updatedAt = $now`,
      { entityId, newType, now: new Date().toISOString() },
    ),
  );
}

/** Mark an entity's reclassification as complete without changing its type. */
export async function markEntityReclassificationComplete(
  session: Session,
  entityId: string,
): Promise<void> {
  await session.executeWrite((tx) =>
    tx.run(
      `MATCH (e:Entity {id: $entityId})
       SET e.reclassificationStatus = 'complete'`,
      { entityId },
    ),
  );
}

/** Mark reclassification as failed for retry on next cycle. */
export async function markEntityReclassificationFailed(
  session: Session,
  entityId: string,
): Promise<void> {
  await session.executeWrite((tx) =>
    tx.run(
      `MATCH (e:Entity {id: $entityId})
       SET e.reclassificationStatus = 'failed',
           e.reclassificationRetries = coalesce(e.reclassificationRetries, 0) + 1`,
      { entityId },
    ),
  );
}

/**
 * List RELATED_TO relationships that need reclassification.
 * Returns entity pairs with descriptions and sample memory context.
 */
export async function listRelatedToForReclassification(
  session: Session,
  limit: number = 20,
): Promise<
  Array<{
    sourceName: string;
    sourceType: string;
    sourceDesc: string | null;
    targetName: string;
    targetType: string;
    targetDesc: string | null;
    memoryContexts: string[];
  }>
> {
  const result = await session.executeRead((tx) =>
    tx.run(
      `MATCH (e1:Entity)-[r:RELATED_TO]->(e2:Entity)
       WHERE r.reclassificationStatus IS NULL
       WITH e1, r, e2
       LIMIT $limit
       CALL {
         WITH e1, e2
         CALL db.index.fulltext.queryNodes('memory_fulltext_index', e1.name + ' ' + e2.name)
         YIELD node AS m, score
         WHERE score >= 0.5
         RETURN collect(m.text)[..2] AS contexts
       }
       RETURN e1.name AS sourceName, e1.type AS sourceType, e1.description AS sourceDesc,
              e2.name AS targetName, e2.type AS targetType, e2.description AS targetDesc,
              contexts`,
      { limit: neo4j.int(limit) },
    ),
  );
  return result.records.map((r) => ({
    sourceName: r.get("sourceName") as string,
    sourceType: r.get("sourceType") as string,
    sourceDesc: (r.get("sourceDesc") as string) ?? null,
    targetName: r.get("targetName") as string,
    targetType: r.get("targetType") as string,
    targetDesc: (r.get("targetDesc") as string) ?? null,
    memoryContexts: (r.get("contexts") as string[]) ?? [],
  }));
}

/**
 * Reclassify a RELATED_TO relationship to a new type.
 * Neo4j doesn't support changing relationship types in-place, so this:
 * 1. Reads properties from the old RELATED_TO edge
 * 2. Creates a new edge of the target type with the same properties
 * 3. Deletes the old RELATED_TO edge
 */
export async function reclassifyRelationship(
  session: Session,
  sourceName: string,
  targetName: string,
  oldType: string,
  newType: string,
): Promise<void> {
  // H3/M13: Use safeCypherRelType for centralized validation (allows digits)
  const safeNew = safeCypherRelType(sanitizeRelationshipType(newType) ?? newType);
  const safeOld = safeCypherRelType(sanitizeRelationshipType(oldType) ?? oldType);
  await session.executeWrite(async (tx) => {
    // M7: MERGE instead of CREATE to prevent duplicate edges if called twice
    await tx.run(
      `MATCH (e1:Entity {name: $source})-[old:${safeOld}]->(e2:Entity {name: $target})
       WITH e1, e2, old, properties(old) AS props
       LIMIT 1
       MERGE (e1)-[new:${safeNew}]->(e2)
       ON CREATE SET new = props, new.reclassifiedFrom = $oldType, new.reclassifiedAt = $now
       ON MATCH SET new.updatedAt = $now
       DELETE old`,
      {
        source: sourceName.trim().toLowerCase(),
        target: targetName.trim().toLowerCase(),
        oldType: safeOld,
        now: new Date().toISOString(),
      },
    );
  });
}

/** Mark a RELATED_TO relationship as skipped (not reclassifiable). */
export async function markRelationshipReclassificationSkipped(
  session: Session,
  sourceName: string,
  targetName: string,
): Promise<void> {
  await session.executeWrite((tx) =>
    tx.run(
      `MATCH (e1:Entity {name: $source})-[r:RELATED_TO]->(e2:Entity {name: $target})
       SET r.reclassificationStatus = 'skipped'`,
      {
        source: sourceName.trim().toLowerCase(),
        target: targetName.trim().toLowerCase(),
      },
    ),
  );
}

/**
 * Reconcile relationshipCount for all entities by counting actual entity-entity
 * relationships (excluding MENTIONS, TAGGED, DERIVED_FROM which connect to
 * Memory/Tag nodes, not Entity→Entity).
 *
 * OP-142: Entities are first-class. relationshipCount reflects graph connectivity
 * and is the primary metric for entity importance in structuredGraphSearch,
 * replacing the MENTIONS-dependent mentionCount for graph-first operations.
 *
 * Intentionally global: Entity nodes are shared across all agents.
 *
 * @returns Number of entities updated
 */
export async function reconcileEntityRelationshipCounts(session: Session): Promise<number> {
  // M6: Exclude MENTIONS/TAGGED/DERIVED_FROM (consistent with getEntityGraphStats)
  // C1: Use directed pattern (->)  to avoid double-counting — undirected (-) counts
  // each relationship from both endpoints, inflating the count by 2x.
  // H2: Process in batches of 1000 to avoid transaction timeout on large entity graphs.
  const BATCH_SIZE = 1000;
  let totalUpdated = 0;
  for (;;) {
    const result = await session.executeWrite((tx) =>
      tx.run(
        `MATCH (e:Entity)
       OPTIONAL MATCH (e)-[r]->(:Entity)
       WHERE type(r) <> 'MENTIONS' AND type(r) <> 'TAGGED' AND type(r) <> 'DERIVED_FROM'
       WITH e, count(r) AS actual
       WHERE e.relationshipCount IS NULL OR e.relationshipCount <> actual
       WITH e, actual LIMIT $batchSize
       SET e.relationshipCount = actual
       RETURN count(e) AS updated`,
        { batchSize: neo4j.int(BATCH_SIZE) },
      ),
    );
    const updated = toJsNumber(result.records[0]?.get("updated"));
    totalUpdated += updated;
    if (updated < BATCH_SIZE) break;
  }
  return totalUpdated;
}

/**
 * List memories that have long text (likely multi-entity) and have not been decomposed yet.
 * Used by Phase 2c (atomic decomposition) to find candidates for decomposition.
 *
 * OP-142: Uses text length heuristic instead of MENTIONS count since MENTIONS
 * are no longer created. minEntityCount maps roughly to text length thresholds.
 */
export async function listMemoriesWithManyEntities(
  session: Session,
  minEntityCount: number = 3,
  limit: number = 50,
  agentId?: string,
): Promise<Array<{ id: string; text: string }>> {
  const agentFilter = agentId ? "AND m.agentId = $agentId" : "";
  // Heuristic: memories with text > ~150 chars per expected entity are likely multi-entity
  const minTextLength = minEntityCount * 50;
  const result = await session.executeRead((tx) =>
    tx.run(
      `MATCH (m:Memory)
     WHERE m.extractionStatus = 'complete' ${agentFilter}
       AND m.validUntil IS NULL
       AND size(m.text) >= $minLen
     RETURN m.id AS id, m.text AS text
     ORDER BY size(m.text) DESC
     LIMIT $limit`,
      {
        minLen: neo4j.int(minTextLength),
        limit: neo4j.int(limit),
        ...(agentId ? { agentId } : {}),
      },
    ),
  );
  return result.records.map((r) => ({
    id: r.get("id") as string,
    text: r.get("text") as string,
  }));
}

/**
 * Create a DERIVED_FROM relationship from an atomic memory back to its source.
 * Used by Phase 2c after storing atomic fact memories from a decomposed source.
 */
export async function createDerivedFromRelationship(
  session: Session,
  atomicMemId: string,
  sourceMemId: string,
): Promise<void> {
  await session.executeWrite((tx) =>
    tx.run(
      `MATCH (a:Memory {id: $atomicMemId})
       MATCH (s:Memory {id: $sourceMemId})
       MERGE (a)-[:DERIVED_FROM]->(s)`,
      { atomicMemId, sourceMemId },
    ),
  );
}
