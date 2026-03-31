/**
 * MPFP-style meta-path forward push traversal for graph search (OP-181).
 *
 * Uses meta-path patterns (sequences of edge types) to traverse the memory graph
 * starting from seed nodes (vector/BM25 hits). Each pattern encodes a specific
 * reasoning strategy:
 *
 * Semantic patterns:
 *   SIMILAR → SIMILAR           — topic expansion (find memories in the same cluster)
 *   EXTRACTED_FROM → TEMPORAL_NEXT — entity timeline (what happened next with this entity?)
 *   SIMILAR → EXTRACTED_FROM    — reasoning chains (similar memory → its entities)
 *   EXTRACTED_FROM → SIMILAR    — entity context (entity → similar memories)
 *
 * Temporal patterns:
 *   TEMPORAL_NEXT → SIMILAR     — what was happening then (next memory → similar ones)
 *   TEMPORAL_NEXT → EXTRACTED_FROM — who was involved then (next memory → its entities)
 *
 * Adapted from Hindsight MPFP defaults: alpha=0.15 decay, top_k=20 fan-out, threshold=1e-6.
 */

import type { Session } from "neo4j-driver";
import type { Logger, SearchSignalResult, SignalProvenance, TraversalHop } from "./schema.js";

// ── Meta-path pattern definitions ───────────────────────────────────────────

export type EdgeType = "SIMILAR" | "TEMPORAL_NEXT" | "EXTRACTED_FROM" | "CAUSED_BY";
export type MetaPathPattern = EdgeType[];
export type MpfpMode = "semantic" | "temporal" | "causal" | "both";

const PATTERNS_SEMANTIC: MetaPathPattern[] = [
  ["SIMILAR", "SIMILAR"], // topic expansion
  ["EXTRACTED_FROM", "TEMPORAL_NEXT"], // entity timeline
  ["SIMILAR", "EXTRACTED_FROM"], // reasoning chains
  ["EXTRACTED_FROM", "SIMILAR"], // entity context
];

const PATTERNS_TEMPORAL: MetaPathPattern[] = [
  ["TEMPORAL_NEXT", "SIMILAR"], // what was happening then
  ["TEMPORAL_NEXT", "EXTRACTED_FROM"], // who was involved then
];

/** Causal chain patterns (OP-188): traverse CAUSED_BY edges for "why" queries. */
const PATTERNS_CAUSAL: MetaPathPattern[] = [
  ["CAUSED_BY", "CAUSED_BY"], // causal chain expansion
  ["CAUSED_BY", "SIMILAR"], // what was similar to the cause
  ["CAUSED_BY", "EXTRACTED_FROM"], // who was involved in the cause
];

// ── Hindsight-inspired parameters ───────────────────────────────────────────

/** Probability mass decay per hop. Each hop multiplies the running score by (1 - alpha). */
const DEFAULT_ALPHA = 0.15;
/** Maximum neighbors to expand per hop (fan-out limit). */
const DEFAULT_TOP_K_NEIGHBORS = 20;
/** Minimum probability mass to keep propagating (pruning threshold). */
const DEFAULT_THRESHOLD = 1e-6;

export type MpfpOptions = {
  alpha?: number;
  topKNeighbors?: number;
  threshold?: number;
  logger?: Logger;
  /** OP-200: Enable retrieval provenance tracking on results. */
  provenanceEnabled?: boolean;
};

// ── Core traversal ──────────────────────────────────────────────────────────

type TraversalHit = {
  nodeId: string;
  score: number;
  /** Label of the final node (Memory or Entity). */
  label: "Memory" | "Entity";
  /** OP-200: Provenance — the meta-path pattern that found this hit. */
  pattern?: MetaPathPattern;
  /** OP-200: Provenance — seed Memory ID that started the traversal. */
  seedId?: string;
  /** OP-200: Provenance — intermediate hop node IDs/labels/names (max 3). */
  hops?: TraversalHop[];
};

/**
 * Run a single meta-path pattern from a set of seed Memory node IDs.
 *
 * Generates a Cypher query that follows the edge sequence, applying
 * fan-out limits and decay at each hop. Returns scored node IDs.
 */
async function traversePattern(
  session: Session,
  agentId: string,
  seedNodeIds: string[],
  pattern: MetaPathPattern,
  options: Required<Pick<MpfpOptions, "alpha" | "topKNeighbors" | "threshold">>,
  provenanceEnabled = false,
): Promise<TraversalHit[]> {
  if (seedNodeIds.length === 0 || pattern.length === 0) return [];

  // Build the Cypher traversal dynamically based on pattern length.
  // Each hop follows a specific edge type with fan-out limiting.
  //
  // Strategy: expand hop-by-hop, collecting scored intermediate results.
  // At each hop we ORDER BY edge weight DESC and LIMIT to topKNeighbors.
  const decay = 1 - options.alpha;

  // Build variable-length path match based on pattern
  // For a pattern like [SIMILAR, EXTRACTED_FROM]:
  //   MATCH (seed:Memory {agentId: $agentId})-[r1:SIMILAR]->(h1)-[r2:EXTRACTED_FROM]->(h2)
  //   WHERE seed.id IN $seedIds
  //   WITH h2, seed, r1, r2, (1-alpha)^2 * COALESCE(r1.weight, 1.0) * COALESCE(r2.weight, 1.0) AS score
  //   ORDER BY score DESC LIMIT topK
  const hopAliases: string[] = [];
  const relAliases: string[] = [];
  const matchParts: string[] = [];

  for (let i = 0; i < pattern.length; i++) {
    const relAlias = `r${i + 1}`;
    const hopAlias = `h${i + 1}`;
    relAliases.push(relAlias);
    hopAliases.push(hopAlias);

    const edgeType = pattern[i];
    // EXTRACTED_FROM goes Memory→Entity, so when traversing from Memory
    // we follow the direction. For reverse traversal (Entity→Memory), use <-
    // SIMILAR is bidirectional, TEMPORAL_NEXT is Memory→Memory directed.
    // Use undirected matching for flexibility — the WHERE clause ensures agentId.
    matchParts.push(`-[${relAlias}:${edgeType}]-(${hopAlias})`);
  }

  const finalNode = hopAliases[hopAliases.length - 1];

  // Score = decay^hops × product of edge weights
  const weightProduct = relAliases.map((r) => `COALESCE(${r}.weight, 1.0)`).join(" * ");
  const decayFactor = Math.pow(decay, pattern.length);

  // Determine expected final node label based on last edge type
  // EXTRACTED_FROM: if previous node is Memory, final is Entity (or vice versa)
  // SIMILAR: final is Memory (Memory-Memory edges)
  // TEMPORAL_NEXT: final is Memory (Memory-Memory edges)
  const lastEdge = pattern[pattern.length - 1];
  const finalIsEntity = lastEdge === "EXTRACTED_FROM";

  // OP-200: When provenance is enabled, also return seed.id and intermediate hop info.
  const hopReturnCols = provenanceEnabled
    ? `, seed.id AS seedId` +
      hopAliases
        .slice(0, -1) // Intermediate hops only (exclude final node which is the result)
        .map(
          (h, i) =>
            `, ${h}.id AS hop${i}Id` +
            `, CASE WHEN 'Entity' IN labels(${h}) THEN ${h}.name ELSE left(${h}.text, 60) END AS hop${i}Name` +
            `, CASE WHEN 'Entity' IN labels(${h}) THEN 'Entity' ELSE 'Memory' END AS hop${i}Label`,
        )
        .join("")
    : "";

  const cypher = `
    MATCH (seed:Memory)${matchParts.join("")}
    WHERE seed.id IN $seedIds
      AND seed.agentId = $agentId
      AND ${finalNode} <> seed
      AND ${finalNode}.agentId = $agentId
    WITH DISTINCT ${finalNode},
         ${decayFactor} * ${weightProduct} AS score,
         labels(${finalNode}) AS nodeLabels
         ${
           provenanceEnabled
             ? `, seed` +
               hopAliases
                 .slice(0, -1)
                 .map((h) => `, ${h}`)
                 .join("")
             : ""
         }
    ORDER BY score DESC
    LIMIT $topK
    WHERE score >= $threshold
    RETURN ${finalNode}.id AS nodeId, score,
           CASE WHEN 'Entity' IN nodeLabels THEN 'Entity' ELSE 'Memory' END AS label
           ${hopReturnCols}
  `;

  const result = await session.executeRead((tx) =>
    tx.run(cypher, {
      seedIds: seedNodeIds,
      agentId,
      topK: options.topKNeighbors,
      threshold: options.threshold,
    }),
  );

  return result.records.map((r) => {
    const hit: TraversalHit = {
      nodeId: r.get("nodeId") as string,
      score: r.get("score") as number,
      label: r.get("label") as "Memory" | "Entity",
    };
    if (provenanceEnabled) {
      hit.pattern = pattern;
      hit.seedId = r.get("seedId") as string;
      // Build intermediate hops (all hops except the final node)
      const intermediateCount = hopAliases.length - 1;
      if (intermediateCount > 0) {
        hit.hops = [];
        for (let i = 0; i < intermediateCount; i++) {
          const hopId = r.get(`hop${i}Id`);
          if (hopId) {
            hit.hops.push({
              nodeId: hopId as string,
              nodeLabel: r.get(`hop${i}Label`) as "Memory" | "Entity",
              displayName: (r.get(`hop${i}Name`) as string) ?? undefined,
              edgeType: pattern[i],
            });
          }
        }
      }
    }
    return hit;
  });
}

/**
 * Bridge Entity node IDs back to Memory nodes via EXTRACTED_FROM edges.
 * Returns Memory-level SearchSignalResults with the entity's traversal score.
 */
async function bridgeEntitiesToMemories(
  session: Session,
  agentId: string,
  entityHits: TraversalHit[],
): Promise<SearchSignalResult[]> {
  if (entityHits.length === 0) return [];

  const entityIds = entityHits.map((h) => h.nodeId);
  const scoreByEntity = new Map(entityHits.map((h) => [h.nodeId, h.score]));

  const result = await session.executeRead((tx) =>
    tx.run(
      `MATCH (m:Memory)<-[:EXTRACTED_FROM]-(e:Entity)
       WHERE e.id IN $entityIds
         AND e.agentId = $agentId
         AND m.agentId = $agentId
         AND m.validUntil IS NULL
       RETURN DISTINCT m.id AS id, m.text AS text, m.category AS category,
              m.importance AS importance, m.createdAt AS createdAt,
              m.validFrom AS validFrom,
              COALESCE(m.trustScore, 1.0) AS trustScore,
              e.id AS entityId`,
      { entityIds, agentId },
    ),
  );

  return result.records.map((r) => {
    const entityId = r.get("entityId") as string;
    const entityScore = scoreByEntity.get(entityId) ?? 0;
    return {
      id: r.get("id") as string,
      text: r.get("text") as string,
      category: r.get("category") as string,
      importance: r.get("importance") as number,
      createdAt: String(r.get("createdAt") ?? ""),
      validFrom: r.get("validFrom") != null ? String(r.get("validFrom")) : undefined,
      score: entityScore,
      trustScore: (r.get("trustScore") as number) || 1.0,
    };
  });
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * MPFP meta-path forward push search.
 *
 * Takes seed Memory node IDs (from vector/BM25 hits), traverses multiple
 * meta-path patterns in parallel, bridges Entity results back to Memories,
 * and returns deduplicated scored results.
 *
 * @param session Neo4j session
 * @param agentId Agent scope
 * @param seedNodeIds Memory node IDs from primary search signals
 * @param mode Which pattern set to use: 'semantic', 'temporal', or 'both'
 * @param options Traversal parameters (alpha, topKNeighbors, threshold)
 * @returns Scored Memory node results suitable for RRF fusion
 */
export async function mpfpSearch(
  session: Session,
  agentId: string,
  seedNodeIds: string[],
  mode: MpfpMode = "both",
  options: MpfpOptions = {},
): Promise<SearchSignalResult[]> {
  if (seedNodeIds.length === 0) return [];

  const alpha = options.alpha ?? DEFAULT_ALPHA;
  const topKNeighbors = options.topKNeighbors ?? DEFAULT_TOP_K_NEIGHBORS;
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const provenanceEnabled = options.provenanceEnabled === true;

  // Select patterns based on mode
  let patterns: MetaPathPattern[];
  switch (mode) {
    case "semantic":
      patterns = PATTERNS_SEMANTIC;
      break;
    case "temporal":
      patterns = PATTERNS_TEMPORAL;
      break;
    case "causal":
      patterns = PATTERNS_CAUSAL;
      break;
    case "both":
    default:
      patterns = [...PATTERNS_SEMANTIC, ...PATTERNS_TEMPORAL, ...PATTERNS_CAUSAL];
      break;
  }

  // Run all patterns in parallel
  const patternResults = await Promise.all(
    patterns.map((pattern) =>
      traversePattern(
        session,
        agentId,
        seedNodeIds,
        pattern,
        { alpha, topKNeighbors, threshold },
        provenanceEnabled,
      ).catch((err) => {
        options.logger?.debug?.(
          `memory-neo4j: [mpfp] pattern [${pattern.join("→")}] failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return [] as TraversalHit[];
      }),
    ),
  );

  // Separate Memory hits from Entity hits
  const allHits = patternResults.flat();
  const memoryHits: TraversalHit[] = [];
  const entityHits: TraversalHit[] = [];

  for (const hit of allHits) {
    if (hit.label === "Entity") {
      entityHits.push(hit);
    } else {
      memoryHits.push(hit);
    }
  }

  // Bridge entity hits back to Memory nodes
  const bridgedMemories = await bridgeEntitiesToMemories(session, agentId, entityHits).catch(
    (err) => {
      options.logger?.debug?.(
        `memory-neo4j: [mpfp] entity bridge failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [] as SearchSignalResult[];
    },
  );

  // Convert direct Memory hits to SearchSignalResult
  // For direct Memory hits we only have id+score; we need to fetch metadata
  const directMemoryResults = await fetchMemoryMetadata(session, agentId, memoryHits).catch(
    (err) => {
      options.logger?.debug?.(
        `memory-neo4j: [mpfp] memory metadata fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [] as SearchSignalResult[];
    },
  );

  // OP-200: Build a map from nodeId → provenance for entity/memory hits
  const hitProvenanceMap = new Map<string, TraversalHit>();
  if (provenanceEnabled) {
    for (const hit of allHits) {
      const existing = hitProvenanceMap.get(hit.nodeId);
      if (!existing || hit.score > existing.score) {
        hitProvenanceMap.set(hit.nodeId, hit);
      }
    }
  }

  // Merge and deduplicate — keep highest score per memory ID
  const scoreMap = new Map<string, SearchSignalResult>();

  for (const result of [...directMemoryResults, ...bridgedMemories]) {
    const existing = scoreMap.get(result.id);
    if (!existing || result.score > existing.score) {
      scoreMap.set(result.id, result);
    }
  }

  // Filter out seed nodes (they're already in primary signals)
  const seedSet = new Set(seedNodeIds);
  const results = [...scoreMap.values()].filter((r) => !seedSet.has(r.id));

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);

  // OP-200: Attach provenance from traversal hits to final results.
  if (provenanceEnabled) {
    for (const result of results) {
      // Try to find the traversal hit that led to this memory.
      // For direct memory hits, the nodeId is the memory ID.
      // For bridged entity hits, we check entity hits that were bridged.
      const directHit = hitProvenanceMap.get(result.id);
      if (directHit?.pattern) {
        const prov: SignalProvenance = {
          signal: "mpfp",
          metaPathPattern: directHit.pattern,
          seedId: directHit.seedId,
          traversalPath: directHit.hops,
          intermediateEntities: directHit.hops
            ?.filter((h) => h.nodeLabel === "Entity")
            .map((h) => h.displayName ?? h.nodeId),
        };
        result.provenance = prov;
      }
    }
  }

  return results;
}

/**
 * Fetch Memory node metadata for direct Memory traversal hits.
 */
async function fetchMemoryMetadata(
  session: Session,
  agentId: string,
  hits: TraversalHit[],
): Promise<SearchSignalResult[]> {
  if (hits.length === 0) return [];

  const ids = [...new Set(hits.map((h) => h.nodeId))];
  const scoreById = new Map<string, number>();
  for (const h of hits) {
    const existing = scoreById.get(h.nodeId) ?? 0;
    if (h.score > existing) scoreById.set(h.nodeId, h.score);
  }

  const result = await session.executeRead((tx) =>
    tx.run(
      `MATCH (m:Memory)
       WHERE m.id IN $ids
         AND m.agentId = $agentId
         AND m.validUntil IS NULL
       RETURN m.id AS id, m.text AS text, m.category AS category,
              m.importance AS importance, m.createdAt AS createdAt,
              m.validFrom AS validFrom,
              COALESCE(m.trustScore, 1.0) AS trustScore`,
      { ids, agentId },
    ),
  );

  return result.records.map((r) => ({
    id: r.get("id") as string,
    text: r.get("text") as string,
    category: r.get("category") as string,
    importance: r.get("importance") as number,
    createdAt: String(r.get("createdAt") ?? ""),
    validFrom: r.get("validFrom") != null ? String(r.get("validFrom")) : undefined,
    score: scoreById.get(r.get("id") as string) ?? 0,
    trustScore: (r.get("trustScore") as number) || 1.0,
  }));
}
