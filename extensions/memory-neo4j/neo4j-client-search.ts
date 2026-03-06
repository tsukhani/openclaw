/**
 * Search operations (vector, BM25, graph) and retrieval tracking for the Neo4j memory client.
 */

import neo4j, { type Session } from "neo4j-driver";
import type { Logger, SearchSignalResult } from "./schema.js";
import { ALLOWED_RELATIONSHIP_TYPES, escapeLucene } from "./schema.js";

// SAFETY: This pattern is built from the hardcoded ALLOWED_RELATIONSHIP_TYPES constant,
// not from user input. It's used in Cypher variable-length path patterns like
// (e1)-[:WORKS_AT|LIVES_AT|...*1..N]-(e2). Since the source is a compile-time
// constant, there is no injection risk.
const RELATIONSHIP_TYPE_PATTERN = [...ALLOWED_RELATIONSHIP_TYPES].join("|");

// Static assertion: relationship types must be safe identifiers for Cypher interpolation.
// ALLOWED_RELATIONSHIP_TYPES is a hardcoded constant, but this guard catches any future
// addition of a value that doesn't meet the /^[A-Z_]+$/ contract before it causes a runtime issue.
for (const rt of ALLOWED_RELATIONSHIP_TYPES) {
  if (!/^[A-Z_]+$/.test(rt)) {
    throw new Error(`Unsafe relationship type for Cypher interpolation: ${rt}`);
  }
}

/**
 * Build a temporal filter clause for Cypher queries.
 * - asOf provided: point-in-time filter (asOf takes precedence over includeExpired)
 * - includeExpired=false (default): active-only filter (validUntil IS NULL)
 * - includeExpired=true: no temporal filter
 *
 * @param prefix Node alias prefix (e.g. "node." or "m.")
 */
function buildTemporalFilter(
  prefix: string,
  includeExpired?: boolean,
  asOf?: string,
): { filter: string; params: Record<string, string> } {
  if (asOf) {
    return {
      filter: `AND ${prefix}validFrom <= $asOf AND (${prefix}validUntil IS NULL OR ${prefix}validUntil > $asOf)`,
      params: { asOf },
    };
  }
  if (!includeExpired) {
    return { filter: `AND ${prefix}validUntil IS NULL`, params: {} };
  }
  return { filter: "", params: {} };
}

/**
 * Signal 1: HNSW vector similarity search.
 * Returns memories ranked by cosine similarity to the query embedding.
 */
export async function vectorSearch(
  session: Session,
  embedding: number[],
  limit: number,
  minScore: number = 0.1,
  agentId?: string,
  includeExpired?: boolean,
  asOf?: string,
): Promise<SearchSignalResult[]> {
  const agentFilter = agentId ? "AND node.agentId = $agentId" : "";
  const { filter: expiredFilter, params: temporalParams } = buildTemporalFilter(
    "node.",
    includeExpired,
    asOf,
  );
  const result = await session.run(
    `CALL db.index.vector.queryNodes('memory_embedding_index', $limit, $embedding)
     YIELD node, score
     WHERE score >= $minScore ${agentFilter} ${expiredFilter}
     RETURN node.id AS id, node.text AS text, node.category AS category,
            node.importance AS importance, node.createdAt AS createdAt,
            node.taskId AS taskId,
            score AS similarity
     ORDER BY score DESC`,
    {
      embedding,
      limit: neo4j.int(Math.floor(limit)),
      minScore,
      ...(agentId ? { agentId } : {}),
      ...temporalParams,
    },
  );

  return result.records.map((r) => ({
    id: r.get("id") as string,
    text: r.get("text") as string,
    category: r.get("category") as string,
    importance: r.get("importance") as number,
    createdAt: String(r.get("createdAt") ?? ""),
    score: r.get("similarity") as number,
    taskId: (r.get("taskId") as string) ?? undefined,
  }));
}

/**
 * Signal 2: Lucene BM25 full-text keyword search.
 * Returns memories ranked by BM25 relevance score.
 */
export async function bm25Search(
  session: Session,
  query: string,
  limit: number,
  agentId?: string,
  includeExpired?: boolean,
  asOf?: string,
): Promise<SearchSignalResult[]> {
  const agentFilter = agentId ? "AND node.agentId = $agentId" : "";
  const { filter: expiredFilter, params: temporalParams } = buildTemporalFilter(
    "node.",
    includeExpired,
    asOf,
  );
  const result = await session.run(
    `CALL db.index.fulltext.queryNodes('memory_fulltext_index', $query)
     YIELD node, score
     WHERE true ${agentFilter} ${expiredFilter}
     RETURN node.id AS id, node.text AS text, node.category AS category,
            node.importance AS importance, node.createdAt AS createdAt,
            node.taskId AS taskId,
            score AS bm25Score
     ORDER BY score DESC
     LIMIT $limit`,
    {
      query,
      limit: neo4j.int(Math.floor(limit)),
      ...(agentId ? { agentId } : {}),
      ...temporalParams,
    },
  );

  // Normalize BM25 scores to 0-1 range (divide by max)
  const records = result.records.map((r) => ({
    id: r.get("id") as string,
    text: r.get("text") as string,
    category: r.get("category") as string,
    importance: r.get("importance") as number,
    createdAt: String(r.get("createdAt") ?? ""),
    rawScore: r.get("bm25Score") as number,
    taskId: (r.get("taskId") as string) ?? undefined,
  }));

  if (records.length === 0) {
    return [];
  }
  // Min-max normalization with a floor: prevents a single weak BM25
  // match from getting score 1.0 and inflating its RRF contribution.
  const maxScore = records[0].rawScore;
  const minScore = records[records.length - 1].rawScore;
  const range = maxScore - minScore;
  const FLOOR = 0.3; // Minimum normalized score for the lowest-ranked result
  return records.map((r) => ({
    ...r,
    score: range > 0 ? FLOOR + ((1 - FLOOR) * (r.rawScore - minScore)) / range : 0.5, // Single result or identical scores → moderate 0.5 to avoid inflating weak matches
  }));
}

/**
 * Signal 3: Graph traversal search.
 *
 * 1. Find entities matching the query via fulltext index
 * 2. Find memories directly connected to those entities (MENTIONS)
 * 3. 1-hop spreading activation through entity relationships
 *
 * Returns memories with graph-based relevance scores.
 */
export async function graphSearch(
  session: Session,
  query: string,
  limit: number,
  firingThreshold: number = 0.3,
  agentId?: string,
  maxHops: number = 1,
  includeExpired?: boolean,
  asOf?: string,
): Promise<SearchSignalResult[]> {
  // Single query: entity fulltext lookup → direct mentions + N-hop spreading activation
  const agentFilterM = agentId ? "AND m.agentId = $agentId" : "";
  const agentFilterM2 = agentId ? "AND m2.agentId = $agentId" : "";
  const { filter: expiredFilterM, params: temporalParamsM } = buildTemporalFilter(
    "m.",
    includeExpired,
    asOf,
  );
  const { filter: expiredFilterM2 } = buildTemporalFilter("m2.", includeExpired, asOf);
  // Variable-length relationship pattern: 1..maxHops hops through entity relationships
  const hopRange = `1..${Math.max(1, Math.min(3, maxHops))}`;
  const result = await session.run(
    `// Find matching entities via fulltext index (SINGLE lookup)
     CALL db.index.fulltext.queryNodes('entity_fulltext_index', $query)
     YIELD node AS entity, score
     WHERE score >= 0.5
     WITH entity
     ORDER BY score DESC
     LIMIT 5

     // Collect direct mentions
     OPTIONAL MATCH (entity)<-[rm:MENTIONS]-(m:Memory)
     WHERE m IS NOT NULL ${agentFilterM} ${expiredFilterM}
     WITH entity, collect({
       id: m.id, text: m.text, category: m.category,
       importance: m.importance, createdAt: m.createdAt,
       taskId: m.taskId,
       score: coalesce(rm.confidence, 1.0)
     }) AS directResults

     // N-hop spreading activation
     OPTIONAL MATCH (entity)-[rels:${RELATIONSHIP_TYPE_PATTERN}*${hopRange}]-(e2:Entity)
     WHERE ALL(r IN rels WHERE coalesce(r.confidence, 0.7) >= $firingThreshold)
     OPTIONAL MATCH (e2)<-[rm2:MENTIONS]-(m2:Memory)
     WHERE m2 IS NOT NULL ${agentFilterM2} ${expiredFilterM2}
     WITH directResults, collect({
       id: m2.id, text: m2.text, category: m2.category,
       importance: m2.importance, createdAt: m2.createdAt,
       taskId: m2.taskId,
       score: reduce(s = 1.0, r IN rels | s * coalesce(r.confidence, 0.7)) * coalesce(rm2.confidence, 1.0)
     }) AS hopResults

     // Combine and return
     UNWIND (directResults + hopResults) AS row
     WITH row WHERE row.id IS NOT NULL
     RETURN row.id AS id, row.text AS text, row.category AS category,
            row.importance AS importance, row.createdAt AS createdAt,
            row.taskId AS taskId,
            max(row.score) AS graphScore`,
    { query, firingThreshold, ...(agentId ? { agentId } : {}), ...temporalParamsM },
  );

  // Deduplicate by id, keeping highest score
  const byId = new Map<string, SearchSignalResult>();
  for (const record of result.records) {
    const id = record.get("id") as string;
    if (!id) {
      continue;
    }
    const score = record.get("graphScore") as number;
    const existing = byId.get(id);
    if (!existing || score > existing.score) {
      byId.set(id, {
        id,
        text: record.get("text") as string,
        category: record.get("category") as string,
        importance: record.get("importance") as number,
        createdAt: String(record.get("createdAt") ?? ""),
        score,
        taskId: (record.get("taskId") as string) ?? undefined,
      });
    }
  }

  return Array.from(byId.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Find similar memories by vector similarity. Used for deduplication.
 * When agentId is provided, results are post-filtered to that agent
 * (HNSW indexes don't support pre-filtering, so we fetch extra candidates).
 */
export async function findSimilar(
  session: Session,
  embedding: number[],
  threshold: number = 0.95,
  limit: number = 1,
  agentId?: string,
): Promise<Array<{ id: string; text: string; score: number }>> {
  // Fetch extra candidates when filtering by agentId since HNSW
  // doesn't support pre-filtering; post-filter and trim to limit.
  const fetchLimit = agentId ? limit * 3 : limit;
  const agentFilter = agentId ? "AND node.agentId = $agentId" : "";
  const result = await session.run(
    `CALL db.index.vector.queryNodes('memory_embedding_index', $limit, $embedding)
     YIELD node, score
     WHERE score >= $threshold ${agentFilter}
     RETURN node.id AS id, node.text AS text, score AS similarity
     ORDER BY score DESC`,
    {
      embedding,
      limit: neo4j.int(fetchLimit),
      threshold,
      ...(agentId ? { agentId } : {}),
    },
  );

  const results = result.records.map((r) => ({
    id: r.get("id") as string,
    text: r.get("text") as string,
    score: r.get("similarity") as number,
  }));
  // Trim to requested limit after post-filtering
  return agentId ? results.slice(0, limit) : results;
}

/**
 * Record retrieval events for memories. Called after search/recall.
 * Increments retrievalCount and updates lastRetrievedAt timestamp.
 */
export async function recordRetrievals(session: Session, memoryIds: string[]): Promise<void> {
  await session.run(
    `UNWIND $ids AS memId
     MATCH (m:Memory {id: memId})
     SET m.retrievalCount = coalesce(m.retrievalCount, 0) + 1,
         m.lastRetrievedAt = $now,
         m.importance = CASE WHEN coalesce(m.importance, 0.5) + 0.05 > 1.0 THEN 1.0 ELSE coalesce(m.importance, 0.5) + 0.05 END`,
    { ids: memoryIds, now: new Date().toISOString() },
  );
}

/** Escape a query string for Lucene before passing to bm25Search. */
export { escapeLucene };
