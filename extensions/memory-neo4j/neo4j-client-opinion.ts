/**
 * Opinion node CRUD operations for the Neo4j memory client (OP-186).
 *
 * Opinions are beliefs/preferences synthesized from entity observations and
 * connected memories during the reflection sleep phase. They carry a confidence
 * score that is adjusted as new supporting or contradicting evidence arrives.
 *
 * Graph model:
 *   (Opinion)-[:BELIEVES]->(Entity)   — when entityName is set
 *   Opinion.agentId + Opinion.topic   — composite lookup key
 */

import neo4j, { type Session } from "neo4j-driver";
import { toJsNumber } from "./schema.js";

// ============================================================================
// Index Management
// ============================================================================

/**
 * Ensure indexes on Opinion nodes for efficient lookup.
 * Called during Neo4j client initialization.
 */
export async function ensureOpinionIndexes(session: Session): Promise<void> {
  await session.executeWrite((tx) =>
    tx.run(
      `CREATE INDEX opinion_agent_topic IF NOT EXISTS
       FOR (o:Opinion) ON (o.agentId, o.topic)`,
    ),
  );
}

// ============================================================================
// Opinion CRUD
// ============================================================================

/**
 * Create or update an Opinion node. When entityName is provided, creates a
 * BELIEVES relationship to the matching Entity node.
 *
 * Uses MERGE on (agentId, topic, entityName) for idempotency.
 */
export async function upsertOpinion(
  session: Session,
  agentId: string,
  opinion: {
    topic: string;
    belief: string;
    confidence: number;
    entityName?: string;
    supportingMemoryIds: string[];
    contradictingMemoryIds: string[];
    archived?: boolean;
    dispositionSnapshot?: { skepticism: number; literalism: number; empathy: number };
    generalized?: boolean;
  },
): Promise<void> {
  const entityName = opinion.entityName ?? "";

  // Serialize dispositionSnapshot as JSON string for Neo4j storage
  const dispositionJson = opinion.dispositionSnapshot
    ? JSON.stringify(opinion.dispositionSnapshot)
    : null;
  const generalized = opinion.generalized ?? false;

  await session.executeWrite((tx) =>
    tx.run(
      `MERGE (op:Opinion {agentId: $agentId, topic: $topic, entityName: $entityName})
       ON CREATE SET
         op.id = randomUUID(),
         op.belief = $belief,
         op.confidence = $confidence,
         op.supportingMemoryIds = $supportingMemoryIds,
         op.contradictingMemoryIds = $contradictingMemoryIds,
         op.archived = $archived,
         op.dispositionSnapshot = $dispositionSnapshot,
         op.generalized = $generalized,
         op.lastReflected = datetime().epochMillis,
         op.createdAt = datetime().epochMillis
       ON MATCH SET
         op.belief = $belief,
         op.confidence = $confidence,
         op.supportingMemoryIds = $supportingMemoryIds,
         op.contradictingMemoryIds = $contradictingMemoryIds,
         op.archived = $archived,
         op.dispositionSnapshot = $dispositionSnapshot,
         op.generalized = $generalized,
         op.lastReflected = datetime().epochMillis
       WITH op
       CALL (op) {
         WITH op
         WHERE op.entityName <> ""
         MATCH (e:Entity {agentId: op.agentId, name: op.entityName})
         MERGE (op)-[:BELIEVES]->(e)
       }`,
      {
        agentId,
        topic: opinion.topic,
        entityName,
        belief: opinion.belief,
        confidence: opinion.confidence,
        supportingMemoryIds: opinion.supportingMemoryIds,
        contradictingMemoryIds: opinion.contradictingMemoryIds,
        archived: opinion.archived ?? false,
        dispositionSnapshot: dispositionJson,
        generalized,
      },
    ),
  );
}

/**
 * Fetch opinions about a specific entity (non-archived only).
 */
export async function getOpinionsForEntity(
  session: Session,
  agentId: string,
  entityName: string,
): Promise<
  Array<{
    id: string;
    topic: string;
    belief: string;
    confidence: number;
    supportingMemoryIds: string[];
    contradictingMemoryIds: string[];
  }>
> {
  const result = await session.executeRead((tx) =>
    tx.run(
      `MATCH (op:Opinion {agentId: $agentId, entityName: $entityName})
       WHERE op.archived = false OR op.archived IS NULL
       RETURN op.id AS id, op.topic AS topic, op.belief AS belief,
              op.confidence AS confidence,
              op.supportingMemoryIds AS supportingMemoryIds,
              op.contradictingMemoryIds AS contradictingMemoryIds
       ORDER BY op.confidence DESC`,
      { agentId, entityName },
    ),
  );
  return result.records.map((r) => ({
    id: r.get("id") as string,
    topic: r.get("topic") as string,
    belief: r.get("belief") as string,
    confidence: toJsNumber(r.get("confidence")),
    supportingMemoryIds: (r.get("supportingMemoryIds") as string[]) ?? [],
    contradictingMemoryIds: (r.get("contradictingMemoryIds") as string[]) ?? [],
  }));
}

/**
 * Fetch opinions matching topic keywords (non-archived only).
 * Uses case-insensitive CONTAINS matching against topic field.
 */
export async function getOpinionsForTopics(
  session: Session,
  agentId: string,
  topics: string[],
): Promise<
  Array<{
    id: string;
    topic: string;
    belief: string;
    confidence: number;
    entityName: string;
    supportingMemoryIds: string[];
  }>
> {
  if (topics.length === 0) {
    return [];
  }
  const result = await session.executeRead((tx) =>
    tx.run(
      `UNWIND $topics AS keyword
       MATCH (op:Opinion {agentId: $agentId})
       WHERE (op.archived = false OR op.archived IS NULL)
         AND toLower(op.topic) CONTAINS toLower(keyword)
       RETURN DISTINCT op.id AS id, op.topic AS topic, op.belief AS belief,
              op.confidence AS confidence, op.entityName AS entityName,
              op.supportingMemoryIds AS supportingMemoryIds
       ORDER BY op.confidence DESC`,
      { agentId, topics },
    ),
  );
  return result.records.map((r) => ({
    id: r.get("id") as string,
    topic: r.get("topic") as string,
    belief: r.get("belief") as string,
    confidence: toJsNumber(r.get("confidence")),
    entityName: (r.get("entityName") as string) ?? "",
    supportingMemoryIds: (r.get("supportingMemoryIds") as string[]) ?? [],
  }));
}

/**
 * Find stale opinions: opinions where the entity has new memories added
 * since the opinion's lastReflected timestamp.
 *
 * Used to determine which entities need re-reflection in the sleep cycle.
 */
export async function getStaleOpinions(
  session: Session,
  agentId: string,
  limit: number = 20,
): Promise<
  Array<{
    entityName: string;
    topic: string;
    belief: string;
    confidence: number;
    supportingMemoryIds: string[];
    contradictingMemoryIds: string[];
  }>
> {
  const result = await session.executeRead((tx) =>
    tx.run(
      `MATCH (op:Opinion {agentId: $agentId})
       WHERE (op.archived = false OR op.archived IS NULL)
         AND op.entityName <> ""
       MATCH (e:Entity {agentId: $agentId, name: op.entityName})<-[:EXTRACTED_FROM]-(m:Memory)
       WITH op, max(m.createdAt) AS newestMemory
       WHERE op.lastReflected < newestMemory
       RETURN op.entityName AS entityName, op.topic AS topic, op.belief AS belief,
              op.confidence AS confidence,
              op.supportingMemoryIds AS supportingMemoryIds,
              op.contradictingMemoryIds AS contradictingMemoryIds
       ORDER BY newestMemory DESC
       LIMIT $limit`,
      { agentId, limit: neo4j.int(limit) },
    ),
  );
  return result.records.map((r) => ({
    entityName: r.get("entityName") as string,
    topic: r.get("topic") as string,
    belief: r.get("belief") as string,
    confidence: toJsNumber(r.get("confidence")),
    supportingMemoryIds: (r.get("supportingMemoryIds") as string[]) ?? [],
    contradictingMemoryIds: (r.get("contradictingMemoryIds") as string[]) ?? [],
  }));
}
