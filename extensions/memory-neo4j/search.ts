/**
 * Three-signal hybrid search with query-adaptive RRF fusion.
 *
 * Combines:
 *   Signal 1: Vector similarity (HNSW cosine)
 *   Signal 2: BM25 full-text keyword matching
 *   Signal 3: Graph traversal (structured entity nodes via fulltext index)
 *
 * Fused using confidence-weighted Reciprocal Rank Fusion (RRF)
 * with query-adaptive signal weights.
 *
 * Adapted from ontology project RRF implementation.
 */

import { shouldAbstain } from "./abstention-classifier.js";
import type { ExtractionConfig, MemoryNeo4jConfig } from "./config.js";
import type { Embeddings } from "./embeddings.js";
import type { MetricsCollector } from "./metrics.js";
import { NO_OP_METRICS } from "./metrics.js";
import { getOpinionsForTopics } from "./neo4j-client-opinion.js";
import type { Neo4jMemoryClient } from "./neo4j-client.js";
import { decomposeQuery, extractTemporalConstraint } from "./query-analyzer.js";
import type { HybridSearchResult, Logger, RerankerConfig, SearchSignalResult } from "./schema.js";

// Re-export extracted modules so existing imports from "./search.js" continue to work.
export { classifyQuery, expandBm25Query, getAdaptiveWeights } from "./search-query-classifier.js";
export type { QueryType } from "./search-query-classifier.js";
export { applyFactTypeBoost, detectFactTypeIntent } from "./search-fact-type.js";
export { isLowConfidenceResult, LOW_CONFIDENCE_THRESHOLD } from "./search-freshness.js";
export { fuseWithConfidenceRRF } from "./search-rrf-fusion.js";

import { applyFactTypeBoost, detectFactTypeIntent } from "./search-fact-type.js";
import {
  buildFreshnessSignal,
  DEFAULT_CANDIDATE_MULTIPLIER,
  DEFAULT_RRF_K,
  LOW_CONFIDENCE_THRESHOLD,
  RECENCY_DECAY_DAYS,
} from "./search-freshness.js";
// Internal imports from extracted modules used by the orchestrator below.
import { classifyQuery, expandBm25Query, getAdaptiveWeights } from "./search-query-classifier.js";
import { fuseWithConfidenceRRF, normalizeSignalScores } from "./search-rrf-fusion.js";

// ============================================================================
// Hybrid Search Orchestrator
// ============================================================================

/**
 * Perform a three-signal hybrid search with query-adaptive RRF fusion.
 *
 * 1. Embed the query
 * 2. Classify query for adaptive weights
 * 3. Run three signals in parallel
 * 4. Fuse with confidence-weighted RRF
 * 5. Return top results
 *
 * Graceful degradation: if any signal fails, RRF works with remaining signals.
 * If graph search is not enabled (no extraction API key), uses 2-signal fusion.
 */
export async function hybridSearch(
  db: Neo4jMemoryClient,
  embeddings: Embeddings,
  query: string,
  limit: number = 5,
  agentId: string = "default",
  graphEnabled: boolean = false,
  options: {
    rrfK?: number;
    candidateMultiplier?: number;
    graphFiringThreshold?: number;
    graphSearchDepth?: number;
    /** Max seed entities to look up in the fulltext index. Default: 5. */
    graphSeedCap?: number;
    /** Relationship types to traverse during graph search. Default: null (all types). */
    graphRelTypes?: string[] | null;
    /** Causal relationship types for directed chain search. Default: built-in list. */
    graphCausalRelTypes?: string[];
    logger?: Logger;
    /** When true, include expired (superseded) memories in search results */
    includeExpired?: boolean;
    /** ISO-8601 date — recall memories valid at this point in time. Takes precedence over includeExpired. */
    asOf?: string;
    /** Weight for recency boost applied after RRF fusion (default: 0.1). Higher = more recent memories ranked higher. */
    recencyWeight?: number;
    /**
     * Override adaptive signal weights [vector, bm25, graph, freshness].
     * When set, bypasses query-adaptive weight calculation.
     * Used by the eval harness to implement variant ablations (vector-only, bm25-only, etc.).
     */
    weightOverride?: [number, number, number, number];
    /**
     * Cross-encoder reranker configuration (OP-130).
     * When set and enabled, reranks the final candidate set before returning.
     */
    rerankerConfig?: RerankerConfig;
    /**
     * LLM extraction config — required when rerankerConfig.provider === "llm".
     */
    extractionConfig?: ExtractionConfig;
    /** Metrics collector for reranker telemetry. Defaults to no-op. */
    metricsCollector?: MetricsCollector;
    /**
     * Canonical name of the user's entity in the graph (e.g. "tarun").
     * When set, possessive pronouns ("my", "mine") in the query are resolved
     * to the user's entity name for graph search. Pure string substitution — no LLM call.
     */
    selfEntityName?: string | null;
    /** Optional query result cache. When provided and enabled, caches results by query+agentId. */
    searchCache?: import("./search-cache.js").QueryResultCache;
    /** When true, include quarantined (trustScore=0) memories in results. */
    includeQuarantined?: boolean;
    /** When true, include community search signal in RRF fusion. */
    communityDetectionEnabled?: boolean;
    /** Weight for community signal in RRF fusion. Default: 0.15. */
    communitySignalWeight?: number;
    /** When true, include MPFP meta-path traversal signal in RRF fusion (OP-181). Default: true when graphEnabled. */
    mpfpEnabled?: boolean;
    /** Weight for MPFP signal in RRF fusion. Default: 0.2. */
    mpfpSignalWeight?: number;
    /** When true, include observation summaries signal in RRF fusion (OP-183). Default: true when graphEnabled. */
    observationEnabled?: boolean;
    /** Weight for observation signal in RRF fusion. Default: 0.15. */
    observationSignalWeight?: number;
    /** When true, include opinion/belief signal in RRF fusion (OP-186). Default: true when graphEnabled. */
    opinionEnabled?: boolean;
    /** Weight for opinion signal in RRF fusion. Default: 0.2. */
    opinionSignalWeight?: number;
    /** @internal Guard against infinite recursion in compound query decomposition (OP-190). */
    _skipDecomposition?: boolean;
  } = {},
): Promise<HybridSearchResult[]> {
  // Guard against empty queries
  if (!query.trim()) {
    return [];
  }

  // OP-190: Compound query decomposition — split multi-intent queries into sub-queries
  // and run each independently, then merge results via round-robin interleaving.
  // Guard: recursive calls set _skipDecomposition to prevent infinite recursion.
  if (!options._skipDecomposition) {
    const decomposition = decomposeQuery(query);
    if (decomposition.isCompound && decomposition.subQueries.length >= 2) {
      options.logger?.info?.(
        `memory-neo4j: [decompose] compound query split into ${decomposition.subQueries.length} sub-queries`,
      );

      // Run hybridSearch for each sub-query independently (no further decomposition)
      const subResults = await Promise.all(
        decomposition.subQueries.map((sq) =>
          hybridSearch(db, embeddings, sq, limit, agentId, graphEnabled, {
            ...options,
            _skipDecomposition: true,
          }),
        ),
      );

      // Round-robin interleave: take rank 1 from sub-query 1, rank 1 from sub-query 2, etc.
      const merged: HybridSearchResult[] = [];
      const seenIds = new Set<string>();
      const maxLen = Math.max(...subResults.map((r) => r.length));
      for (let rank = 0; rank < maxLen; rank++) {
        for (const results of subResults) {
          if (rank < results.length) {
            const r = results[rank];
            if (!seenIds.has(r.id)) {
              seenIds.add(r.id);
              merged.push({ ...r, decomposed: true });
            }
            // Dedup: if already seen, skip (first occurrence has higher rank = higher score)
          }
        }
      }

      return merged.slice(0, limit);
    }
  }

  // OP-184: Extract temporal constraints from the query before retrieval.
  // If the query contains temporal expressions (e.g. "last week", "in January"),
  // extract a date range filter and use the cleaned query for semantic search.
  const temporalConstraint = extractTemporalConstraint(query);
  let semanticQuery = query;
  let dateRangeStart: string | undefined;
  let dateRangeEnd: string | undefined;
  if (temporalConstraint) {
    semanticQuery = temporalConstraint.cleanedQuery || query;
    dateRangeStart = temporalConstraint.startDate;
    dateRangeEnd = temporalConstraint.endDate;
    options.logger?.info(
      `memory-neo4j: [temporal] extracted "${temporalConstraint.originalExpression}" → range ${dateRangeStart} to ${dateRangeEnd}`,
    );
  }

  // ── Mental model fast-path (OP-188) ──
  // For opinion-intent queries, check if a high-confidence opinion can directly answer.
  const opinionFastPathEnabled = graphEnabled && options.opinionEnabled !== false;
  const factTypeIntentEarly = detectFactTypeIntent(query);
  if (opinionFastPathEnabled && factTypeIntentEarly === "opinion") {
    try {
      const topicKeywords = query
        .split(/\s+/)
        .filter((w) => w.length >= 3 && !/^(what|who|does|did|how|the|and|for|with)$/i.test(w))
        .map((w) => w.replace(/[^a-zA-Z0-9]/g, ""))
        .filter((w) => w.length >= 3);
      if (topicKeywords.length > 0) {
        const fastPathSession = await db.createSession();
        try {
          const opinions = await getOpinionsForTopics(fastPathSession, agentId, topicKeywords);
          // Find a high-confidence opinion (>= 0.8)
          const highConfidence = opinions.find((o) => o.confidence >= 0.8);
          if (highConfidence && highConfidence.supportingMemoryIds.length > 0) {
            // Fetch supporting memory texts to build direct answer results
            const memIds = highConfidence.supportingMemoryIds;
            const memResult = await fastPathSession.executeRead((tx) =>
              tx.run(
                `MATCH (m:Memory)
                 WHERE m.id IN $ids AND m.agentId = $agentId AND m.validUntil IS NULL
                 RETURN m.id AS id, m.text AS text, m.category AS category,
                        m.importance AS importance, m.createdAt AS createdAt,
                        m.validFrom AS validFrom,
                        COALESCE(m.trustScore, 1.0) AS trustScore`,
                { ids: memIds, agentId },
              ),
            );

            if (memResult.records.length > 0) {
              const directResults: HybridSearchResult[] = memResult.records.map((r, i) => ({
                id: r.get("id") as string,
                text: r.get("text") as string,
                category: r.get("category") as string,
                importance: r.get("importance") as number,
                createdAt: String(r.get("createdAt") ?? ""),
                validFrom: r.get("validFrom") != null ? String(r.get("validFrom")) : undefined,
                score: 1.0 - i * 0.05, // Highest score for first result
                trustScore: (r.get("trustScore") as number) || 1.0,
                directAnswer: true,
                opinionSource: {
                  topic: highConfidence.topic,
                  belief: highConfidence.belief,
                  confidence: highConfidence.confidence,
                },
                signals: {
                  vector: { rank: 0, score: 0 },
                  bm25: { rank: 0, score: 0 },
                  graph: { rank: 0, score: 0 },
                  opinion: { rank: i + 1, score: highConfidence.confidence },
                },
              }));

              options.logger?.info?.(
                `memory-neo4j: [mental-model] direct answer from opinion "${highConfidence.topic}" (confidence: ${highConfidence.confidence})`,
              );
              return directResults.slice(0, limit);
            }
          }
        } finally {
          await fastPathSession.close();
        }
      }
    } catch {
      // Non-critical — fall through to full search pipeline
    }
  }

  // Check cache before executing signals
  const cacheOptions = options.searchCache
    ? {
        includeExpired: options.includeExpired,
        asOf: options.asOf,
        limit,
        includeQuarantined: options.includeQuarantined,
        recencyWeight: options.recencyWeight,
        graphSearchDepth: options.graphSearchDepth,
        graphSeedCap: options.graphSeedCap,
      }
    : undefined;
  if (options.searchCache) {
    const cached = await options.searchCache.get(query, agentId, cacheOptions);
    if (cached) {
      options.metricsCollector?.increment("cache.hits");
      return cached;
    }
    options.metricsCollector?.increment("cache.misses");
  }

  const {
    rrfK = DEFAULT_RRF_K,
    candidateMultiplier = DEFAULT_CANDIDATE_MULTIPLIER,
    graphFiringThreshold = 0.3,
    graphSearchDepth = 2,
    graphSeedCap,
    graphRelTypes,
    graphCausalRelTypes,
    logger,
    includeExpired = false,
    asOf,
    recencyWeight = 0.1,
    weightOverride,
    rerankerConfig,
    extractionConfig,
    metricsCollector = NO_OP_METRICS,
    selfEntityName,
  } = options;

  // Resolve possessive pronouns and strip question noise for graph search.
  // Applied only to the graph query — BM25/vector use the original query.
  //
  // Two-step process:
  //   1. Replace "my"/"mine" with the user's entity name for fulltext matching.
  //   2. Strip question words (what/is/does/etc.) so the Lucene fulltext query
  //      focuses on entity-relevant terms. Without this, a 9-word query like
  //      "What is my wife's older son's phone number?" matches "tarun" as 1/9 terms
  //      giving a low BM25 score that falls below the 0.5 seed threshold.
  let graphQuery = query;
  if (graphEnabled) {
    if (selfEntityName) {
      graphQuery = graphQuery.replace(/\b(my|mine)\b/gi, selfEntityName);
    }
    // Strip leading question patterns and filler words to improve BM25 seed scoring.
    // "What is tarun wife's older son's phone number" → "tarun wife's older son's phone number"
    graphQuery = graphQuery
      .replace(
        /^(what|who|where|when|how|which|whose|whom)\s+(is|are|was|were|does|did|do|has|have|had|will|would|can|could|should)\s+/i,
        "",
      )
      .replace(/[?]/g, "")
      // M23: Strip possessives ('s) to prevent Lucene BM25 dilution.
      // "Tarun's preferred timezone" → "Tarun preferred timezone"
      // Without this, Lucene tokenizes "Tarun's" as ["tarun", "s"] and the noise
      // token "s" dilutes the BM25 score, pushing the entity below the seed threshold.
      .replace(/'s\b/g, "")
      .trim();
  }

  // When reranking is active, fetch topK candidates before reranking; otherwise fetch limit*multiplier
  const rerankerActive = rerankerConfig?.enabled && rerankerConfig.provider !== "none";
  const candidateLimit = rerankerActive
    ? Math.floor(Math.min(200, Math.max(1, rerankerConfig!.topK ?? 10)))
    : Math.floor(Math.min(200, Math.max(1, limit * candidateMultiplier)));

  // 1. Generate query embedding
  const t0 = performance.now();
  // Use cleaned query for embedding so temporal noise doesn't pollute vector similarity
  const queryEmbedding = await embeddings.embed(semanticQuery);
  const tEmbed = performance.now();

  // 2. Classify query and get adaptive weights (overridable for eval variants)
  const queryType = classifyQuery(query);
  const [vW, bW, gW, freshnessW] = weightOverride ?? getAdaptiveWeights(queryType, graphEnabled);

  // BM25 query expansion for extraction queries: append Lucene fuzzy modifier (~1)
  // to content words so BM25 matches morphological variants without changing the
  // fulltext index analyzer. "preferred" matches "prefers", "meetings" matches "meeting".
  // Only vector/graph use the original query; BM25 gets the expanded version.
  const bm25Query = queryType === "extraction" ? expandBm25Query(semanticQuery) : semanticQuery;

  // Detect fact type intent early — needed by opinion signal (OP-186) and post-fusion boost (OP-185).
  const factTypeIntent = detectFactTypeIntent(query);

  // Community signal weight (opt-in, default 0.15 when enabled)
  const communityEnabled = options.communityDetectionEnabled === true;
  const communityW = communityEnabled ? (options.communitySignalWeight ?? 0.15) : 0;

  // 3. Run signals in parallel — each gets its own session because Neo4j sessions
  //    don't support concurrent transactions (executeRead starts a transaction).
  // H7: Per-signal timeout (15s) prevents a single hung signal from blocking the entire search.
  // Each signal gets an AbortController so that when the timeout fires, zombie retries
  // are stopped and the Neo4j session is closed — preventing connection pool exhaustion
  // during high-throughput workloads like the eval harness.
  // M22: Reduced from 15s to 5s. M25: Reduced to 3s — graph traversal timeout
  // is now 2s (down from 5s) and typical queries complete in <100ms. The 3s
  // outer timeout covers network/session overhead for edge cases.
  const SIGNAL_TIMEOUT_MS = 3_000;
  // M15: Clear timer when the promise resolves to prevent timer accumulation
  const withAbortableTimeout = <T>(
    fn: (signal: AbortSignal) => Promise<T>,
    fallback: T,
  ): Promise<T> => {
    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<T>((resolve) => {
      timer = setTimeout(() => {
        ac.abort();
        resolve(fallback);
      }, SIGNAL_TIMEOUT_MS);
      if (typeof timer === "object" && "unref" in timer) timer.unref();
    });
    return Promise.race([fn(ac.signal).finally(() => clearTimeout(timer)), timeoutPromise]);
  };

  const [vectorResults, bm25Results, graphResults, communityResults] = await Promise.all([
    withAbortableTimeout(
      (signal) =>
        db.vectorSearch(
          queryEmbedding,
          candidateLimit,
          0.1,
          agentId,
          includeExpired,
          asOf,
          options.includeQuarantined,
          signal,
          dateRangeStart,
          dateRangeEnd,
        ),
      [] as SearchSignalResult[],
    ),
    withAbortableTimeout(
      (signal) =>
        db.bm25Search(
          bm25Query,
          candidateLimit,
          agentId,
          includeExpired,
          asOf,
          options.includeQuarantined,
          signal,
          dateRangeStart,
          dateRangeEnd,
        ),
      [] as SearchSignalResult[],
    ),
    withAbortableTimeout(
      (signal) =>
        graphEnabled
          ? db.graphSearch(
              graphQuery,
              candidateLimit,
              graphFiringThreshold,
              agentId,
              graphSearchDepth,
              includeExpired,
              asOf,
              graphSeedCap,
              graphRelTypes,
              undefined, // hopDecayThreshold — use default
              queryType, // dispatch to causalChainSearch for "causal" queries
              queryEmbedding, // OP-143: dual-seed — vector + fulltext for entity traversal
              graphCausalRelTypes, // configurable causal types for chain search
              signal,
            )
          : Promise.resolve([] as SearchSignalResult[]),
      [] as SearchSignalResult[],
    ),
    withAbortableTimeout(
      (signal) =>
        communityEnabled
          ? db.communitySearch(
              query,
              candidateLimit,
              agentId,
              options.includeQuarantined,
              includeExpired,
              asOf,
              signal,
            )
          : Promise.resolve([] as SearchSignalResult[]),
      [] as SearchSignalResult[],
    ),
  ]);
  const tSignals = performance.now();

  // 4a. Normalize unbounded graph/community scores to 0-1.
  //     Vector (cosine) and BM25 are already in [0, 1]; graph and community
  //     carry raw Lucene fulltext scores (often 2–5+) that would dominate RRF.
  //     Graph results are now resolved to Memory nodes via EXTRACTED_FROM
  //     provenance edges in structuredGraphSearch, so they carry Memory IDs
  //     consistent with vector/BM25 signals.
  const normalizedGraphResults = normalizeSignalScores(graphResults);
  const normalizedCommunityResults = normalizeSignalScores(communityResults);

  // 4a-bis. MPFP meta-path traversal (OP-181): run after primary signals
  // to use seed Memory IDs from vector/BM25 hits as traversal starting points.
  const mpfpEnabled = graphEnabled && options.mpfpEnabled !== false;
  const mpfpW = mpfpEnabled ? (options.mpfpSignalWeight ?? 0.2) : 0;
  let mpfpResults: SearchSignalResult[] = [];
  if (mpfpEnabled) {
    const seedIds = [
      ...new Set([...vectorResults.map((r) => r.id), ...bm25Results.map((r) => r.id)]),
    ];
    if (seedIds.length > 0) {
      // Determine MPFP mode: temporal queries use temporal patterns, others use semantic.
      // OP-184: also use temporal mode when query-analyzer extracted a date constraint.
      const mpfpMode =
        queryType === "updates" || temporalConstraint
          ? "temporal"
          : queryType === "causal"
            ? "both"
            : "semantic";
      mpfpResults = await withAbortableTimeout(
        (signal) => db.mpfpSearch(seedIds, agentId, mpfpMode, { logger }, signal),
        [] as SearchSignalResult[],
      );
    }
  }
  const normalizedMpfpResults = normalizeSignalScores(mpfpResults);

  // 4a-ter. Observation signal (OP-183): look up per-entity observation summaries
  // for entities matching the query and map to connected memory IDs.
  const observationEnabled = graphEnabled && options.observationEnabled !== false;
  const observationW = observationEnabled ? (options.observationSignalWeight ?? 0.15) : 0;
  let observationResults: SearchSignalResult[] = [];
  if (observationEnabled) {
    try {
      // Extract capitalized words (likely entity names) from the graph-optimized query
      const entityCandidates = graphQuery
        .split(/\s+/)
        .filter((w) => w.length >= 2 && /^[A-Z]/i.test(w))
        .map((w) => w.replace(/[^a-zA-Z0-9]/g, ""))
        .filter((w) => w.length >= 2);
      const uniqueNames = [...new Set(entityCandidates)];
      if (uniqueNames.length > 0) {
        const observations = await db.getObservationsForEntities(agentId, uniqueNames);
        for (const obs of observations) {
          // Create synthetic signal results: each connected memory gets a score
          // proportional to 1/position so earlier memories rank higher.
          const count = obs.memoryIds.length;
          for (let i = 0; i < count; i++) {
            observationResults.push({
              id: obs.memoryIds[i],
              text: obs.summary,
              category: "entity",
              importance: 0.8,
              createdAt: new Date().toISOString(),
              score: count > 1 ? 1 - i / count : 1.0,
            });
          }
        }
      }
    } catch {
      // Non-critical — observation lookup failure doesn't block search
    }
  }
  const normalizedObservationResults = normalizeSignalScores(observationResults);

  // 4a-quater. Opinion/belief signal (OP-186): look up opinions matching query keywords
  // and map to their supporting memory IDs, with confidence-based score boosting.
  // Only fires for opinion/preference intent queries (detected by OP-185).
  const opinionEnabled = graphEnabled && options.opinionEnabled !== false;
  const opinionW = opinionEnabled ? (options.opinionSignalWeight ?? 0.2) : 0;
  let opinionResults: SearchSignalResult[] = [];
  if (opinionEnabled && factTypeIntent === "opinion") {
    try {
      // Extract topic keywords from the query for opinion lookup
      const topicKeywords = query
        .split(/\s+/)
        .filter((w) => w.length >= 3 && !/^(what|who|does|did|how|the|and|for|with)$/i.test(w))
        .map((w) => w.replace(/[^a-zA-Z0-9]/g, ""))
        .filter((w) => w.length >= 3);
      if (topicKeywords.length > 0) {
        const session = await db.createSession();
        try {
          const opinions = await getOpinionsForTopics(session, agentId, topicKeywords);
          for (const op of opinions) {
            // Confidence-based score boost:
            // High (>= 0.7): 1.4x, Medium (0.4-0.7): 1.0x, Low (< 0.4): 0.7x
            const confidenceBoost = op.confidence >= 0.7 ? 1.4 : op.confidence >= 0.4 ? 1.0 : 0.7;
            const baseScore = op.confidence * confidenceBoost;
            // Bridge to supporting memory IDs
            const count = op.supportingMemoryIds.length;
            for (let i = 0; i < count; i++) {
              opinionResults.push({
                id: op.supportingMemoryIds[i],
                text: op.belief,
                category: "preference",
                importance: 0.9,
                createdAt: new Date().toISOString(),
                score: count > 1 ? baseScore * (1 - i / count) : baseScore,
              });
            }
          }
        } finally {
          await session.close();
        }
      }
    } catch {
      // Non-critical — opinion lookup failure doesn't block search
    }
  }
  const normalizedOpinionResults = normalizeSignalScores(opinionResults);

  // 4b. Build temporal freshness signal from validFrom dates across all candidates (OP-129).
  //     Only candidates where validFrom differs from createdAt by >7 days participate.
  const now = Date.now();
  const freshnessSignal = buildFreshnessSignal(
    [
      ...vectorResults,
      ...bm25Results,
      ...normalizedGraphResults,
      ...normalizedCommunityResults,
      ...normalizedMpfpResults,
      ...normalizedObservationResults,
      ...normalizedOpinionResults,
    ],
    now,
  );

  // 5. Fuse all signals with confidence-weighted RRF.
  //    8 signals: vector, bm25, graph, freshness, community, mpfp, observation, opinion.
  //    M22: When graph returns empty results, zero its weight to prevent
  //    diluting vector/BM25 contributions. An empty graph signal adds no
  //    useful information but changes relative RRF score distribution.
  const effectiveGraphWeight = normalizedGraphResults.length > 0 ? gW : 0;
  const effectiveMpfpWeight = normalizedMpfpResults.length > 0 ? mpfpW : 0;
  const effectiveObservationWeight = normalizedObservationResults.length > 0 ? observationW : 0;
  const effectiveOpinionWeight = normalizedOpinionResults.length > 0 ? opinionW : 0;
  const weights = [
    vW,
    bW,
    effectiveGraphWeight,
    freshnessW,
    communityW,
    effectiveMpfpWeight,
    effectiveObservationWeight,
    effectiveOpinionWeight,
  ];
  let fused = fuseWithConfidenceRRF(
    [
      vectorResults,
      bm25Results,
      normalizedGraphResults,
      freshnessSignal,
      normalizedCommunityResults,
      normalizedMpfpResults,
      normalizedObservationResults,
      normalizedOpinionResults,
    ],
    rrfK,
    weights,
  );

  // 5b. Fact type boost (OP-185): boost matching categories when intent detected.
  if (factTypeIntent) {
    fused = applyFactTypeBoost(fused, factTypeIntent);
    logger?.info?.(`memory-neo4j: [fact-type] detected intent="${factTypeIntent}"`);
  }

  const tFuse = performance.now();

  // 6. Apply recency as a multiplicative boost (OP-121).
  //    recencyScore = exp(-daysSince / 365) — 1-year half-life
  //    boostedScore = rrfScore * (1 + recencyWeight * recencyScore)
  //    Then normalize to 0-1 range.
  //    Apply to a larger window (limit*2) so recent memories ranked just outside
  //    the RRF top-N can still surface after the recency re-sort.
  const recencyWindow = Math.min(fused.length, limit * 2);
  const candidates = fused.slice(0, recencyWindow).map((r) => {
    const createdAtMs = r.createdAt ? new Date(r.createdAt).getTime() : NaN;
    const ageDays = !Number.isNaN(createdAtMs)
      ? (now - createdAtMs) / (1000 * 60 * 60 * 24)
      : RECENCY_DECAY_DAYS; // default to 1 year if missing or malformed createdAt
    const recencyScore = Math.exp(-ageDays / RECENCY_DECAY_DAYS);
    const boostedScore = r.rrfScore * (1 + recencyWeight * recencyScore);
    return { ...r, recencyScore, boostedScore };
  });

  // Re-sort by boosted score (recency boost may reorder vs pure RRF)
  // then take only `limit` results
  candidates.sort((a, b) => b.boostedScore - a.boostedScore);
  candidates.splice(limit);

  // Score-gap truncation for extraction queries: if the score drops sharply between
  // consecutive results, the tail is likely noise. Trimming improves precision without
  // hurting recall (gold memories score well above distractors).
  const SCORE_GAP_RATIO = 0.6; // >40% drop signals noise — tighter to prune competitive distractors
  if (queryType === "extraction" && candidates.length >= 2) {
    let cutoff = candidates.length;
    for (let i = 1; i < candidates.length; i++) {
      if (candidates[i].boostedScore < candidates[i - 1].boostedScore * SCORE_GAP_RATIO) {
        cutoff = i;
        break;
      }
    }
    if (cutoff < candidates.length) {
      logger?.info?.(
        `memory-neo4j: [score-gap] truncated extraction results from ${candidates.length} to ${cutoff}`,
      );
      candidates.splice(cutoff);
    }
  }

  // Normalize boosted scores to 0-1 range
  const maxBoosted = candidates.length > 0 ? candidates[0].boostedScore : 0;
  const MIN_SCORE_FOR_NORMALIZATION = 0.01;
  const normalizer = maxBoosted >= MIN_SCORE_FOR_NORMALIZATION ? 1 / maxBoosted : 1;

  // 7. Detect low confidence (OP-129): flag all results when the top result was
  //    found by only one primary signal AND the second result scores well below it.
  //    Consumers can use lowConfidence=true to abstain from injecting weak context.
  const lowConfidence = (() => {
    if (candidates.length < 1) {
      return false;
    }
    const top = candidates[0];
    const s = top.signals;
    const vectorFound = s.vector.rank > 0;
    const bm25Found = s.bm25.rank > 0;
    const graphFound = s.graph.rank > 0;
    const signalCount = [vectorFound, bm25Found, graphFound].filter(Boolean).length;
    if (signalCount > 1) {
      return false;
    }
    // Compute normalized score for second result to compare
    const secondBoosted = candidates.length >= 2 ? candidates[1].boostedScore : 0;
    const secondNormalized = Math.min(1, secondBoosted * normalizer);
    return secondNormalized < LOW_CONFIDENCE_THRESHOLD;
  })();

  const results: HybridSearchResult[] = candidates.map((r) => ({
    id: r.id,
    text: r.text,
    category: r.category,
    importance: r.importance,
    createdAt: r.createdAt,
    validFrom: r.validFrom,
    score: Math.min(1, r.boostedScore * normalizer),
    ...(lowConfidence ? { lowConfidence: true as const } : {}),
    signals: {
      ...r.signals,
      recency: { rank: 0, score: r.recencyScore },
    },
  }));

  // 7b. Rerank candidates if configured (OP-130).
  //     Temporal/update queries route to LLM reranker (with timestamps) inside rerankCandidates.
  //     All other queries use the local cross-encoder HTTP service.
  let finalResults = results;
  if (rerankerActive && rerankerConfig) {
    const { rerankCandidates } = await import("./reranker.js");
    finalResults = await rerankCandidates(
      query,
      results,
      rerankerConfig,
      extractionConfig ?? null,
      logger ?? null,
      metricsCollector,
      undefined, // no per-search AbortSignal here
      queryType, // passed for temporal routing decision
    );
  }

  // 7c. Unified abstention classifier (OP-137).
  // Runs on both reranker and non-reranker paths. Operates on .score which is
  // cross-encoder relevanceScore post-reranking, or normalized RRF score otherwise.
  // Skip for graph-only results — classifiers can't evaluate relationship-traversal
  // results meaningfully (e.g. multi-hop entity chains).
  // Skip for temporal queries — LLM reranker assigns moderate scores (0.8–0.9) to
  // comparison-type queries where multiple memories are jointly relevant.
  if (finalResults.length > 0) {
    const { isTemporalQuery } = await import("./reranker.js");
    const temporal = isTemporalQuery(query, queryType);
    const graphOnlyResults = finalResults.every((r) => {
      const s = r.signals;
      return s && s.graph.rank > 0 && s.vector.rank === 0 && s.bm25.rank === 0;
    });
    if (graphOnlyResults) {
      logger?.info(
        `memory-neo4j: [abstention] skipped — all ${finalResults.length} results are graph-only`,
      );
    } else if (temporal) {
      logger?.info(`memory-neo4j: [abstention] skipped — temporal query`);
    } else if (shouldAbstain(finalResults, queryType)) {
      logger?.info(
        `memory-neo4j: [abstention/classifier] abstaining — queryType=${queryType} candidates=${finalResults.length} maxScore=${finalResults[0].score.toFixed(3)}`,
      );
      metricsCollector.increment("reranker.abstentions");
      finalResults = [];
    }
  }

  // Memory node IDs from vector/BM25 signals — used for retrieval tracking and episode enrichment.
  // Graph signal results carry Neo4j element IDs (entity nodes) which don't exist in the Memory label.
  const memoryIdSet = new Set([...vectorResults.map((r) => r.id), ...bm25Results.map((r) => r.id)]);

  // 6. Record retrieval events (fire-and-forget for latency)
  // This tracks which memories are actually being used, enabling
  // retrieval-based importance adjustment.
  if (finalResults.length > 0) {
    const memoryIds = finalResults.map((r) => r.id).filter((id) => memoryIdSet.has(id));
    if (memoryIds.length > 0) {
      db.recordRetrievals(memoryIds).catch((err) => {
        logger?.debug?.(
          `memory-neo4j: recordRetrievals failed (non-critical): ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
  }

  // 8. Episode enrichment (OP-178): attach episode metadata to results.
  //    Non-blocking — episode metadata is informational ("when did we discuss X?").
  //    Only enrich Memory-node results (graph-only entity results don't have episodes).
  if (finalResults.length > 0) {
    const enrichIds = finalResults.map((r) => r.id).filter((id) => memoryIdSet.has(id));
    if (enrichIds.length > 0) {
      try {
        const episodes = await db.episodeEnrich(enrichIds);
        if (episodes.length > 0) {
          const epByMemory = new Map(episodes.map((e) => [e.memoryId, e]));
          for (const r of finalResults) {
            const ep = epByMemory.get(r.id);
            if (ep) {
              r.episodeId = ep.episodeId;
              r.episodeDate = ep.episodeDate;
              r.episodeSessionKey = ep.episodeSessionKey;
            }
          }
        }
      } catch (err) {
        logger?.debug?.(
          `memory-neo4j: episodeEnrich failed (non-critical): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // Log search timing breakdown
  const recencyStr = recencyWeight !== 0.1 ? ` recencyWeight=${recencyWeight}` : "";
  const asOfStr = asOf ? ` asOf=${asOf}` : "";
  const lowConfStr = lowConfidence ? " lowConf=true" : "";
  const rerankerStr = rerankerActive ? ` reranker=${rerankerConfig?.provider}` : "";
  const factTypeStr = factTypeIntent ? ` factType=${factTypeIntent}` : "";
  logger?.info?.(
    `memory-neo4j: [bench] hybridSearch ${(tFuse - t0).toFixed(0)}ms (embed=${(tEmbed - t0).toFixed(0)}ms, signals=${(tSignals - tEmbed).toFixed(0)}ms, fuse=${(tFuse - tSignals).toFixed(0)}ms) ` +
      `type=${queryType} vec=${vectorResults.length} bm25=${bm25Results.length} graph=${graphResults.length} freshness=${freshnessSignal.length} mpfp=${mpfpResults.length} obs=${observationResults.length} opin=${opinionResults.length} → ${finalResults.length} results${recencyStr}${asOfStr}${lowConfStr}${rerankerStr}${factTypeStr}`,
  );

  // Store in cache (if enabled)
  if (options.searchCache) {
    await options.searchCache.set(query, agentId, finalResults, cacheOptions);
  }

  return finalResults;
}

// ============================================================================
// Shared Search Options Builder
// ============================================================================

/**
 * Build the options object for `hybridSearch()` from plugin config, DB, and
 * caller-supplied overrides. Extracts the duplicated config-to-options mapping
 * that was previously inlined in both plugin-hooks (auto-recall) and
 * plugin-tools (memory_recall).
 *
 * `selfEntityName` must be resolved by the caller before invoking this function
 * (e.g. via `resolveSelfEntityName`), keeping the builder synchronous and free
 * of filesystem imports.
 */
export function buildSearchOptions(params: {
  cfg: MemoryNeo4jConfig;
  extractionConfig: ExtractionConfig;
  db: Neo4jMemoryClient;
  logger: Logger;
  selfEntityName?: string | null;
  // Optional overrides for tool-specific params
  includeExpired?: boolean;
  asOf?: string;
  includeQuarantined?: boolean;
}): Parameters<typeof hybridSearch>[6] {
  const { cfg, extractionConfig, db, logger } = params;
  // signals section takes precedence over scattered legacy locations
  const signals = cfg.signals;
  return {
    graphSearchDepth: cfg.graphSearchDepth,
    graphSeedCap: cfg.graphSeedCap,
    graphRelTypes: cfg.graphRelTypes,
    graphCausalRelTypes: cfg.graphCausalRelTypes,
    selfEntityName: params.selfEntityName,
    communityDetectionEnabled: cfg.communityDetection?.enabled,
    communitySignalWeight: signals?.communityWeight ?? cfg.communityDetection?.signalWeight,
    recencyWeight: signals?.recencyWeight ?? cfg.recencyWeight,
    mpfpSignalWeight: signals?.mpfpWeight,
    observationSignalWeight: signals?.observationWeight,
    opinionSignalWeight: signals?.opinionWeight,
    logger,
    searchCache: db.searchCache,
    includeExpired: params.includeExpired,
    asOf: params.asOf,
    includeQuarantined: params.includeQuarantined,
    ...(cfg.reranker?.enabled ? { rerankerConfig: cfg.reranker, extractionConfig } : {}),
  };
}
