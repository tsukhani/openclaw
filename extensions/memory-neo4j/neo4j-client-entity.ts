/**
 * Entity and extraction operations for the Neo4j memory client.
 */

import { randomUUID } from "node:crypto";
import neo4j, { type Session } from "neo4j-driver";
import type { ExtractionStatus } from "./schema.js";
import { ALLOWED_RELATIONSHIP_TYPES, validateRelationshipType } from "./schema.js";

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
  await session.run(
    `MATCH (m:Memory {id: $id})
     SET m.extractionStatus = $status, m.updatedAt = $now${retryClause}`,
    { id, status, now: new Date().toISOString() },
  );
}

/**
 * Batch all entity operations from an extraction result into a single managed
 * transaction. Replaces the previous pattern of N individual session-per-call
 * operations with a single atomic write.
 *
 * Operations performed atomically:
 * 1. MERGE all Entity nodes
 * 2. Create MENTIONS relationships (Memory → Entity)
 * 3. Create inter-Entity relationships (validated against allowlist)
 * 4. MERGE Tag nodes and create TAGGED relationships
 * 5. Update memory category (if classified and current is 'other')
 * 6. Set extractionStatus to 'complete'
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
  }>,
  relationships: Array<{
    source: string;
    target: string;
    type: string;
    confidence: number;
  }>,
  tags: Array<{ name: string; category: string }>,
  category?: string,
): Promise<void> {
  await session.executeWrite(async (tx) => {
    const now = new Date().toISOString();

    // 1. MERGE all entities in one UNWIND
    if (entities.length > 0) {
      await tx.run(
        `UNWIND $entities AS e
         MERGE (n:Entity {name: e.name})
         ON CREATE SET
           n.id = e.id, n.type = e.type, n.aliases = e.aliases,
           n.description = e.description,
           n.firstSeen = $now, n.lastSeen = $now, n.mentionCount = 1
         ON MATCH SET
           n.type = COALESCE(e.type, n.type),
           n.description = COALESCE(e.description, n.description),
           n.lastSeen = $now,
           n.mentionCount = n.mentionCount + 1`,
        {
          entities: entities.map((e) => ({
            id: e.id,
            name: e.name.trim().toLowerCase(),
            type: e.type,
            aliases: e.aliases ?? [],
            description: e.description ?? null,
          })),
          now,
        },
      );

      // 2. Create MENTIONS relationships in one UNWIND
      await tx.run(
        `UNWIND $entityNames AS eName
         MATCH (m:Memory {id: $memoryId})
         MATCH (e:Entity {name: eName})
         MERGE (m)-[r:MENTIONS]->(e)
         ON CREATE SET r.role = 'context', r.confidence = 1.0`,
        {
          memoryId,
          entityNames: entities.map((e) => e.name.trim().toLowerCase()),
        },
      );
    }

    // 3. Create inter-Entity relationships (filter valid types)
    const validRels = relationships.filter((r) => validateRelationshipType(r.type));
    if (validRels.length > 0) {
      // Group by relationship type since Cypher requires literal rel types
      const byType = new Map<string, typeof validRels>();
      for (const rel of validRels) {
        const group = byType.get(rel.type) ?? [];
        group.push(rel);
        byType.set(rel.type, group);
      }

      for (const [relType, rels] of byType) {
        await tx.run(
          `UNWIND $rels AS r
           MATCH (e1:Entity {name: r.source})
           MATCH (e2:Entity {name: r.target})
           MERGE (e1)-[rel:${relType}]->(e2)
           ON CREATE SET rel.confidence = r.confidence, rel.createdAt = $now
           ON MATCH SET rel.confidence = CASE WHEN r.confidence > rel.confidence THEN r.confidence ELSE rel.confidence END`,
          {
            rels: rels.map((r) => ({
              source: r.source.trim().toLowerCase(),
              target: r.target.trim().toLowerCase(),
              confidence: r.confidence,
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
  const result = await session.run(
    `MATCH (m:Memory)
     WHERE m.extractionStatus IN ['pending', 'skipped'] ${agentFilter}
     AND m.validUntil IS NULL
     RETURN m.id AS id, m.text AS text, m.agentId AS agentId,
            coalesce(m.extractionRetries, 0) AS extractionRetries
     ORDER BY m.createdAt ASC
     LIMIT $limit`,
    { limit: neo4j.int(limit), ...(agentId ? { agentId } : {}) },
  );
  return result.records.map((r) => ({
    id: r.get("id") as string,
    text: r.get("text") as string,
    agentId: r.get("agentId") as string,
    extractionRetries: r.get("extractionRetries") as number,
  }));
}

/**
 * Count memories by extraction status.
 * Used for sleep cycle progress reporting.
 */
export async function countByExtractionStatus(
  session: Session,
  agentId?: string,
): Promise<Record<ExtractionStatus, number>> {
  const agentFilter = agentId ? "WHERE m.agentId = $agentId" : "";
  const result = await session.run(
    `MATCH (m:Memory)
     ${agentFilter}
     RETURN m.extractionStatus AS status, count(m) AS count`,
    agentId ? { agentId } : {},
  );
  const counts: Record<string, number> = {
    pending: 0,
    complete: 0,
    failed: 0,
    skipped: 0,
  };
  for (const record of result.records) {
    const status = record.get("status") as string;
    const count = (record.get("count") as number) ?? 0;
    if (status in counts) {
      counts[status] = count;
    }
  }
  return counts as Record<ExtractionStatus, number>;
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
  const result = await session.run(
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
  await session.run(
    `MATCH (m:Memory {id: $id})
     SET m.taggingRetries = coalesce(m.taggingRetries, 0) + 1`,
    { id: memoryId },
  );
}

/**
 * Get entity graph statistics: entity count, mention count, and density.
 * Density = mentionCount / max(entityCount, 1).
 */
export async function getEntityGraphStats(
  session: Session,
  agentId?: string,
): Promise<{ entityCount: number; mentionCount: number; density: number }> {
  // When agentId is provided, only count entities connected to that agent's memories
  const query = agentId
    ? `OPTIONAL MATCH (m:Memory {agentId: $agentId})-[r:MENTIONS]->(e:Entity)
       WITH collect(DISTINCT e) AS entities, count(r) AS mentionCount
       RETURN size(entities) AS entityCount, mentionCount`
    : `OPTIONAL MATCH (e:Entity)
       WITH count(DISTINCT e) AS entityCount
       OPTIONAL MATCH ()-[r:MENTIONS]->()
       RETURN entityCount, count(r) AS mentionCount`;

  const result = await session.run(query, agentId ? { agentId } : {});
  const entityCount = (result.records[0]?.get("entityCount") as number) ?? 0;
  const mentionCount = (result.records[0]?.get("mentionCount") as number) ?? 0;
  return {
    entityCount,
    mentionCount,
    density: mentionCount / Math.max(entityCount, 1),
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
    keepMentions: number;
    removeMentions: number;
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
  const result = await session.run(
    `MATCH (e1:Entity)
     WHERE size(e1.name) > 2
     CALL db.index.fulltext.queryNodes('entity_fulltext_index', e1.name) YIELD node AS e2
     WHERE e2.id <> e1.id
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
          coalesce(e1.mentionCount, 0) AS mc1,
          coalesce(e2.mentionCount, 0) AS mc2
     RETURN e1.id AS id1, e1.name AS name1, mc1,
            e2.id AS id2, e2.name AS name2, mc2
     LIMIT $limit`,
    { limit: neo4j.int(limit) },
  );

  return result.records.map((r) => {
    const name1 = r.get("name1") as string;
    const name2 = r.get("name2") as string;
    const mc1 = (r.get("mc1") as number) ?? 0;
    const mc2 = (r.get("mc2") as number) ?? 0;
    const id1 = r.get("id1") as string;
    const id2 = r.get("id2") as string;

    // Keep the entity with more mentions; if tied, keep the shorter (more canonical) name
    const keepFirst = mc1 > mc2 || (mc1 === mc2 && name1.length <= name2.length);
    return {
      keepId: keepFirst ? id1 : id2,
      keepName: keepFirst ? name1 : name2,
      removeId: keepFirst ? id2 : id1,
      removeName: keepFirst ? name2 : name1,
      keepMentions: keepFirst ? mc1 : mc2,
      removeMentions: keepFirst ? mc2 : mc1,
    };
  });
}

/**
 * Merge two entities: transfer MENTIONS relationships from source to target,
 * update mention count, then delete the source entity.
 * Inter-entity relationships on the source are dropped (they'll be
 * re-created by future extractions against the canonical entity).
 */
export async function mergeEntityPair(
  session: Session,
  keepId: string,
  removeId: string,
): Promise<boolean> {
  try {
    await session.executeWrite(async (tx) => {
      // Transfer MENTIONS relationships from removed entity to kept entity
      const transferred = await tx.run(
        `MATCH (remove:Entity {id: $removeId})<-[r:MENTIONS]-(m:Memory)
         MATCH (keep:Entity {id: $keepId})
         MERGE (m)-[:MENTIONS]->(keep)
         DELETE r
         RETURN count(*) AS transferred`,
        { removeId, keepId },
      );
      const transferCount = (transferred.records[0]?.get("transferred") as number) ?? 0;

      // Update kept entity's mention count
      if (transferCount > 0) {
        await tx.run(
          `MATCH (e:Entity {id: $keepId})
           SET e.mentionCount = coalesce(e.mentionCount, 0) + $count,
               e.lastSeen = $now`,
          { keepId, count: neo4j.int(transferCount), now: new Date().toISOString() },
        );
      }

      // Delete the removed entity (DETACH removes all remaining relationships)
      await tx.run(`MATCH (e:Entity {id: $removeId}) DETACH DELETE e`, { removeId });
    });

    return true;
  } catch {
    return false;
  }
}

/**
 * Batch-merge multiple entity pairs in a single transaction (OP-106).
 *
 * Instead of N individual mergeEntityPair calls (N round-trips), this method
 * processes all pairs at once using UNWIND:
 * 1. Transfer all MENTIONS relationships in one query
 * 2. Re-point inter-entity relationships — one UNWIND query per rel type
 *    (7 types × 2 directions = 14 queries), but each covers all N pairs
 * 3. Delete all removed entities in one query
 *
 * Callers must pre-filter pairs to avoid cascading merges (e.g., skip pairs
 * where keepId or removeId has already been removed by an earlier merge).
 *
 * @returns Number of pairs merged (equals pairs.length on success, 0 on error)
 */
export async function batchMergeEntityPairs(
  session: Session,
  pairs: Array<{ keepId: string; removeId: string }>,
): Promise<number> {
  try {
    await session.executeWrite(async (tx) => {
      const now = new Date().toISOString();

      // 1. Transfer MENTIONS (Memory→Entity) from all removed entities to their
      //    corresponding kept entities — single UNWIND covers all pairs
      await tx.run(
        `UNWIND $pairs AS pair
         MATCH (remove:Entity {id: pair.removeId})<-[r:MENTIONS]-(m:Memory)
         MATCH (keep:Entity {id: pair.keepId})
         MERGE (m)-[:MENTIONS]->(keep)
         DELETE r`,
        { pairs },
      );

      // 2. Re-point inter-entity relationships for all ALLOWED_RELATIONSHIP_TYPES.
      //    Cypher requires literal relationship types, so one query per type —
      //    but each query handles all N pairs via UNWIND (not N×7 individual calls).
      for (const relType of ALLOWED_RELATIONSHIP_TYPES) {
        // Outgoing: (remove)-[relType]->(other) → (keep)-[relType]->(other)
        await tx.run(
          `UNWIND $pairs AS pair
           MATCH (remove:Entity {id: pair.removeId})-[r:${relType}]->(other:Entity)
           MATCH (keep:Entity {id: pair.keepId})
           WHERE keep <> other
           MERGE (keep)-[:${relType}]->(other)
           DELETE r`,
          { pairs },
        );
        // Incoming: (other)-[relType]->(remove) → (other)-[relType]->(keep)
        await tx.run(
          `UNWIND $pairs AS pair
           MATCH (other:Entity)-[r:${relType}]->(remove:Entity {id: pair.removeId})
           MATCH (keep:Entity {id: pair.keepId})
           WHERE other <> keep
           MERGE (other)-[:${relType}]->(keep)
           DELETE r`,
          { pairs },
        );
      }

      // 3. Update mentionCounts for all kept entities
      await tx.run(
        `UNWIND $pairs AS pair
         MATCH (keep:Entity {id: pair.keepId})
         OPTIONAL MATCH (m:Memory)-[:MENTIONS]->(keep)
         WITH keep, count(m) AS actual
         SET keep.mentionCount = actual, keep.lastSeen = $now`,
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
  } catch {
    return 0;
  }
}

/**
 * Reconcile mentionCount for all entities by counting actual MENTIONS relationships.
 * Fixes entities with NULL or stale mentionCount values (e.g., entities created
 * before mentionCount tracking was added).
 *
 * @returns Number of entities updated
 */
export async function reconcileEntityMentionCounts(
  session: Session,
  agentId?: string,
): Promise<number> {
  const result = await session.run(
    agentId != null
      ? `MATCH (e:Entity)
         WHERE (e.agentId = $agentId OR e.agentId IS NULL) AND e.mentionCount IS NULL
         OPTIONAL MATCH (m:Memory {agentId: $agentId})-[:MENTIONS]->(e)
         WITH e, count(m) AS actual
         SET e.mentionCount = actual
         RETURN count(e) AS updated`
      : `MATCH (e:Entity)
         WHERE e.mentionCount IS NULL
         OPTIONAL MATCH (m:Memory)-[:MENTIONS]->(e)
         WITH e, count(m) AS actual
         SET e.mentionCount = actual
         RETURN count(e) AS updated`,
    { agentId: agentId ?? null },
  );
  return (result.records[0]?.get("updated") as number) ?? 0;
}
