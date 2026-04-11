/**
 * Observation node CRUD operations for the Neo4j memory client.
 *
 * Observations are per-entity summaries synthesized from connected memories
 * during the sleep cycle. They provide a concise profile paragraph for each
 * entity, used as a low-weight search signal and for entity context enrichment.
 */

import neo4j, { type Session } from "neo4j-driver";
import { toJsNumber } from "./schema.js";

// ============================================================================
// Index Management
// ============================================================================

/**
 * Ensure indexes on Observation nodes for efficient lookup.
 * Called during Neo4j client initialization.
 */
export async function ensureObservationIndexes(session: Session): Promise<void> {
  await session.executeWrite((tx) =>
    tx.run(
      `CREATE INDEX observation_agent_entity IF NOT EXISTS
       FOR (o:Observation) ON (o.agentId, o.entityName)`,
    ),
  );
}

// ============================================================================
// Stale Entity Detection
// ============================================================================

/**
 * Find entities with 3+ EXTRACTED_FROM memories where either:
 * - No Observation node exists, OR
 * - New memories were added since the Observation's lastRefreshed timestamp.
 *
 * Returns entity names eligible for observation generation, limited to `limit`.
 */
export async function getStaleEntities(
  session: Session,
  agentId: string,
  limit: number = 20,
): Promise<string[]> {
  const result = await session.executeRead((tx) =>
    tx.run(
      `MATCH (e:Entity {agentId: $agentId})-[:EXTRACTED_FROM]->(m:Memory)
       WITH e, count(m) AS memCount, max(m.createdAt) AS newestMemory
       WHERE memCount >= 3
       OPTIONAL MATCH (e)<-[:OBSERVES]-(o:Observation {agentId: $agentId})
       WITH e.name AS entityName, memCount, newestMemory, o
       WHERE o IS NULL OR o.lastRefreshed < newestMemory
       RETURN entityName
       ORDER BY memCount DESC
       LIMIT $limit`,
      { agentId, limit: neo4j.int(limit) },
    ),
  );
  return result.records.map((r) => r.get("entityName") as string);
}

// ============================================================================
// Observation CRUD
// ============================================================================

/**
 * Create or update an Observation node with an OBSERVES relationship to the Entity.
 * Uses MERGE for idempotency — repeated calls with the same agentId+entityName
 * update the existing node rather than creating duplicates.
 */
export async function upsertObservation(
  session: Session,
  agentId: string,
  entityName: string,
  summary: string,
  memoryCount: number,
): Promise<void> {
  await session.executeWrite((tx) =>
    tx.run(
      `MATCH (e:Entity {agentId: $agentId, name: $entityName})
       MERGE (o:Observation {agentId: $agentId, entityName: $entityName})
       ON CREATE SET
         o.id = randomUUID(),
         o.summary = $summary,
         o.memoryCount = $memoryCount,
         o.lastRefreshed = datetime().epochMillis
       ON MATCH SET
         o.summary = $summary,
         o.memoryCount = $memoryCount,
         o.lastRefreshed = datetime().epochMillis
       MERGE (o)-[:OBSERVES]->(e)`,
      {
        agentId,
        entityName,
        summary,
        memoryCount: neo4j.int(memoryCount),
      },
    ),
  );
}

/**
 * Fetch existing observations for a list of entity names.
 * Used by search to inject observation summaries as a signal.
 */
export async function getObservationsForEntities(
  session: Session,
  agentId: string,
  entityNames: string[],
): Promise<Array<{ entityName: string; summary: string; memoryIds: string[] }>> {
  if (entityNames.length === 0) {
    return [];
  }
  const result = await session.executeRead((tx) =>
    tx.run(
      `UNWIND $entityNames AS name
       MATCH (o:Observation {agentId: $agentId, entityName: name})-[:OBSERVES]->(e:Entity)
       OPTIONAL MATCH (e)-[:EXTRACTED_FROM]->(m:Memory)
       WITH o, e, collect(DISTINCT m.id) AS memoryIds
       RETURN o.entityName AS entityName, o.summary AS summary, memoryIds`,
      { agentId, entityNames },
    ),
  );
  return result.records.map((r) => ({
    entityName: r.get("entityName") as string,
    summary: r.get("summary") as string,
    memoryIds: (r.get("memoryIds") as string[]).filter(Boolean),
  }));
}

/**
 * Collect memory texts connected to an entity via EXTRACTED_FROM.
 * Returns the most recent memories (by createdAt desc), limited to `limit`.
 */
export async function getEntityMemoryTexts(
  session: Session,
  agentId: string,
  entityName: string,
  limit: number = 50,
): Promise<Array<{ id: string; text: string }>> {
  const result = await session.executeRead((tx) =>
    tx.run(
      `MATCH (e:Entity {agentId: $agentId, name: $entityName})-[:EXTRACTED_FROM]->(m:Memory)
       RETURN m.id AS id, m.text AS text
       ORDER BY m.createdAt DESC
       LIMIT $limit`,
      { agentId, entityName, limit: neo4j.int(limit) },
    ),
  );
  return result.records.map((r) => ({
    id: r.get("id") as string,
    text: r.get("text") as string,
  }));
}
