/**
 * Core memory CRUD operations for the Neo4j memory client.
 */

import neo4j, { type Session } from "neo4j-driver";
import type { StoreMemoryInput } from "./schema.js";
import { escapeLucene, toJsNumber } from "./schema.js";

/**
 * Persist a memory node to Neo4j.
 * Returns the stored memory ID on success.
 */
export async function storeMemory(session: Session, input: StoreMemoryInput): Promise<string> {
  const now = new Date().toISOString();
  // DL-P1-2: MERGE instead of CREATE so retries after transient failure are safe
  const validFrom = input.validFrom ?? now;
  const result = await session.executeWrite((tx) =>
    tx.run(
      `MERGE (m:Memory {id: $id})
     ON CREATE SET
       m.text = $text, m.embedding = $embedding,
       m.importance = $importance, m.category = $category,
       m.source = $source, m.extractionStatus = $extractionStatus,
       m.agentId = $agentId, m.sessionKey = $sessionKey,
       m.createdAt = $createdAt, m.updatedAt = $updatedAt,
       m.originalCreatedAt = $originalCreatedAt,
       m.retrievalCount = $retrievalCount, m.lastRetrievedAt = $lastRetrievedAt,
       m.extractionRetries = $extractionRetries,
       m.validFrom = $validFrom, m.validUntil = null, m.supersededBy = null,
       m.trustScore = $trustScore, m.quarantined = $quarantined
     ON MATCH SET m.updatedAt = $updatedAt
     RETURN m.id AS id`,
      {
        // C2: Explicitly list fields instead of spreading input to prevent
        // unexpected properties from leaking into Cypher parameters.
        id: input.id,
        text: input.text,
        embedding: input.embedding,
        importance: input.importance,
        category: input.category,
        source: input.source,
        extractionStatus: input.extractionStatus,
        agentId: input.agentId,
        sessionKey: input.sessionKey ?? null,
        createdAt: now,
        originalCreatedAt: now,
        updatedAt: now,
        retrievalCount: 0,
        lastRetrievedAt: null,
        extractionRetries: 0,
        validFrom,
        trustScore: input.trustScore ?? 1.0,
        quarantined: input.quarantined ?? false,
      },
    ),
  );
  return (result.records[0]?.get("id") as string) ?? input.id;
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
    createdAt: now,
    updatedAt: now,
    originalCreatedAt: now,
    validFrom: inp.validFrom ?? now,
    retrievalCount: 0,
    lastRetrievedAt: null,
    extractionRetries: 0,
    trustScore: inp.trustScore ?? 1.0,
    quarantined: inp.quarantined ?? false,
  }));
  // DL-P1-2: MERGE instead of CREATE so batch retries after transient failure are safe.
  // Use a temporary marker (_created) to count only genuinely new nodes — count(*)
  // would include ON MATCH rows that already existed, giving inflated numbers.
  const result = await session.executeWrite((tx) =>
    tx.run(
      `UNWIND $items AS m
     MERGE (n:Memory {id: m.id})
     ON CREATE SET
       n.text = m.text, n.embedding = m.embedding,
       n.importance = m.importance, n.category = m.category,
       n.source = m.source, n.extractionStatus = m.extractionStatus,
       n.agentId = m.agentId, n.sessionKey = m.sessionKey,
       n.createdAt = m.createdAt, n.updatedAt = m.updatedAt,
       n.originalCreatedAt = m.originalCreatedAt,
       n.retrievalCount = m.retrievalCount, n.lastRetrievedAt = m.lastRetrievedAt,
       n.extractionRetries = m.extractionRetries,
       n.validFrom = m.validFrom, n.validUntil = null, n.supersededBy = null,
       n.trustScore = m.trustScore, n.quarantined = m.quarantined,
       n._created = true
     ON MATCH SET n.updatedAt = m.updatedAt
     WITH n
     WITH count(CASE WHEN n._created THEN 1 END) AS stored, collect(n) AS nodes
     UNWIND nodes AS nd
     REMOVE nd._created
     RETURN stored`,
      { items },
    ),
  );
  // M8: Use toJsNumber() — Neo4j may return Integer objects
  return toJsNumber(result.records[0]?.get("stored"));
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
  // OP-142: No mentionCount decrement — entities are independent of Memory lifecycle
  const matchClause = agentId
    ? "MATCH (m:Memory {id: $id, agentId: $agentId})"
    : "MATCH (m:Memory {id: $id})";
  const result = await session.executeWrite((tx) =>
    tx.run(
      `${matchClause}
       DETACH DELETE m
       RETURN count(*) AS deleted`,
      agentId ? { id, agentId } : { id },
    ),
  );
  // M8: Use toJsNumber() — Neo4j may return Integer objects
  return result.records.length > 0 ? toJsNumber(result.records[0].get("deleted")) > 0 : false;
}

/** Count memories, optionally filtered by agentId. */
export async function countMemories(session: Session, agentId?: string): Promise<number> {
  const query = agentId
    ? "MATCH (m:Memory {agentId: $agentId}) RETURN count(m) AS count"
    : "MATCH (m:Memory) RETURN count(m) AS count";
  const result = await session.executeRead((tx) => tx.run(query, agentId ? { agentId } : {}));
  // M8: Use toJsNumber() — Neo4j may return Integer objects
  return toJsNumber(result.records[0]?.get("count"));
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
 * Load core memories for context injection.
 *
 * Core memories are user-curated (created via explicit "remember" requests)
 * with importance locked at 1.0, so there is no meaningful ordering.
 * Safety cap of 200 prevents unbounded context injection payloads.
 */
export const CORE_INJECTION_LIMIT = 200;
export async function listCoreForInjection(
  session: Session,
  agentId?: string,
): Promise<{ id: string; text: string; category: string; importance: number }[]> {
  const agentFilter = agentId ? "AND m.agentId = $agentId" : "";
  const result = await session.executeRead((tx) =>
    tx.run(
      `MATCH (m:Memory)
     WHERE m.category = 'core' ${agentFilter}
     RETURN m.id AS id, m.text AS text, m.category AS category, m.importance AS importance
     LIMIT $limit`,
      { ...(agentId ? { agentId } : {}), limit: neo4j.int(CORE_INJECTION_LIMIT) },
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
 * Delete memories by IDs (DETACH DELETE).
 * Used by the sleep cycle credential scanner.
 *
 * @returns Number of memories deleted
 */
export async function deleteMemoriesByIds(session: Session, ids: string[]): Promise<number> {
  // OP-142: No mentionCount decrement — entities are independent of Memory lifecycle
  const result = await session.executeWrite((tx) =>
    tx.run(
      `UNWIND $ids AS id
       MATCH (m:Memory {id: id})
       DETACH DELETE m
       RETURN count(*) AS removed`,
      { ids },
    ),
  );
  // M16: Use toJsNumber() — Neo4j may return Integer objects
  return toJsNumber(result.records[0]?.get("removed"));
}

/**
 * Detect regex patterns that are structurally prone to catastrophic backtracking (ReDoS).
 *
 * Checks for:
 * 1. Nested quantifiers — a quantifier applied to a group that itself contains a quantifier
 *    (accounts for ~90% of ReDoS in practice).
 * 2. Excessive alternation — more than 10 `|` branches can cause polynomial blowup.
 *
 * @returns null if safe, or a string describing the problem if unsafe.
 */
export function isUnsafeRegex(pattern: string): string | null {
  // Nested quantifier: group containing a quantifier, followed by another quantifier.
  // Matches patterns like (a+)+, (.*a{1,})*, (x+|y+)+, etc.
  const nestedQuantifier =
    /\((?:[^()]*(?:[+*?]|\{\d+(?:,\d*)?\}))[^()]*\)(?:[+*?]|\{\d+(?:,\d*)?\})/;
  if (nestedQuantifier.test(pattern)) {
    return "Pattern contains nested quantifiers (potential ReDoS)";
  }

  // Excessive alternation: more than 10 pipe characters
  const pipeCount = (pattern.match(/\|/g) ?? []).length;
  if (pipeCount > 10) {
    return `Pattern contains ${pipeCount} alternation branches (max 10)`;
  }

  // H1: Detect character class with quantifier inside a quantified group,
  // e.g. ([a-z]+){1,100} — causes polynomial backtracking in most regex engines.
  const charClassInQuantifiedGroup =
    /\((?:[^()]*\[[^\]]+\](?:[+*?]|\{\d+(?:,\d*)?\}))[^()]*\)(?:[+*?]|\{\d+(?:,\d*)?\})/;
  if (charClassInQuantifiedGroup.test(pattern)) {
    return "Pattern contains quantified character class inside a quantified group (potential ReDoS)";
  }

  return null;
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
  // Guard against ReDoS: reject overly long or complex patterns
  const MAX_PATTERN_LENGTH = 200;
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new Error(`Regex pattern too long (${pattern.length} chars, max ${MAX_PATTERN_LENGTH})`);
  }

  const unsafeReason = isUnsafeRegex(pattern);
  if (unsafeReason) {
    throw new Error(`Unsafe regex pattern: ${unsafeReason}`);
  }

  const agentFilter = agentId ? "AND m.agentId = $agentId" : "";
  const result = await session.executeWrite((tx) =>
    tx.run(
      `MATCH (m:Memory)
       WHERE m.text =~ $pattern
         AND m.category <> 'core'
         ${agentFilter}
       WITH m LIMIT $limit
       DETACH DELETE m
       RETURN count(*) AS removed`,
      { pattern, limit: neo4j.int(limit), ...(agentId ? { agentId } : {}) },
    ),
  );
  // M16: Use toJsNumber() — Neo4j may return Integer objects
  return toJsNumber(result.records[0]?.get("removed"));
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
