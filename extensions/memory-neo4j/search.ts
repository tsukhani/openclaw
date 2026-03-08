/**
 * Three-signal hybrid search with query-adaptive RRF fusion.
 *
 * Combines:
 *   Signal 1: Vector similarity (HNSW cosine)
 *   Signal 2: BM25 full-text keyword matching
 *   Signal 3: Graph traversal (entity → MENTIONS ← memory)
 *
 * Fused using confidence-weighted Reciprocal Rank Fusion (RRF)
 * with query-adaptive signal weights.
 *
 * Adapted from ontology project RRF implementation.
 */

import type { ExtractionConfig } from "./config.js";
import type { Embeddings } from "./embeddings.js";
import type { MetricsCollector } from "./metrics.js";
import { NO_OP_METRICS } from "./metrics.js";
import type { Neo4jMemoryClient } from "./neo4j-client.js";
import type {
  HybridSearchResult,
  Logger,
  RerankerConfig,
  SearchSignalResult,
  SignalAttribution,
} from "./schema.js";

// ============================================================================
// Query Classification
// ============================================================================

export type QueryType = "short" | "entity" | "long" | "updates" | "default";

/**
 * Classify a query to determine adaptive signal weights.
 *
 * - short (1-2 words): BM25 excels at exact keyword matching
 * - entity (proper nouns detected): Graph traversal finds connected memories
 * - long (5+ words): Vector captures semantic intent better
 * - updates: Query asks about changed/current state — boost temporal freshness signal
 * - default: balanced weights
 */
export function classifyQuery(query: string): QueryType {
  const words = query.trim().split(/\s+/);
  const wordCount = words.length;

  // Detect update/currency queries early — prioritise over length-based classification
  // so "what is the current model?" (5 words) gets freshness boost rather than "long".
  if (/\b(current|latest|now|changed|update|updated|new|newest|recent)\b/i.test(query)) {
    return "updates";
  }

  const commonWords =
    /^(I|A|An|The|Is|Are|Was|Were|What|Who|Where|When|How|Why|Do|Does|Did|Find|Show|Get|Tell|Me|My|About|For|Can|Could|Has|Have|Should|Would|Please|Will|Shall|May|Might|Am)$/;
  const capitalizedWords = words.filter((w) => /^[A-Z]/.test(w) && !commonWords.test(w));

  // Short queries: 1-2 words → boost BM25, but promote to entity if proper noun detected.
  // Gate entity detection behind word count so longer technical queries like
  // "TypeScript best practices" don't falsely trigger entity/graph boost.
  if (wordCount <= 2) {
    return capitalizedWords.length > 0 ? "entity" : "short";
  }

  // Question patterns targeting entities (3-4 word queries only,
  // so generic long questions like "what is the best framework" fall through to "long")
  if (wordCount <= 4 && /^(who|where|what)\s+(is|does|did|was|were)\s/i.test(query)) {
    return "entity";
  }

  // Long queries: 5+ words → boost vector
  if (wordCount >= 5) {
    return "long";
  }

  return "default";
}

/**
 * Get adaptive signal weights based on query type.
 * Returns [vectorWeight, bm25Weight, graphWeight, freshnessWeight].
 *
 * Decision Q7: Query-adaptive RRF weights
 * - Short → boost BM25 (keyword matching)
 * - Entity → boost graph (relationship traversal)
 * - Long → boost vector (semantic similarity)
 * - Updates → boost freshness (validFrom-based temporal signal, OP-129)
 */
export function getAdaptiveWeights(
  queryType: QueryType,
  graphEnabled: boolean,
): [number, number, number, number] {
  const graphBase = graphEnabled ? 1.0 : 0.0;

  switch (queryType) {
    case "short":
      return [0.8, 1.2, graphBase * 1.0, 0.2];
    case "entity":
      return [0.8, 1.0, graphBase * 1.3, 0.2];
    case "long":
      return [1.2, 0.7, graphBase * 0.8, 0.2];
    case "updates":
      // Stronger freshness boost so newer validFrom memories outrank stale ones
      return [1.0, 1.0, graphBase * 1.0, 0.6];
    case "default":
    default:
      return [1.0, 1.0, graphBase * 1.0, 0.2];
  }
}

// ============================================================================
// Temporal Freshness Signal (OP-129)
// ============================================================================

/**
 * Minimum score ratio below which a result set is considered low-confidence.
 * If the top result was found by only one primary signal AND the second result's
 * normalized score is below this threshold, all results are flagged lowConfidence.
 */
export const LOW_CONFIDENCE_THRESHOLD = 0.35;

/**
 * Returns true if the result set has been flagged as low-confidence.
 * Consumers can use this to abstain from injecting context rather than risk
 * hallucinating with irrelevant memories.
 */
export function isLowConfidenceResult(results: HybridSearchResult[]): boolean {
  return results.length > 0 && results[0].lowConfidence === true;
}

/**
 * Build a synthetic freshness signal from candidate validFrom dates.
 *
 * Only includes candidates where validFrom differs from createdAt by more than
 * 7 days — i.e. the memory was explicitly back-dated or represents an update
 * to an earlier fact. Sorted by freshness score descending to create ranks for RRF.
 *
 * Freshness score: exp(-daysSince / 365) — decays over ~1 year.
 */
function buildFreshnessSignal(candidates: SearchSignalResult[], now: number): SearchSignalResult[] {
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  const seen = new Set<string>();
  const withFreshness: SearchSignalResult[] = [];

  for (const c of candidates) {
    if (seen.has(c.id)) {
      continue;
    }
    seen.add(c.id);

    if (!c.validFrom) {
      continue;
    }
    const validFromMs = new Date(c.validFrom).getTime();
    const createdAtMs = c.createdAt ? new Date(c.createdAt).getTime() : 0;
    // Only apply freshness when validFrom was explicitly set to differ from createdAt
    if (Math.abs(validFromMs - createdAtMs) <= SEVEN_DAYS_MS) {
      continue;
    }

    const daysSince = (now - validFromMs) / (1000 * 60 * 60 * 24);
    const freshnessScore = Math.exp(-daysSince / 365);
    withFreshness.push({ ...c, score: freshnessScore });
  }

  withFreshness.sort((a, b) => b.score - a.score);
  return withFreshness;
}

// ============================================================================
// Confidence-Weighted RRF Fusion
// ============================================================================

type SignalEntry = {
  rank: number; // 1-indexed
  score: number; // 0-1 normalized
};

type FusedCandidate = {
  id: string;
  text: string;
  category: string;
  importance: number;
  createdAt: string;
  validFrom?: string;
  rrfScore: number;
  taskId?: string;
  signals: {
    vector: SignalAttribution;
    bm25: SignalAttribution;
    graph: SignalAttribution;
    freshness: SignalAttribution;
  };
};

/**
 * Fuse multiple search signals using confidence-weighted RRF.
 *
 * Formula: RRF_conf(d) = Σ w_i × score_i(d) / (k + rank_i(d))
 *
 * Unlike standard RRF which only uses ranks, this variant preserves
 * score magnitude: rank-1 with score 0.99 contributes more than
 * rank-1 with score 0.55.
 *
 * Reference: Cormack et al. (2009), extended with confidence weighting.
 */
export function fuseWithConfidenceRRF(
  signals: SearchSignalResult[][],
  k: number,
  weights: number[],
): FusedCandidate[] {
  if (signals.length !== weights.length) {
    throw new Error(
      `fuseWithConfidenceRRF: signals.length (${signals.length}) !== weights.length (${weights.length})`,
    );
  }
  // Build per-signal rank/score lookups
  const signalMaps: Map<string, SignalEntry>[] = signals.map((signal) => {
    const map = new Map<string, SignalEntry>();
    for (let i = 0; i < signal.length; i++) {
      const entry = signal[i];
      // If duplicate in same signal, keep first (higher ranked)
      if (!map.has(entry.id)) {
        map.set(entry.id, { rank: i + 1, score: entry.score });
      }
    }
    return map;
  });

  // Collect all unique candidate IDs with their metadata
  const candidateMetadata = new Map<
    string,
    {
      text: string;
      category: string;
      importance: number;
      createdAt: string;
      validFrom?: string;
      taskId?: string;
    }
  >();

  for (const signal of signals) {
    for (const entry of signal) {
      if (!candidateMetadata.has(entry.id)) {
        candidateMetadata.set(entry.id, {
          text: entry.text,
          category: entry.category,
          importance: entry.importance,
          createdAt: entry.createdAt,
          validFrom: entry.validFrom,
          taskId: entry.taskId,
        });
      }
    }
  }

  // Calculate confidence-weighted RRF score for each candidate
  const results: FusedCandidate[] = [];
  const NO_SIGNAL: SignalAttribution = { rank: 0, score: 0 };

  for (const [id, meta] of candidateMetadata) {
    let rrfScore = 0;

    for (let i = 0; i < signalMaps.length; i++) {
      const entry = signalMaps[i].get(id);
      if (entry && entry.rank > 0) {
        // Confidence-weighted: multiply by original score
        rrfScore += weights[i] * entry.score * (1 / (k + entry.rank));
      }
    }

    // Build per-signal attribution from the existing signal maps
    const signals = {
      vector: signalMaps[0]?.get(id) ?? NO_SIGNAL,
      bm25: signalMaps[1]?.get(id) ?? NO_SIGNAL,
      graph: signalMaps[2]?.get(id) ?? NO_SIGNAL,
      freshness: signalMaps[3]?.get(id) ?? NO_SIGNAL,
    };

    results.push({
      id,
      text: meta.text,
      category: meta.category,
      importance: meta.importance,
      createdAt: meta.createdAt,
      validFrom: meta.validFrom,
      rrfScore,
      taskId: meta.taskId,
      signals,
    });
  }

  // Sort by RRF score descending
  results.sort((a, b) => b.rrfScore - a.rrfScore);
  return results;
}

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
  } = {},
): Promise<HybridSearchResult[]> {
  // Guard against empty queries
  if (!query.trim()) {
    return [];
  }

  const {
    rrfK = 60,
    candidateMultiplier = 4,
    graphFiringThreshold = 0.3,
    graphSearchDepth = 2,
    graphSeedCap,
    graphRelTypes,
    logger,
    includeExpired = false,
    asOf,
    recencyWeight = 0.1,
    weightOverride,
    rerankerConfig,
    extractionConfig,
    metricsCollector = NO_OP_METRICS,
  } = options;

  // When reranking is active, fetch topK candidates before reranking; otherwise fetch limit*multiplier
  const rerankerActive = rerankerConfig?.enabled && rerankerConfig.provider !== "none";
  const candidateLimit = rerankerActive
    ? Math.floor(Math.min(200, Math.max(1, rerankerConfig!.topK ?? 10)))
    : Math.floor(Math.min(200, Math.max(1, limit * candidateMultiplier)));

  // 1. Generate query embedding
  const t0 = performance.now();
  const queryEmbedding = await embeddings.embed(query);
  const tEmbed = performance.now();

  // 2. Classify query and get adaptive weights (overridable for eval variants)
  const queryType = classifyQuery(query);
  const [vW, bW, gW, freshnessW] = weightOverride ?? getAdaptiveWeights(queryType, graphEnabled);
  const weights: [number, number, number, number] = [vW, bW, gW, freshnessW];

  // 3. Run signals in parallel — each gets its own session because Neo4j sessions
  //    don't support concurrent transactions (executeRead starts a transaction).
  const [vectorResults, bm25Results, graphResults] = await Promise.all([
    db.vectorSearch(queryEmbedding, candidateLimit, 0.1, agentId, includeExpired, asOf),
    db.bm25Search(query, candidateLimit, agentId, includeExpired, asOf),
    graphEnabled
      ? db.graphSearch(
          query,
          candidateLimit,
          graphFiringThreshold,
          agentId,
          graphSearchDepth,
          includeExpired,
          asOf,
          graphSeedCap,
          graphRelTypes,
        )
      : Promise.resolve([] as SearchSignalResult[]),
  ]);
  const tSignals = performance.now();

  // 4. Build temporal freshness signal from validFrom dates across all candidates (OP-129).
  //    Only candidates where validFrom differs from createdAt by >7 days participate.
  const now = Date.now();
  const freshnessSignal = buildFreshnessSignal(
    [...vectorResults, ...bm25Results, ...graphResults],
    now,
  );

  // 5. Fuse all signals with confidence-weighted RRF (freshness is the 4th signal).
  const fused = fuseWithConfidenceRRF(
    [vectorResults, bm25Results, graphResults, freshnessSignal],
    rrfK,
    weights,
  );
  const tFuse = performance.now();

  // 6. Apply recency as a multiplicative boost (OP-121).
  //    recencyScore = exp(-daysSince / 365) — 1-year half-life
  //    boostedScore = rrfScore * (1 + recencyWeight * recencyScore)
  //    Then normalize to 0-1 range.
  const candidates = fused.slice(0, limit).map((r) => {
    const ageDays = r.createdAt
      ? (now - new Date(r.createdAt).getTime()) / (1000 * 60 * 60 * 24)
      : 365; // default to 1 year if no createdAt
    const recencyScore = Math.exp(-ageDays / 365);
    const boostedScore = r.rrfScore * (1 + recencyWeight * recencyScore);
    return { ...r, recencyScore, boostedScore };
  });

  // Re-sort by boosted score (recency boost may reorder vs pure RRF)
  candidates.sort((a, b) => b.boostedScore - a.boostedScore);

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
    score: Math.min(1, r.boostedScore * normalizer),
    taskId: r.taskId,
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
  } else {
    // No reranker: apply abstention based on normalized RRF score (OP-131).
    // Only abstain when top score is below threshold — use lowConfidence as an additional gate
    // so we don't suppress results for clearly relevant queries with single-signal matches.
    const abstentionThreshold = rerankerConfig?.abstentionThreshold ?? 0;
    if (abstentionThreshold > 0 && finalResults.length > 0) {
      const topScore = finalResults[0].score;
      if (topScore < abstentionThreshold) {
        logger?.info(
          `memory-neo4j: [abstention] score=${topScore.toFixed(3)} below threshold=${abstentionThreshold}, returning empty`,
        );
        metricsCollector.increment("reranker.abstentions");
        finalResults = [];
      }
    }
  }

  // 6. Record retrieval events (fire-and-forget for latency)
  // This tracks which memories are actually being used, enabling
  // retrieval-based importance adjustment.
  if (finalResults.length > 0) {
    const memoryIds = finalResults.map((r) => r.id);
    db.recordRetrievals(memoryIds).catch((err) => {
      logger?.debug?.(
        `memory-neo4j: recordRetrievals failed (non-critical): ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  // Log search timing breakdown
  const recencyStr = recencyWeight !== 0.1 ? ` recencyWeight=${recencyWeight}` : "";
  const asOfStr = asOf ? ` asOf=${asOf}` : "";
  const lowConfStr = lowConfidence ? " lowConf=true" : "";
  const rerankerStr = rerankerActive ? ` reranker=${rerankerConfig?.provider}` : "";
  logger?.info?.(
    `memory-neo4j: [bench] hybridSearch ${(tFuse - t0).toFixed(0)}ms (embed=${(tEmbed - t0).toFixed(0)}ms, signals=${(tSignals - tEmbed).toFixed(0)}ms, fuse=${(tFuse - tSignals).toFixed(0)}ms) ` +
      `type=${queryType} vec=${vectorResults.length} bm25=${bm25Results.length} graph=${graphResults.length} freshness=${freshnessSignal.length} → ${finalResults.length} results${recencyStr}${asOfStr}${lowConfStr}${rerankerStr}`,
  );

  return finalResults;
}
