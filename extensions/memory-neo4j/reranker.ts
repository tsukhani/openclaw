/**
 * Cross-encoder reranker dispatcher (OP-130).
 *
 * Routes rerank calls to either the local ONNX provider or the LLM fallback,
 * based on `RerankerConfig.provider`. Always degrades gracefully — retrieval
 * is never broken by a reranker failure.
 */

import type { ExtractionConfig } from "./config.js";
import type { MetricsCollector } from "./metrics.js";
import type { HybridSearchResult, Logger, RerankerConfig } from "./schema.js";

/**
 * Rerank and filter `candidates` using the configured provider.
 *
 * Behaviour:
 * - If `config.enabled === false` or `provider === "none"`: returns candidates unchanged.
 * - On any provider error: logs a warning, increments `reranker.errors`, returns unchanged.
 * - On success: sets `rerankScore`, preserves original score as `rrfScore`,
 *   sorts descending, applies `minScore` filter, truncates to `topJ`.
 *
 * @param query - Original search query string.
 * @param candidates - Pre-ranked candidate results from hybridSearch.
 * @param config - Reranker configuration.
 * @param extractionConfig - LLM config used when provider is "llm".
 * @param logger - Logger for warnings/info.
 * @param metricsCollector - Metrics collector for counters and latency.
 * @param signal - Optional AbortSignal.
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
): Promise<HybridSearchResult[]> {
  if (!config.enabled || config.provider === "none" || candidates.length === 0) {
    return candidates;
  }

  const t0 = Date.now();

  try {
    const documents = candidates.map((c) => c.text);
    const model = config.model ?? "cross-encoder/ms-marco-MiniLM-L-6-v2";

    // Dispatch to the chosen provider
    let rerankResults: Array<{ index: number; relevanceScore: number }>;

    if (config.provider === "llm") {
      const { llmRerank } = await import("./reranker-llm.js");
      rerankResults = await llmRerank(query, documents, extractionConfig ?? undefined, signal);
    } else {
      // Default: local ONNX
      const { localRerank } = await import("./reranker-local.js");
      rerankResults = await localRerank(query, documents, model, signal);
    }

    // Map scores back onto candidates: set rerankScore, preserve rrfScore
    const reranked: HybridSearchResult[] = rerankResults.map(({ index, relevanceScore }) => {
      const candidate = candidates[index];
      return {
        ...candidate,
        rerankScore: relevanceScore,
        rrfScore: candidate.score,
        score: relevanceScore,
      };
    });

    // Sort descending by rerank score (already sorted by rerankResults, but map may lose order)
    reranked.sort((a, b) => (b.rerankScore ?? 0) - (a.rerankScore ?? 0));

    // Apply minScore filter
    const minScore = config.minScore ?? 0;
    const filtered =
      minScore > 0 ? reranked.filter((r) => (r.rerankScore ?? 0) >= minScore) : reranked;

    // Truncate to topJ
    const topJ = config.topJ ?? candidates.length;
    const final = filtered.slice(0, topJ);

    const latencyMs = Date.now() - t0;
    metricsCollector.increment("reranker.calls");
    metricsCollector.histogram("reranker.latency", latencyMs);

    logger?.info(
      `memory-neo4j: [reranker] provider=${config.provider} candidates=${candidates.length} → ${final.length} in ${latencyMs}ms`,
    );

    return final;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger?.warn(
      `memory-neo4j: [reranker] error (${config.provider}), falling back to original order: ${msg}`,
    );
    metricsCollector.increment("reranker.errors");
    return candidates;
  }
}
