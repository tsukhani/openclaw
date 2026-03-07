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

    // Route temporal/update queries to LLM reranker with timestamp context.
    // Cross-encoders can't reason about recency — LLM can with date metadata.
    // Exception: extraction/short/entity queries always use cross-encoder (LLM adds noise for simple fact lookups).
    const forceCrossEncoder = queryType === "short" || queryType === "entity";
    if (!forceCrossEncoder && (config.provider === "llm" || temporal)) {
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
      // Local cross-encoder HTTP service (port 4124)
      const { localRerank } = await import("./reranker-local.js");
      const documents = candidates.map((c) => c.text);
      rerankResults = await localRerank(query, documents, model, signal);
    }

    // Map rerank scores back onto candidates
    const reranked: HybridSearchResult[] = rerankResults.map(({ index, relevanceScore }) => {
      const candidate = candidates[index];
      return {
        ...candidate,
        rerankScore: relevanceScore,
        rrfScore: candidate.score,
        score: relevanceScore,
      };
    });

    reranked.sort((a, b) => (b.rerankScore ?? 0) - (a.rerankScore ?? 0));

    const minScore = config.minScore ?? 0;
    const filtered =
      minScore > 0 ? reranked.filter((r) => (r.rerankScore ?? 0) >= minScore) : reranked;

    const topJ = config.topJ ?? candidates.length;
    const sliced = filtered.slice(0, topJ);

    // Abstention filter (OP-131): if top result score is below threshold, return empty
    // rather than injecting low-confidence noise into context.
    // Skip for temporal/LLM-reranked queries — the LLM reranker assigns moderate scores
    // (0.8–0.9) to comparison-type queries where multiple memories are jointly relevant,
    // so a score threshold would incorrectly suppress valid results on those paths.
    const abstentionThreshold = config.abstentionThreshold ?? 0;
    if (abstentionThreshold > 0 && sliced.length > 0 && !temporal) {
      const topScore = sliced[0].rerankScore ?? 0;
      if (topScore < abstentionThreshold) {
        const latencyMs = Date.now() - t0;
        metricsCollector.increment("reranker.calls");
        metricsCollector.increment("reranker.abstentions");
        metricsCollector.histogram("reranker.latency", latencyMs);
        logger?.info(
          `memory-neo4j: [abstention] score=${topScore.toFixed(3)} below threshold=${abstentionThreshold}, returning empty`,
        );
        return [];
      }
    }

    const final = sliced;

    const latencyMs = Date.now() - t0;
    metricsCollector.increment("reranker.calls");
    metricsCollector.histogram("reranker.latency", latencyMs);

    const providerUsed = config.provider === "llm" || temporal ? "llm-temporal" : "local";
    logger?.info(
      `memory-neo4j: [reranker] provider=${providerUsed} temporal=${temporal} candidates=${candidates.length} → ${final.length} in ${latencyMs}ms`,
    );

    return final;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger?.warn(`memory-neo4j: [reranker] error, falling back to original order: ${msg}`);
    metricsCollector.increment("reranker.errors");
    return candidates;
  }
}
