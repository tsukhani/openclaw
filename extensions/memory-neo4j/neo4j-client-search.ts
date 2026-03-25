/**
 * Search operations (vector, BM25, graph) and retrieval tracking for the Neo4j memory client.
 */

import neo4j, { type Session } from "neo4j-driver";
import { cosineSimilarity } from "./embeddings.js";
import type { Logger, SearchSignalResult } from "./schema.js";
import { escapeLucene, sanitizeRelationshipType, toJsNumber } from "./schema.js";

/** M24: Minimum normalized BM25 score for the lowest-ranked result. Prevents a single weak match from inflating its RRF contribution. */
const BM25_NORMALIZATION_FLOOR = 0.3;

/** M21: Timeout on N-hop traversal to prevent runaway queries.
 * M25: Reduced from 5s to 2s — with max hop depth capped at 3 (down from 4),
 * traversal completes in <100ms for typical graphs. The 2s budget covers edge
 * cases (large fan-out, cold caches) without dominating search latency. */
const GRAPH_TRAVERSAL_TIMEOUT_MS = 2000;

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
  if (asOf && asOf.length > 0) {
    // M4: Normalize asOf to ISO-8601 with Z suffix for consistent string comparison.
    // Without this, mixed timezone formats (e.g. +08:00 vs no offset) produce incorrect results.
    const normalizedAsOf =
      asOf.includes("T") && !asOf.endsWith("Z") && !/[+-]\d{2}:\d{2}$/.test(asOf)
        ? asOf + "Z"
        : asOf;
    return {
      filter: `AND ${prefix}validFrom <= $asOf AND (${prefix}validUntil IS NULL OR ${prefix}validUntil > $asOf)`,
      params: { asOf: normalizedAsOf },
    };
  }
  if (!includeExpired) {
    return { filter: `AND ${prefix}validUntil IS NULL`, params: {} };
  }
  return { filter: "", params: {} };
}

/**
 * Build a createdAt date range filter clause for Cypher queries.
 * Returns AND clauses that restrict results to memories created within the range.
 *
 * @param prefix Node alias prefix (e.g. "node." or "m.")
 * @param dateRangeStart ISO-8601 start of range (inclusive)
 * @param dateRangeEnd ISO-8601 end of range (inclusive)
 */
function buildDateRangeFilter(
  prefix: string,
  dateRangeStart?: string,
  dateRangeEnd?: string,
): { filter: string; params: Record<string, string> } {
  if (!dateRangeStart && !dateRangeEnd) return { filter: "", params: {} };
  const parts: string[] = [];
  const params: Record<string, string> = {};
  if (dateRangeStart) {
    parts.push(`AND ${prefix}createdAt >= $dateRangeStart`);
    params.dateRangeStart = dateRangeStart;
  }
  if (dateRangeEnd) {
    parts.push(`AND ${prefix}createdAt <= $dateRangeEnd`);
    params.dateRangeEnd = dateRangeEnd;
  }
  return { filter: parts.join(" "), params };
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
  includeQuarantined?: boolean,
  dateRangeStart?: string,
  dateRangeEnd?: string,
): Promise<SearchSignalResult[]> {
  const agentFilter = agentId ? "AND node.agentId = $agentId" : "";
  const quarantineFilter = includeQuarantined
    ? ""
    : "AND (node.quarantined IS NULL OR node.quarantined = false)";
  const { filter: expiredFilter, params: temporalParams } = buildTemporalFilter(
    "node.",
    includeExpired,
    asOf,
  );
  const { filter: dateRangeFilter, params: dateRangeParams } = buildDateRangeFilter(
    "node.",
    dateRangeStart,
    dateRangeEnd,
  );
  const result = await session.executeRead((tx) =>
    tx.run(
      `CALL db.index.vector.queryNodes('memory_embedding_index', $limit, $embedding)
     YIELD node, score
     WHERE score >= $minScore ${agentFilter} ${expiredFilter} ${quarantineFilter} ${dateRangeFilter}
     RETURN node.id AS id, node.text AS text, node.category AS category,
            node.importance AS importance, node.createdAt AS createdAt,
            node.validFrom AS validFrom,
            node.supersededBy AS supersededBy,
            COALESCE(node.trustScore, 1.0) AS trustScore,
            score AS similarity
     ORDER BY score DESC
     LIMIT $requestedLimit`,
      {
        embedding,
        limit: neo4j.int(Math.floor(agentId ? Math.min(limit * 3, 200) : limit)),
        requestedLimit: neo4j.int(limit),
        minScore,
        ...(agentId ? { agentId } : {}),
        ...temporalParams,
        ...dateRangeParams,
      },
    ),
  );

  return result.records.map((r) => ({
    id: r.get("id") as string,
    text: r.get("text") as string,
    category: r.get("category") as string,
    importance: toJsNumber(r.get("importance")),
    createdAt: String(r.get("createdAt") ?? ""),
    validFrom: r.get("validFrom") != null ? String(r.get("validFrom")) : undefined,
    supersededBy: r.get("supersededBy") != null ? String(r.get("supersededBy")) : null,
    score: r.get("similarity") as number,
    trustScore: toJsNumber(r.get("trustScore")) || 1.0,
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
  includeQuarantined?: boolean,
  dateRangeStart?: string,
  dateRangeEnd?: string,
): Promise<SearchSignalResult[]> {
  const escaped = escapeLucene(query);
  if (!escaped.trim()) return [];
  const agentFilter = agentId ? "AND node.agentId = $agentId" : "";
  const quarantineFilter = includeQuarantined
    ? ""
    : "AND (node.quarantined IS NULL OR node.quarantined = false)";
  const { filter: expiredFilter, params: temporalParams } = buildTemporalFilter(
    "node.",
    includeExpired,
    asOf,
  );
  const { filter: dateRangeFilter, params: dateRangeParams } = buildDateRangeFilter(
    "node.",
    dateRangeStart,
    dateRangeEnd,
  );
  const result = await session.executeRead((tx) =>
    tx.run(
      `CALL db.index.fulltext.queryNodes('memory_fulltext_index', $query)
     YIELD node, score
     WHERE true ${agentFilter} ${expiredFilter} ${quarantineFilter} ${dateRangeFilter}
     RETURN node.id AS id, node.text AS text, node.category AS category,
            node.importance AS importance, node.createdAt AS createdAt,
            node.validFrom AS validFrom,
            node.supersededBy AS supersededBy,
            COALESCE(node.trustScore, 1.0) AS trustScore,
            score AS bm25Score
     ORDER BY score DESC
     LIMIT $limit`,
      {
        query: escaped,
        limit: neo4j.int(Math.floor(limit)),
        ...(agentId ? { agentId } : {}),
        ...temporalParams,
        ...dateRangeParams,
      },
    ),
  );

  // Normalize BM25 scores to 0-1 range (divide by max)
  const records = result.records.map((r) => ({
    id: r.get("id") as string,
    text: r.get("text") as string,
    category: r.get("category") as string,
    importance: toJsNumber(r.get("importance")),
    createdAt: String(r.get("createdAt") ?? ""),
    validFrom: r.get("validFrom") != null ? String(r.get("validFrom")) : undefined,
    supersededBy: r.get("supersededBy") != null ? String(r.get("supersededBy")) : null,
    rawScore: r.get("bm25Score") as number,
    trustScore: toJsNumber(r.get("trustScore")) || 1.0,
  }));

  if (records.length === 0) {
    return [];
  }
  // Min-max normalization with a floor: prevents a single weak BM25
  // match from getting score 1.0 and inflating its RRF contribution.
  const maxScore = records[0].rawScore;
  const minScore = records[records.length - 1].rawScore;
  const range = maxScore - minScore;
  return records.map((r) => ({
    ...r,
    score:
      range > 0
        ? BM25_NORMALIZATION_FLOOR +
          ((1 - BM25_NORMALIZATION_FLOOR) * (r.rawScore - minScore)) / range
        : 0.5, // Single result or identical scores → moderate 0.5 to avoid inflating weak matches
  }));
}

/**
 * Signal 4 (optional): Community-aware search.
 * Queries Community nodes by fulltext match on name/summary, then
 * expands to member entities and collects their connected memories.
 */
export async function communitySearch(
  session: Session,
  query: string,
  limit: number,
  agentId?: string,
  includeQuarantined?: boolean,
  includeExpired?: boolean,
  asOf?: string,
): Promise<SearchSignalResult[]> {
  const agentFilter = agentId ? "AND mem.agentId = $agentId" : "";
  const quarantineFilter = includeQuarantined
    ? ""
    : "AND (mem.quarantined IS NULL OR mem.quarantined = false)";
  const { filter: expiredFilter, params: temporalParams } = buildTemporalFilter(
    "mem.",
    includeExpired,
    asOf,
  );
  const escaped = escapeLucene(query);
  if (!escaped.trim()) return [];

  // OP-176: Use EXTRACTED_FROM provenance edge to bridge community member
  // entities back to source Memory nodes (replaces TAGGED tag-bridge path).
  const result = await session.executeRead((tx) =>
    tx.run(
      `CALL db.index.fulltext.queryNodes('community_fulltext_index', $query)
       YIELD node AS community, score AS communityScore
       WITH community, communityScore
       LIMIT 5
       MATCH (entity:Entity)-[:BELONGS_TO]->(community)
       WITH community, communityScore, entity
       LIMIT $entityExpansionLimit
       // H3: Filter short entity names (< 3 chars) to avoid substring false positives
       // (e.g. "AI" matching "SAID", "WAIT").
       WHERE size(entity.name) >= 3
       MATCH (mem:Memory)-[:EXTRACTED_FROM]->(entity)
       WHERE true ${expiredFilter} ${agentFilter} ${quarantineFilter}
       WITH DISTINCT mem, max(communityScore) AS bestCommunityScore
       RETURN mem.id AS id, mem.text AS text, mem.category AS category,
              mem.importance AS importance, mem.createdAt AS createdAt,
              mem.validFrom AS validFrom,
              COALESCE(mem.trustScore, 1.0) AS trustScore,
              bestCommunityScore AS score
       ORDER BY bestCommunityScore DESC
       LIMIT $limit`,
      {
        query: escaped,
        limit: neo4j.int(Math.floor(limit)),
        entityExpansionLimit: neo4j.int(50),
        ...(agentId ? { agentId } : {}),
        ...temporalParams,
      },
    ),
  );

  return result.records.map((r) => ({
    id: r.get("id") as string,
    text: r.get("text") as string,
    category: r.get("category") as string,
    importance: toJsNumber(r.get("importance")),
    createdAt: String(r.get("createdAt") ?? ""),
    validFrom: r.get("validFrom") != null ? String(r.get("validFrom")) : undefined,
    score: r.get("score") as number,
    trustScore: toJsNumber(r.get("trustScore")) || 1.0,
  }));
}

// L6: Properties excluded from synthesized text in entity graph search results.
// These are internal/system fields that don't carry user-facing information.
// Frozen to prevent accidental mutation at runtime.
const INTERNAL_PROPERTY_BLOCKLIST: ReadonlySet<string> = new Set([
  "embedding",
  "updatedAt",
  "createdAt",
  "agentId",
  "id",
  "aliases", // StringArray — toString() fails on arrays
  "reclassificationStatus",
  "reclassificationRetries",
  "reclassifiedFrom",
  "reclassifiedAt",
  // Trust & temporal system fields
  "trustScore",
  "quarantined",
  "validFrom",
  "validUntil",
  "supersededBy",
  // Extraction pipeline fields
  "extractionStatus",
  "extractionRetries",
  "taggingRetries",
  // Memory system fields
  "source",
  "sessionKey",
  "retrievalCount",
  "lastRetrievedAt",
  "originalCreatedAt",
  // Entity lifecycle fields
  "firstSeen",
  "lastSeen",
  "relationshipCount",
]);

/**
 * Entity graph search.
 *
 * Queries all Entity nodes via `entity_fulltext_index` (BM25) and optionally
 * `entity_embedding_index` (vector), enumerates their properties, and synthesizes
 * text results for RRF fusion — independent of Memory nodes.
 *
 * Entity-type agnostic: any Entity node is eligible regardless of its `type` property.
 * New entity types added to the extraction prompt are automatically searchable without
 * code or index changes.
 *
 * Design: schema-agnostic. Properties are discovered at query time via `keys(n)` and
 * filtered through INTERNAL_PROPERTY_BLOCKLIST, so new properties added to any Entity
 * node are automatically included without code changes.
 *
 * Dual-seed strategy (OP-143): seeds are gathered from both fulltext (BM25) and vector
 * similarity to handle queries where the query words don't literally appear in entity
 * names/descriptions. This enables relationship traversal starting from semantically
 * relevant entities even when keyword matching fails (e.g. "wife's older son" → vector
 * matches `renu` → hops `renu → PARENT_OF → kheshav` → returns kheshav.phone).
 *
 * Supports N-hop traversal through any entity-to-entity relationship with confidence
 * decay (0.7 per hop) to surface connected Entity nodes. Hop depth is dynamic —
 * traversal continues up to maxHops but results are filtered by a decay threshold
 * (hopDecayThreshold). This allows deep traversal when the graph path is strong
 * while naturally pruning weak multi-hop connections.
 *
 * Relationship-type agnostic — traverses all relationship types between Entity nodes.
 *
 * agentFilter: uses Memory-reference scoping only as a fallback when no embedding is
 * provided. When embedding is provided, the vector seed itself provides implicit agent
 * scoping (entities are seeded from what the agent knows). The Memory-reference filter
 * is intentionally NOT applied — it would exclude entities whose structured properties
 * were set directly (not via Memory text), breaking entity-first retrieval.
 */
export async function structuredGraphSearch(
  session: Session,
  query: string,
  limit: number,
  maxHops: number = 2,
  seedCap: number = 5,
  agentId?: string,
  hopDecayThreshold: number = 0.15,
  embedding?: number[],
  includeExpired?: boolean,
  createSession?: () => Session,
): Promise<SearchSignalResult[]> {
  // Dynamic hop depth: traverse up to maxHops, filtered by decay threshold.
  // SAFETY: maxHops capped at 3 to prevent combinatorial explosion. The
  // variable-length path pattern traverses through ALL nodes (not just Entity),
  // so high hop counts create massive intermediate result sets.
  // M25: Reduced cap from 4 to 3 — depth-4 caused 1.6M path explosion on hub
  // nodes (e.g. 102-degree "tarun"), timing out at 5s with ~9M db hits. Depth 2
  // covers 63/85 unique neighbors in 24ms; depth 3 is the safe upper bound.
  const clampedHops = Math.max(1, Math.min(3, maxHops));
  const hopRange = `1..${clampedHops}`;

  // Dual-seed strategy (OP-143):
  // Run fulltext + vector seed queries in PARALLEL, then union the seed element IDs.
  // The main traversal query then uses these IDs to load seeds via elementId() lookup.
  //
  // Vector seed uses a smaller cap (max 3) to limit traversal fanout — the fulltext
  // seed is the primary signal, vector is supplementary for semantic coverage when
  // keyword matching fails (e.g. "wife's older son" → vector matches related entities).
  //
  // OP-142: Agent scoping uses Entity.agentId property (not MENTIONS traversal).
  const agentFilterFulltext = agentId ? "AND node.agentId = $agentId" : "";

  const VECTOR_SEED_CAP = Math.min(3, seedCap); // Smaller cap for vector seeds to limit fanout
  // M6: Escape Lucene special characters in the graph search query to prevent
  // query syntax errors from user input containing +, -, *, etc.
  const escapedGraphQuery = escapeLucene(query);
  if (!escapedGraphQuery.trim()) return [];

  // Run fulltext + vector seed queries in PARALLEL when a session factory is
  // available and we have an embedding. Each query gets its own session because
  // the Neo4j driver does not support concurrent operations on a single session.
  const fulltextSeedQuery = (s: Session) =>
    s.executeRead((tx) =>
      tx.run(
        `CALL db.index.fulltext.queryNodes('entity_fulltext_index', $query)
         YIELD node, score
         WHERE score >= 0.5 ${agentFilterFulltext}
         RETURN elementId(node) AS eid, score
         ORDER BY score DESC
         LIMIT $seedCap`,
        {
          query: escapedGraphQuery,
          seedCap: neo4j.int(Math.max(1, Math.floor(seedCap))),
          ...(agentId ? { agentId } : {}),
        },
      ),
    );

  const vectorSeedQuery = (s: Session) =>
    s.executeRead((tx) =>
      tx.run(
        `CALL db.index.vector.queryNodes('entity_embedding_index', $seedCap, $embedding)
         YIELD node, score
         WHERE score >= 0.4
         RETURN elementId(node) AS eid, score`,
        {
          seedCap: neo4j.int(Math.max(1, VECTOR_SEED_CAP)),
          embedding: embedding!,
        },
      ),
    );

  let fulltextSeedResult: neo4j.QueryResult;
  let vectorSeedResult: neo4j.QueryResult | null = null;

  const wantVector = embedding && embedding.length > 0;
  if (wantVector && createSession) {
    // Parallel: use separate sessions for each seed query
    const ftSession = createSession();
    const vecSession = createSession();
    try {
      const [ftResult, vecResult] = await Promise.all([
        fulltextSeedQuery(ftSession),
        vectorSeedQuery(vecSession).catch(() => null), // graceful degradation
      ]);
      fulltextSeedResult = ftResult;
      vectorSeedResult = vecResult;
    } finally {
      await Promise.all([ftSession.close(), vecSession.close()]);
    }
  } else {
    // Sequential: reuse the caller-provided session
    fulltextSeedResult = await fulltextSeedQuery(session);
    if (wantVector) {
      try {
        vectorSeedResult = await vectorSeedQuery(session);
      } catch {
        // entity_embedding_index may not exist — graceful degradation
      }
    }
  }

  // Map of elementId → seed score from fulltext
  const seedScores = new Map<string, number>();
  for (const r of fulltextSeedResult.records) {
    const eid = r.get("eid") as string;
    const score = r.get("score") as number;
    if (!seedScores.has(eid) || score > seedScores.get(eid)!) {
      seedScores.set(eid, score);
    }
  }

  // Merge vector seed results
  if (vectorSeedResult) {
    for (const r of vectorSeedResult.records) {
      const eid = r.get("eid") as string;
      const score = r.get("score") as number;
      // Take the higher score if already present from fulltext
      if (!seedScores.has(eid) || score > seedScores.get(eid)!) {
        seedScores.set(eid, score);
      }
    }
  }

  // No seeds found from either signal — return empty
  if (seedScores.size === 0) {
    return [];
  }

  // Sort seeds by score descending and cap to seedCap
  const sortedSeeds = [...seedScores.entries()].sort((a, b) => b[1] - a[1]).slice(0, seedCap);
  const seedElementIds = sortedSeeds.map(([eid]) => eid);
  const seedScoreMap = new Map(sortedSeeds);

  // Relationship validity filter for N-hop traversal (OP-122).
  // When includeExpired=false, only traverse active relationships (validUntil IS NULL or in future).
  // When includeExpired=true, traverse all relationships regardless of validity.
  const relValidityFilter = !includeExpired
    ? "AND none(r IN rels WHERE r.validUntil IS NOT NULL AND r.validUntil < $now)"
    : "";
  const now = !includeExpired ? new Date().toISOString() : undefined;

  // OP-179: Memory-level filters for the EXTRACTED_FROM bridge step.
  // These mirror communitySearch's filters so resolved Memory nodes respect
  // agentId scoping, quarantine state, and temporal validity.
  const memAgentFilter = agentId ? "AND m.agentId = $agentId" : "";
  const memQuarantineFilter = "AND (m.quarantined IS NULL OR m.quarantined = false)";
  const { filter: memExpiredFilter, params: memTemporalParams } = buildTemporalFilter(
    "m.",
    includeExpired,
  );

  const result = await session.executeRead(
    (tx) =>
      tx.run(
        `// Load seed Entity nodes by element IDs gathered from fulltext + vector seeds
     UNWIND $seedElementIds AS seedEid
     MATCH (node:Entity)
     WHERE elementId(node) = seedEid
     WITH node, $seedScoreMap[seedEid] AS score
     LIMIT $seedCap

     // Collect seed node properties; use type property as the category label
     WITH node, score,
          coalesce(node.type, 'entity') AS typeLabel,
          [k IN keys(node) WHERE NOT k IN $blocklist] AS propKeys
     WITH node, score, typeLabel, propKeys,
          [k IN propKeys WHERE NOT valueType(node[k]) STARTS WITH 'LIST' | k + ': ' + coalesce(toString(node[k]), '')] AS propPairs

     // Build synthesized text for seed node: "{type} {name} — key1: value1, ..."
     WITH node, score, typeLabel,
          coalesce(node.name, '') AS nodeName,
          propPairs
     WITH node, score, typeLabel, nodeName,
          typeLabel + ' ' + nodeName +
          CASE WHEN size(propPairs) > 0 THEN ' — ' + reduce(s = '', p IN propPairs | CASE WHEN s = '' THEN p ELSE s + ', ' + p END) ELSE '' END
          AS synthesized,
          coalesce(node.createdAt, '') AS createdAt,
          elementId(node) AS nodeElementId

     // Return seed result
     WITH node, collect({
       id: nodeElementId,
       text: synthesized,
       category: typeLabel,
       createdAt: createdAt,
       score: score
     }) AS seedResults

     // N-hop traversal to connected Entity nodes. Filter out TAGGED/DERIVED_FROM
     // relationships which connect to Tag nodes — traversing those causes fanout.
     // OP-142: MENTIONS no longer created, but kept in filter for legacy graph compat.
     // OP-122: when includeExpired=false, skip expired relationships (validUntil in the past).
     OPTIONAL MATCH (node)-[rels*${hopRange}]-(neighbor:Entity)
     WHERE neighbor <> node
       AND neighbor.agentId = node.agentId
       AND none(r IN rels WHERE type(r) IN ['MENTIONS', 'TAGGED', 'DERIVED_FROM', 'EXTRACTED_FROM', 'SIMILAR', 'TEMPORAL_NEXT'])
       ${relValidityFilter}
     WITH seedResults, neighbor, rels
     WHERE neighbor IS NOT NULL
     // M25: Cap neighbor rows to prevent property-expansion blow-up on high-degree hubs.
     // 50 paths is generous — after dedup + decay filtering, effective neighbor count is lower.
     WITH seedResults, neighbor, rels
     LIMIT 50

     // Build synthesized text for neighbor
     WITH seedResults, neighbor, rels,
          coalesce(neighbor.type, 'entity') AS nTypeLabel,
          [k IN keys(neighbor) WHERE NOT k IN $blocklist] AS nPropKeys
     WITH seedResults, neighbor, rels, nTypeLabel, nPropKeys,
          [k IN nPropKeys WHERE NOT valueType(neighbor[k]) STARTS WITH 'LIST' | k + ': ' + coalesce(toString(neighbor[k]), '')] AS nPropPairs
     WITH seedResults,
          elementId(neighbor) AS nId,
          nTypeLabel + ' ' + coalesce(neighbor.name, '') +
          CASE WHEN size(nPropPairs) > 0 THEN ' — ' + reduce(s = '', p IN nPropPairs | CASE WHEN s = '' THEN p ELSE s + ', ' + p END) ELSE '' END
          AS nSynthesized,
          nTypeLabel,
          coalesce(neighbor.createdAt, '') AS nCreatedAt,
          // Confidence decay: 0.7 per hop — filtered by threshold to prune weak connections
          reduce(s = 1.0, r IN rels | s * 0.7) AS hopScore
     WHERE hopScore >= $hopDecayThreshold

     WITH seedResults, collect({
       id: nId,
       text: nSynthesized,
       category: nTypeLabel,
       createdAt: nCreatedAt,
       score: hopScore
     }) AS hopResults

     // OP-179: Combine seed + hop Entity results, then resolve to source
     // Memories via EXTRACTED_FROM provenance edges. Entities without the
     // edge (legacy / not yet linked) fall back to synthesized entity text.
     UNWIND (seedResults + hopResults) AS row
     WITH row WHERE row.id IS NOT NULL
     WITH row.id AS entityEid, row.text AS entityText, row.category AS entityCategory,
          row.createdAt AS entityCreatedAt, max(row.score) AS entityScore

     MATCH (e:Entity) WHERE elementId(e) = entityEid
     OPTIONAL MATCH (m:Memory)-[:EXTRACTED_FROM]->(e)
       WHERE true ${memExpiredFilter} ${memAgentFilter} ${memQuarantineFilter}

     // Collect resolved Memory nodes per entity. When none exist (legacy
     // entities without provenance links), fall back to synthesized text.
     WITH entityEid, entityText, entityCategory, entityCreatedAt, entityScore,
          collect(m) AS memories

     WITH entityEid, entityText, entityCategory, entityCreatedAt, entityScore,
          CASE WHEN size(memories) > 0 THEN memories ELSE [null] END AS mems
     UNWIND mems AS mem

     RETURN
       coalesce(mem.id, entityEid) AS id,
       coalesce(mem.text, entityText) AS text,
       coalesce(mem.category, entityCategory) AS category,
       coalesce(mem.createdAt, entityCreatedAt) AS createdAt,
       max(entityScore) AS graphScore,
       mem.validFrom AS validFrom,
       coalesce(mem.importance, 0.5) AS importance,
       coalesce(mem.trustScore, 1.0) AS trustScore,
       mem.embedding AS memoryEmbedding`,
        {
          seedElementIds,
          seedScoreMap: Object.fromEntries(seedScoreMap),
          seedCap: neo4j.int(Math.max(1, Math.floor(seedCap))),
          blocklist: [...INTERNAL_PROPERTY_BLOCKLIST],
          hopDecayThreshold,
          ...(now ? { now } : {}),
          ...(agentId ? { agentId } : {}),
          ...memTemporalParams,
        },
      ),
    { timeout: GRAPH_TRAVERSAL_TIMEOUT_MS },
  );

  // OP-150: Re-score graph results by combining traversal confidence with
  // semantic similarity to the query. Without this, all neighbors at the same
  // hop distance get identical scores (e.g. 0.7), making ranking arbitrary.
  // cosine(queryEmbedding, memoryEmbedding) breaks the tie so that memories
  // semantically relevant to the query rank above hub-node noise.
  const byId = new Map<string, SearchSignalResult>();
  for (const record of result.records) {
    const id = record.get("id") as string;
    if (!id) continue;
    const traversalScore = record.get("graphScore") as number;
    const memoryEmbedding = record.get("memoryEmbedding") as number[] | null;

    // Combine traversal confidence with semantic similarity when both the
    // query embedding and memory embedding are available.
    let score = traversalScore;
    if (
      embedding &&
      embedding.length > 0 &&
      memoryEmbedding &&
      memoryEmbedding.length === embedding.length
    ) {
      const similarity = cosineSimilarity(embedding, memoryEmbedding);
      // Geometric mean of traversal confidence and semantic similarity.
      // This preserves hop-decay ordering while adding semantic discrimination.
      // Floor similarity at 0.01 to avoid zeroing out graph-only results.
      score = traversalScore * Math.max(0.01, similarity);
    }

    const existing = byId.get(id);
    if (!existing || score > existing.score) {
      byId.set(id, {
        id,
        text: record.get("text") as string,
        category: record.get("category") as string,
        importance: toJsNumber(record.get("importance")) || 0.8,
        createdAt: String(record.get("createdAt") ?? ""),
        validFrom: record.get("validFrom") != null ? String(record.get("validFrom")) : undefined,
        score,
        trustScore: toJsNumber(record.get("trustScore")) || 1.0,
      });
    }
  }

  return Array.from(byId.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// Default causal relationship types for directed chain traversal.
// Configurable via graphCausalRelTypes config key.
export const DEFAULT_CAUSAL_RELATIONSHIP_TYPES = [
  "CAUSED_BY",
  "LED_TO",
  "RESULTED_IN",
  "ENABLED_BY",
  "PREVENTED_BY",
];

/** Build the Cypher relationship pattern from a list of causal types. Returns null if no valid types. */
function buildCausalRelPattern(types: string[]): string | null {
  const safe = types.map((t) => sanitizeRelationshipType(t)).filter((t): t is string => t !== null);
  // M19: Return null instead of throwing — callers return empty results for graceful degradation
  if (safe.length === 0) return null;
  return safe.join("|");
}

/**
 * Directed causal chain search.
 *
 * Finds seed entities via fulltext, then traverses specifically along causal
 * relationship types (CAUSED_BY, LED_TO, etc.) in both directions to build
 * upstream cause chains and downstream effect chains.
 *
 * Synthesizes chain-aware text showing the causal path:
 *   "decision neo4j migration --CAUSED_BY--> limitation postgresql graph queries"
 */
export async function causalChainSearch(
  session: Session,
  query: string,
  limit: number,
  seedCap: number = 5,
  agentId?: string,
  maxHops: number = 2,
  causalRelTypes?: string[],
  hopDecayThreshold: number = 0.15,
  includeExpired?: boolean,
): Promise<SearchSignalResult[]> {
  // Escape Lucene special characters — defense-in-depth so this function is safe when called directly
  query = escapeLucene(query);
  const types = causalRelTypes ?? DEFAULT_CAUSAL_RELATIONSHIP_TYPES;
  const CAUSAL_REL_PATTERN = buildCausalRelPattern(types);
  // M19: Graceful degradation when all causal types are invalid
  if (!CAUSAL_REL_PATTERN) return [];
  // OP-142: Agent scoping uses Entity.agentId property (not MENTIONS traversal)
  const agentFilter = agentId ? "AND node.agentId = $agentId" : "";
  // SAFETY: Cap maxHops at 3, consistent with structuredGraphSearch (M25).
  const clampedHops = Math.max(1, Math.min(3, maxHops));
  const hopRange = `1..${clampedHops}`;

  // M20: Relationship validity filter for causal chain traversal (consistent with structuredGraphSearch)
  const relValidityFilterCause = !includeExpired
    ? "AND none(r IN relationships(causePath) WHERE r.validUntil IS NOT NULL AND r.validUntil < $now)"
    : "";
  const relValidityFilterEffect = !includeExpired
    ? "AND none(r IN relationships(effectPath) WHERE r.validUntil IS NOT NULL AND r.validUntil < $now)"
    : "";
  const nowParam = !includeExpired ? new Date().toISOString() : undefined;

  const result = await session.executeRead(
    (tx) =>
      tx.run(
        `// Find seed entities via fulltext
     CALL db.index.fulltext.queryNodes('entity_fulltext_index', $query)
     YIELD node, score
     WHERE score >= 0.5 ${agentFilter}
     WITH node, score
     ORDER BY score DESC
     LIMIT $seedCap

     // Build seed text
     WITH node, score,
          coalesce(node.type, 'entity') AS typeLabel,
          coalesce(node.name, '') AS nodeName,
          [k IN keys(node) WHERE NOT k IN $blocklist AND NOT valueType(node[k]) STARTS WITH 'LIST' | k + ': ' + coalesce(toString(node[k]), '')] AS propPairs
     WITH node, score, typeLabel, nodeName,
          typeLabel + ' ' + nodeName +
          CASE WHEN size(propPairs) > 0 THEN ' — ' + reduce(s = '', p IN propPairs | CASE WHEN s = '' THEN p ELSE s + ', ' + p END) ELSE '' END
          AS seedText,
          elementId(node) AS seedId

     // Collect seed results
     WITH node, collect({
       id: seedId, text: seedText, category: typeLabel, score: score, createdAt: coalesce(node.createdAt, '')
     }) AS seedResults

     // Traverse upstream causes (follow incoming causal edges)
     OPTIONAL MATCH causePath = (node)<-[:${CAUSAL_REL_PATTERN}*${hopRange}]-(cause:Entity)
     WHERE cause <> node
       ${relValidityFilterCause}
     WITH seedResults, node, cause, causePath,
          CASE WHEN cause IS NOT NULL THEN
            reduce(s = '', r IN relationships(causePath) |
              s + CASE WHEN s = '' THEN '' ELSE ' ' END +
              coalesce(startNode(r).name, '?') + ' --' + type(r) + '--> ' + coalesce(endNode(r).name, '?')
            )
          ELSE null END AS causeChainText,
          CASE WHEN cause IS NOT NULL THEN reduce(s = 1.0, r IN relationships(causePath) | s * 0.7) ELSE 0 END AS causeScore
     WHERE causeScore >= $hopDecayThreshold

     WITH seedResults, node, collect(
       CASE WHEN cause IS NOT NULL THEN {
         id: elementId(cause),
         text: 'causal chain: ' + causeChainText,
         category: 'cause',
         score: causeScore,
         createdAt: ''
       } ELSE null END
     ) AS causeResults

     // Traverse downstream effects (follow outgoing causal edges)
     OPTIONAL MATCH effectPath = (node)-[:${CAUSAL_REL_PATTERN}*${hopRange}]->(effect:Entity)
     WHERE effect <> node
       ${relValidityFilterEffect}
     WITH seedResults, causeResults, effect, effectPath,
          CASE WHEN effect IS NOT NULL THEN
            reduce(s = '', r IN relationships(effectPath) |
              s + CASE WHEN s = '' THEN '' ELSE ' ' END +
              coalesce(startNode(r).name, '?') + ' --' + type(r) + '--> ' + coalesce(endNode(r).name, '?')
            )
          ELSE null END AS effectChainText,
          CASE WHEN effect IS NOT NULL THEN reduce(s = 1.0, r IN relationships(effectPath) | s * 0.7) ELSE 0 END AS effectScore
     WHERE effectScore >= $hopDecayThreshold

     WITH seedResults, causeResults, collect(
       CASE WHEN effect IS NOT NULL THEN {
         id: elementId(effect),
         text: 'causal chain: ' + effectChainText,
         category: 'effect',
         score: effectScore,
         createdAt: ''
       } ELSE null END
     ) AS effectResults

     // Combine all results
     WITH [r IN (seedResults + causeResults + effectResults) WHERE r IS NOT NULL] AS allResults
     UNWIND allResults AS row
     RETURN row.id AS id, row.text AS text, row.category AS category,
            row.createdAt AS createdAt, max(row.score) AS graphScore`,
        {
          query,
          seedCap: neo4j.int(Math.max(1, Math.floor(seedCap))),
          blocklist: [...INTERNAL_PROPERTY_BLOCKLIST],
          hopDecayThreshold,
          ...(agentId ? { agentId } : {}),
          ...(nowParam ? { now: nowParam } : {}),
        },
      ),
    { timeout: GRAPH_TRAVERSAL_TIMEOUT_MS },
  );

  const byId = new Map<string, SearchSignalResult>();
  for (const record of result.records) {
    const id = record.get("id") as string;
    if (!id) continue;
    const score = record.get("graphScore") as number;
    const existing = byId.get(id);
    if (!existing || score > existing.score) {
      byId.set(id, {
        id,
        text: record.get("text") as string,
        category: record.get("category") as string,
        importance: 0.8,
        createdAt: String(record.get("createdAt") ?? ""),
        score,
      });
    }
  }

  return Array.from(byId.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Signal 3: Graph traversal search.
 *
 * Dispatches to either general entity graph search or directed causal chain
 * search based on queryType. Both are entity-type and relationship-type agnostic.
 *
 * The three RRF signals are cleanly separated:
 *   Signal 1 (vector)  → Memory nodes
 *   Signal 2 (BM25)    → Memory nodes
 *   Signal 3 (graph)   → Entity nodes (this function)
 */
export async function graphSearch(
  session: Session,
  query: string,
  limit: number,
  _firingThreshold: number = 0.3,
  agentId?: string,
  maxHops: number = 2,
  includeExpired?: boolean,
  _asOf?: string,
  seedCap: number = 5,
  _relTypes?: string[] | null,
  hopDecayThreshold: number = 0.15,
  queryType?: string,
  embedding?: number[],
  causalRelTypes?: string[],
  createSession?: () => Session,
): Promise<SearchSignalResult[]> {
  // L1-L3: _firingThreshold, _asOf, _relTypes: kept for Neo4jMemoryClient interface compat;
  // not forwarded to structuredGraphSearch/causalChainSearch.
  if (queryType === "causal") {
    return causalChainSearch(
      session,
      query,
      limit,
      seedCap,
      agentId,
      Math.min(maxHops, 4),
      causalRelTypes,
      hopDecayThreshold,
      includeExpired,
    );
  }
  return structuredGraphSearch(
    session,
    query,
    limit,
    maxHops,
    seedCap,
    agentId,
    hopDecayThreshold,
    embedding,
    includeExpired,
    createSession,
  );
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
  // HNSW indexes don't support pre-filtering; over-fetch and post-filter by agentId.
  // Use 5x multiplier (up from 3x) to reduce empty results in multi-agent deployments
  // where one agent may own a small share of total memories.
  const cappedLimit = Math.min(limit, 200);
  const fetchLimit = agentId ? Math.min(cappedLimit * 5, 200) : cappedLimit;
  const agentFilter = agentId ? "AND node.agentId = $agentId" : "";
  const result = await session.executeRead((tx) =>
    tx.run(
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
    ),
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
 * Increments retrievalCount by the actual frequency count and updates lastRetrievedAt.
 *
 * OP-136: Accepts [id, count] entries so that a memory retrieved N times in one
 * flush window gets retrievalCount += N (not a hard +1), preserving the
 * reinforcement-learning-from-retrieval signal used by the decay formula.
 */
export async function recordRetrievals(
  session: Session,
  entries: Array<[string, number]>,
  logger?: Logger,
): Promise<void> {
  if (entries.length === 0) return;
  // M11: Warn on unusually large counts (from buffer accumulation during outage)
  for (const [id, cnt] of entries) {
    if (cnt > 100) {
      logger?.warn?.(
        `memory-neo4j: recordRetrievals: unusually high count ${cnt} for memory ${id.slice(0, 8)} (may indicate buffer accumulation)`,
      );
    }
  }
  await session.executeWrite((tx) =>
    tx.run(
      `UNWIND $entries AS entry
       WITH entry[0] AS memId, entry[1] AS cnt
       MATCH (m:Memory {id: memId})
       SET m.retrievalCount = coalesce(m.retrievalCount, 0) + cnt,
           m.lastRetrievedAt = $now,
           m.importance = least(1.0, coalesce(m.importance, 0.5) + 0.02 * log(cnt + 1))`,
      { entries, now: new Date().toISOString() },
    ),
  );
}

/**
 * Episode metadata for a memory node (OP-178).
 * Populated by following EPISODE_SOURCE edges from Memory to Episode.
 */
export type EpisodeMetadata = {
  memoryId: string;
  episodeId: string;
  episodeDate: string;
  episodeSessionKey: string;
};

/**
 * Enrich memory IDs with episode metadata via EPISODE_SOURCE relationships.
 * Returns episode metadata only for memories that have linked episodes.
 * Memories without episodes are silently skipped (OPTIONAL MATCH).
 */
export async function episodeEnrich(
  session: Session,
  memoryIds: string[],
): Promise<EpisodeMetadata[]> {
  if (memoryIds.length === 0) return [];

  const result = await session.executeRead((tx) =>
    tx.run(
      `UNWIND $memoryIds AS memId
       MATCH (m:Memory {id: memId})
       OPTIONAL MATCH (m)-[:EPISODE_SOURCE]->(ep:Episode)
       WITH m.id AS memoryId, ep
       WHERE ep IS NOT NULL
       RETURN memoryId,
              ep.id AS episodeId,
              ep.timestamp AS episodeDate,
              ep.sessionKey AS episodeSessionKey
       ORDER BY ep.timestamp DESC`,
      { memoryIds },
    ),
  );

  return result.records.map((r) => ({
    memoryId: r.get("memoryId") as string,
    episodeId: r.get("episodeId") as string,
    episodeDate: String(r.get("episodeDate") ?? ""),
    episodeSessionKey: r.get("episodeSessionKey") as string,
  }));
}

/** Escape a query string for Lucene before passing to bm25Search. */
export { escapeLucene };
