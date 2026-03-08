/**
 * Core memory CRUD operations for the Neo4j memory client.
 */

import neo4j, { type Session } from "neo4j-driver";
import type { Logger, StoreMemoryInput } from "./schema.js";
import { escapeLucene } from "./schema.js";

/**
 * Persist a memory node to Neo4j.
 * Returns the stored memory ID on success.
 */
export async function storeMemory(session: Session, input: StoreMemoryInput): Promise<string> {
  const now = new Date().toISOString();
  // DL-P1-2: MERGE instead of CREATE so retries after transient failure are safe
  const validFrom = input.validFrom ?? now;
  const result = await session.run(
    `MERGE (m:Memory {id: $id})
     ON CREATE SET
       m.text = $text, m.embedding = $embedding,
       m.importance = $importance, m.category = $category,
       m.source = $source, m.extractionStatus = $extractionStatus,
       m.agentId = $agentId, m.sessionKey = $sessionKey,
       m.taskId = $taskId,
       m.createdAt = $createdAt, m.updatedAt = $updatedAt,
       m.originalCreatedAt = $originalCreatedAt,
       m.retrievalCount = $retrievalCount, m.lastRetrievedAt = $lastRetrievedAt,
       m.extractionRetries = $extractionRetries,
       m.validFrom = $validFrom, m.validUntil = null, m.supersededBy = null
     ON MATCH SET m.updatedAt = $updatedAt
     RETURN m.id AS id`,
    {
      ...input,
      sessionKey: input.sessionKey ?? null,
      taskId: input.taskId ?? null,
      createdAt: now,
      originalCreatedAt: now,
      updatedAt: now,
      retrievalCount: 0,
      lastRetrievedAt: null,
      extractionRetries: 0,
      validFrom,
    },
  );
  return result.records[0].get("id") as string;
}

/**
 * Store multiple memories in a single Cypher UNWIND statement (OP-107).
 *
 * Used by Phase 8 tip generation to batch-store all generated tips after
 * a single embedBatch call. The `safe` array must already be credential-
 * and dimension-filtered by the caller.
 *
 * @returns Number of memories actually stored
 */
export async function storeManyMemories(
  session: Session,
  safe: StoreMemoryInput[],
): Promise<number> {
  const now = new Date().toISOString();
  const items = safe.map((inp) => ({
    id: inp.id,
    text: inp.text,
    embedding: inp.embedding,
    importance: inp.importance,
    category: inp.category,
    source: inp.source,
    extractionStatus: inp.extractionStatus,
    agentId: inp.agentId,
    sessionKey: inp.sessionKey ?? null,
    taskId: inp.taskId ?? null,
    createdAt: now,
    updatedAt: now,
    originalCreatedAt: now,
    validFrom: inp.validFrom ?? now,
    retrievalCount: 0,
    lastRetrievedAt: null,
    extractionRetries: 0,
  }));
  // DL-P1-2: MERGE instead of CREATE so batch retries after transient failure are safe
  const result = await session.run(
    `UNWIND $items AS m
     MERGE (n:Memory {id: m.id})
     ON CREATE SET
       n.text = m.text, n.embedding = m.embedding,
       n.importance = m.importance, n.category = m.category,
       n.source = m.source, n.extractionStatus = m.extractionStatus,
       n.agentId = m.agentId, n.sessionKey = m.sessionKey,
       n.taskId = m.taskId,
       n.createdAt = m.createdAt, n.updatedAt = m.updatedAt,
       n.originalCreatedAt = m.originalCreatedAt,
       n.retrievalCount = m.retrievalCount, n.lastRetrievedAt = m.lastRetrievedAt,
       n.extractionRetries = m.extractionRetries,
       n.validFrom = m.validFrom, n.validUntil = null, n.supersededBy = null
     ON MATCH SET n.updatedAt = m.updatedAt
     RETURN count(*) AS stored`,
    { items },
  );
  return (result.records[0]?.get("stored") as number) ?? 0;
}

/**
 * Delete a memory node by ID. When agentId is provided, scopes the delete to
 * that agent's memories to prevent cross-agent deletion.
 * Returns true if a memory was deleted.
 */
export async function deleteMemory(
  session: Session,
  id: string,
  agentId?: string,
): Promise<boolean> {
  // Atomic: decrement mentionCount and delete in a single Cypher statement
  // to prevent inconsistent state if a crash occurs between operations.
  const matchClause = agentId
    ? "MATCH (m:Memory {id: $id, agentId: $agentId})"
    : "MATCH (m:Memory {id: $id})";
  const result = await session.run(
    `${matchClause}
     OPTIONAL MATCH (m)-[:MENTIONS]->(e:Entity)
     SET e.mentionCount = CASE WHEN e.mentionCount > 0 THEN e.mentionCount - 1 ELSE 0 END
     WITH m, count(e) AS _
     DETACH DELETE m
     RETURN count(*) AS deleted`,
    agentId ? { id, agentId } : { id },
  );
  return result.records.length > 0 ? (result.records[0].get("deleted") as number) > 0 : false;
}

/** Count memories, optionally filtered by agentId. */
export async function countMemories(session: Session, agentId?: string): Promise<number> {
  const query = agentId
    ? "MATCH (m:Memory {agentId: $agentId}) RETURN count(m) AS count"
    : "MATCH (m:Memory) RETURN count(m) AS count";
  const result = await session.executeRead((tx) => tx.run(query, agentId ? { agentId } : {}));
  return (result.records[0]?.get("count") as number) ?? 0;
}

/**
 * Get memory counts grouped by agentId and category.
 * Returns stats for building a summary table.
 */
export async function getMemoryStats(
  session: Session,
  agentId?: string,
): Promise<Array<{ agentId: string; category: string; count: number; avgImportance: number }>> {
  const result = await session.executeRead((tx) =>
    tx.run(
      `MATCH (m:Memory)
    WHERE ($agentId IS NULL OR m.agentId = $agentId)
    RETURN m.agentId AS agentId, m.category AS category,
           count(m) AS count, avg(m.importance) AS avgImportance
    ORDER BY agentId, category`,
      { agentId: agentId ?? null },
    ),
  );
  return result.records.map((r) => {
    const countVal = r.get("count");
    const avgVal = r.get("avgImportance");
    return {
      agentId: (r.get("agentId") as string) ?? "default",
      category: (r.get("category") as string) ?? "other",
      count: typeof countVal === "number" ? countVal : Number(countVal),
      avgImportance: typeof avgVal === "number" ? avgVal : Number(avgVal),
    };
  });
}

/**
 * List memories by category, ordered by importance (descending).
 * Used for loading core memories at session start.
 */
export async function listByCategory(
  session: Session,
  category: string,
  limit: number,
  minImportance: number = 0,
  agentId?: string,
): Promise<{ id: string; text: string; category: string; importance: number }[]> {
  const agentFilter = agentId ? "AND m.agentId = $agentId" : "";
  const result = await session.executeRead((tx) =>
    tx.run(
      `MATCH (m:Memory)
     WHERE m.category = $category AND m.importance >= $minImportance ${agentFilter}
     RETURN m.id AS id, m.text AS text, m.category AS category, m.importance AS importance
     ORDER BY m.importance DESC
     LIMIT $limit`,
      {
        category,
        minImportance,
        limit: neo4j.int(Math.floor(limit)),
        ...(agentId ? { agentId } : {}),
      },
    ),
  );

  return result.records.map((r) => ({
    id: r.get("id") as string,
    text: r.get("text") as string,
    category: r.get("category") as string,
    importance: r.get("importance") as number,
  }));
}

/**
 * Load all core memories for context injection.
 *
 * Core memories are user-curated (created via explicit "remember" requests)
 * with importance locked at 1.0, so there is no meaningful ordering.
 * All core memories are returned — the user manages the size.
 */
export async function listCoreForInjection(
  session: Session,
  agentId?: string,
): Promise<{ id: string; text: string; category: string; importance: number }[]> {
  const agentFilter = agentId ? "AND m.agentId = $agentId" : "";
  const result = await session.executeRead((tx) =>
    tx.run(
      `MATCH (m:Memory)
     WHERE m.category = 'core' ${agentFilter}
     RETURN m.id AS id, m.text AS text, m.category AS category, m.importance AS importance`,
      agentId ? { agentId } : {},
    ),
  );

  return result.records.map((r) => ({
    id: r.get("id") as string,
    text: r.get("text") as string,
    category: r.get("category") as string,
    importance: r.get("importance") as number,
  }));
}

/**
 * Find memories linked to a specific task ID.
 * Used by recall filter and sleep cycle to identify task-related memories.
 */
export async function findMemoriesByTaskId(
  session: Session,
  taskId: string,
  agentId?: string,
): Promise<Array<{ id: string; text: string; category: string; importance: number }>> {
  const agentFilter = agentId ? "AND m.agentId = $agentId" : "";
  const result = await session.executeRead((tx) =>
    tx.run(
      `MATCH (m:Memory)
     WHERE m.taskId = $taskId ${agentFilter}
     RETURN m.id AS id, m.text AS text, m.category AS category, m.importance AS importance
     ORDER BY m.createdAt ASC`,
      { taskId, ...(agentId ? { agentId } : {}) },
    ),
  );
  return result.records.map((r) => ({
    id: r.get("id") as string,
    text: r.get("text") as string,
    category: r.get("category") as string,
    importance: r.get("importance") as number,
  }));
}

/**
 * Bulk-clear taskId from memories (e.g., when the task-memory link is no longer needed).
 * Sets taskId to null rather than deleting the memory.
 */
export async function clearTaskIdFromMemories(
  session: Session,
  taskId: string,
  agentId?: string,
): Promise<number> {
  const agentFilter = agentId ? "AND m.agentId = $agentId" : "";
  const result = await session.run(
    `MATCH (m:Memory)
     WHERE m.taskId = $taskId ${agentFilter}
     SET m.taskId = null
     RETURN count(m) AS cleared`,
    { taskId, ...(agentId ? { agentId } : {}) },
  );
  return (result.records[0]?.get("cleared") as number) ?? 0;
}

/**
 * Delete memories by IDs (DETACH DELETE).
 * Used by the sleep cycle credential scanner.
 *
 * @returns Number of memories deleted
 */
export async function deleteMemoriesByIds(session: Session, ids: string[]): Promise<number> {
  // DL-P1-3: decrement entity mentionCount before deleting, matching deleteMemory behaviour
  const result = await session.run(
    `UNWIND $ids AS id
     MATCH (m:Memory {id: id})
     OPTIONAL MATCH (m)-[:MENTIONS]->(e:Entity)
     WITH m, collect(e) AS entities
     FOREACH (e IN entities |
       SET e.mentionCount = CASE WHEN coalesce(e.mentionCount, 1) > 1
                                  THEN e.mentionCount - 1 ELSE 0 END
     )
     WITH m
     DETACH DELETE m
     RETURN count(*) AS removed`,
    { ids },
  );
  return (result.records[0]?.get("removed") as number) ?? 0;
}

/**
 * Delete non-core, non-pinned memories matching a regex pattern.
 * Used by the sleep cycle noise pattern cleanup.
 *
 * @returns Number of memories deleted
 */
export async function deleteMemoriesByPattern(
  session: Session,
  pattern: string,
  agentId?: string,
  limit = 100,
): Promise<number> {
  const agentFilter = agentId ? "AND m.agentId = $agentId" : "";
  const result = await session.run(
    `MATCH (m:Memory)
     WHERE m.text =~ $pattern
       AND m.category <> 'core'
       ${agentFilter}
     WITH m LIMIT $limit
     DETACH DELETE m
     RETURN count(*) AS removed`,
    { pattern, limit: neo4j.int(limit), ...(agentId ? { agentId } : {}) },
  );
  return (result.records[0]?.get("removed") as number) ?? 0;
}

/**
 * Search memories by keywords using the fulltext (BM25) index.
 * Returns memories whose text matches any of the given keywords.
 * Used by the sleep cycle task-memory cleanup phase to find memories
 * related to completed tasks.
 */
export async function searchMemoriesByKeywords(
  session: Session,
  keywords: string[],
  limit: number = 50,
  agentId?: string,
): Promise<Array<{ id: string; text: string; category: string }>> {
  // Build a Lucene OR query from the keywords
  const escaped = keywords.map((k) => escapeLucene(k.trim())).filter((k) => k.length > 0);
  if (escaped.length === 0) {
    return [];
  }
  const query = escaped.join(" OR ");
  const agentFilter = agentId ? "AND node.agentId = $agentId" : "";
  const result = await session.executeRead((tx) =>
    tx.run(
      `CALL db.index.fulltext.queryNodes('memory_fulltext_index', $query)
     YIELD node, score
     WHERE true ${agentFilter}
     RETURN node.id AS id, node.text AS text, node.category AS category
     ORDER BY score DESC
     LIMIT $limit`,
      {
        query,
        limit: neo4j.int(Math.floor(limit)),
        ...(agentId ? { agentId } : {}),
      },
    ),
  );

  return result.records.map((r) => ({
    id: r.get("id") as string,
    text: r.get("text") as string,
    category: r.get("category") as string,
  }));
}

/** Logger type re-export for internal use (avoids repeated imports). */
export type { Logger };
