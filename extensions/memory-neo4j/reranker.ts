/**
 * Cross-encoder reranker dispatcher (OP-130).
 *
 * Routes rerank calls to the appropriate provider based on query type:
 * - Temporal/update queries → LLM reranker with timestamp context (understands recency)
 * - All other queries → local cross-encoder (fast, semantic relevance)
 * - Falls back gracefully on any error — retrieval is never broken.
 */

import type { ExtractionConfig } from "./config.js";
import type { MetricsCollector } from "./metrics.js";
import type { HybridSearchResult, Logger, RerankerConfig } from "./schema.js";
import type { QueryType } from "./search.js";

/** Keyword pattern that identifies temporal/update queries. */
const TEMPORAL_QUERY_RE =
  /\b(when|since|before|after|changed|previously|used to|first|last|latest|recent|current|now|at the time|history|version|updated|update|currently)\b/i;

/** Returns true when the query is about recency or knowledge updates. */
export function isTemporalQuery(query: string, queryType?: QueryType): boolean {
  return queryType === "updates" || TEMPORAL_QUERY_RE.test(query);
}

/**
 * Rerank and filter `candidates` using the configured provider.
 *
 * Routing logic:
 * - Temporal/update queries always use the LLM reranker (with timestamps) — cross-encoders
 *   trained on web passage retrieval cannot reason about recency/supersession.
 * - All other queries use the local cross-encoder HTTP service (fast, ~100ms).
 * - provider="llm" forces LLM reranker regardless of query type.
 * - provider="none" or enabled=false: returns candidates unchanged.
 * - Any provider error: logs warning, returns original order (graceful degradation).
 *
 * @param query - Original search query string.
 * @param candidates - Pre-ranked candidate results from hybridSearch.
 * @param config - Reranker configuration.
 * @param extractionConfig - LLM config used for temporal LLM reranking.
 * @param logger - Logger for warnings/info (nullable for eval harness).
 * @param metricsCollector - Metrics collector for counters and latency.
 * @param signal - Optional AbortSignal.
 * @param queryType - Pre-classified query type (used for temporal routing).
 * @returns Reranked (and possibly filtered/truncated) candidates.
 */
export async function rerankCandidates(
  query: string,
  candidates: HybridSearchResult[],
  config: RerankerConfig,
  extractionConfig: ExtractionConfig | null | undefined,
  logger: Logger | null | undefined,
  metricsCollector: MetricsCollector,
  signal?: AbortSignal,
  queryType?: QueryType,
): Promise<HybridSearchResult[]> {
  if (!config.enabled || config.provider === "none" || candidates.length === 0) {
    return candidates;
  }

  const t0 = Date.now();
  const temporal = isTemporalQuery(query, queryType);

  try {
    const model = config.model ?? "cross-encoder/ms-marco-MiniLM-L-6-v2";

    let rerankResults: Array<{ index: number; relevanceScore: number }>;

    // Determine routing for extraction queries (OP-138).
    // extractionMode governs: "local" (default) | "llm-temporal" | "auto"
    const extractionMode = config.extractionMode ?? "local";
    const isExtractionQuery = queryType === "extraction";

    // Route temporal/update queries to LLM reranker with timestamp context.
    // Cross-encoders can't reason about recency — LLM can with date metadata.
    // Exception: short/entity/updates queries always use cross-encoder — "updates" queries
    //   are triggered by common words like "new", "current", "latest" which frequently appear
    //   in non-temporal contexts (e.g. session startup messages). The LLM reranker adds
    //   1-2.5s of API latency per call; the local cross-encoder handles these in ~20ms.
    //   True temporal reasoning (date comparisons, supersession) is still handled by the
    //   freshness signal in RRF fusion + the temporal freshness boost in search.ts.
    // Exception: extraction queries route based on extractionMode (default: local cross-encoder).
    const forceCrossEncoder =
      queryType === "short" ||
      queryType === "entity" ||
      queryType === "updates" ||
      (isExtractionQuery && extractionMode === "local");
    const forceLlm = isExtractionQuery && extractionMode === "llm-temporal";

    if (!forceCrossEncoder && (forceLlm || config.provider === "llm" || temporal)) {
      const { llmRerank } = await import("./reranker-llm.js");
      const candidatesWithDates = candidates.map((c) => ({
        text: c.text,
        createdAt: c.createdAt,
        validFrom: c.validFrom,
      }));
      rerankResults = await llmRerank(
        query,
        candidatesWithDates,
        extractionConfig ?? undefined,
        temporal,
        signal,
      );
    } else {
      // Local cross-encoder HTTP service (port 4124) — used for extraction queries by default (OP-138)
      const { localRerank } = await import("./reranker-local.js");
      const documents = candidates.map((c) => c.text);
      rerankResults = await localRerank(query, documents, model, signal);
    }

    // Map rerank scores back onto candidates using weighted interpolation.
    // Instead of replacing the RRF score entirely, blend it with the reranker score:
    //   finalScore = alpha * rrfScore + (1 - alpha) * rerankScore
    // This preserves multi-signal RRF ranking information when the cross-encoder
    // produces saturated scores (0.999+) that destroy discrimination.
    //
    // Score saturation fix: when all reranker scores are compressed into a narrow
    // range (e.g. 0.995-0.999), the tiny differences get washed out by the RRF
    // component. Re-normalize reranker scores via min-max scaling within the batch
    // so the cross-encoder's relative ordering is preserved during blending.
    const alpha = Math.max(0, Math.min(1, config.rrfWeight ?? 0.2));
    const validResults = rerankResults.filter(
      ({ index }) => index >= 0 && index < candidates.length,
    );

    // Score saturation fix: ms-marco cross-encoders often produce scores compressed
    // near 1.0 for related documents (e.g. 0.995-0.999). Min-max re-normalization
    // spreads these to [0,1] so the cross-encoder's relative ordering survives blending.
    //
    // Always re-normalize: the cross-encoder's absolute scores are model-dependent
    // and not calibrated for interpolation with RRF scores. Min-max normalization
    // ensures the reranker component has full [0,1] dynamic range regardless of
    // whether scores are saturated or spread out.
    const rerankScores = validResults.map((r) => r.relevanceScore);
    const rerankMin = Math.min(...rerankScores);
    const rerankMax = Math.max(...rerankScores);
    const rerankRange = rerankMax - rerankMin;

    // Adaptive alpha: when the cross-encoder shows clear differentiation (wide score
    // spread), trust it more by capping alpha low. When scores are compressed
    // (ambiguous), lean on RRF with the configured alpha. This prevents a large RRF
    // gap from overriding a clear cross-encoder preference while preserving RRF
    // as a safety net when the cross-encoder is uncertain.
    const effectiveAlpha = rerankRange > 0.05 ? Math.min(alpha, 0.01) : alpha;

    const reranked: HybridSearchResult[] = validResults.map(({ index, relevanceScore }) => {
      const candidate = candidates[index];
      const normalizedRerank = rerankRange > 0 ? (relevanceScore - rerankMin) / rerankRange : 0.5;
      const blended = effectiveAlpha * candidate.score + (1 - effectiveAlpha) * normalizedRerank;
      const result: HybridSearchResult = Object.assign({}, candidate, {
        rerankScore: relevanceScore,
        rrfScore: candidate.score,
        score: blended,
      });
      return result;
    });

    reranked.sort((a, b) => b.score - a.score);

    const minScore = config.minScore ?? 0;
    const filtered =
      minScore > 0 ? reranked.filter((r) => (r.rerankScore ?? 0) >= minScore) : reranked;

    const topJ = config.topJ ?? candidates.length;
    const final = filtered.slice(0, topJ);

    const latencyMs = Date.now() - t0;
    metricsCollector.increment("reranker.calls");
    metricsCollector.histogram("reranker.latency", latencyMs);

    // M3: Derive providerUsed from the same branching logic that selected the actual provider.
    const providerUsed =
      forceCrossEncoder || (!forceLlm && config.provider !== "llm" && !temporal)
        ? "local"
        : "llm-temporal";
    logger?.info(
      `memory-neo4j: [reranker] provider=${providerUsed} alpha=${alpha.toFixed(2)} temporal=${temporal} extraction=${isExtractionQuery} candidates=${candidates.length} → ${final.length} in ${latencyMs}ms`,
    );

    return final;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger?.warn(`memory-neo4j: [reranker] error, falling back to original order: ${msg}`);
    metricsCollector.increment("reranker.errors");
    return candidates;
  }
}
