/**
 * Named search config variants for A/B evaluation testing.
 *
 * Each variant defines overrides applied to the hybridSearch call during eval.
 * The 'default' variant leaves all settings at their configured values.
 */

// ============================================================================
// SearchConfig — subset of hybridSearch options relevant to eval variants
// ============================================================================

import type { RerankerConfig } from "../schema.js";

export type SearchConfig = {
  /** Override whether graph search is enabled. Default: derived from extractionConfig. */
  graphEnabled?: boolean;
  /** Override adaptive vector weight (0 = disabled). Default: adaptive. */
  vectorWeight?: number;
  /** Override adaptive BM25 weight (0 = disabled). Default: adaptive. */
  bm25Weight?: number;
  /** Override max seed entities for graph search. Default: cfg.graphSeedCap. */
  graphSeedCap?: number;
  /** Override graph traversal depth. Default: cfg.graphSearchDepth. */
  graphDepthLimit?: number;
  /** False = disable recency boost (recencyWeight → 0). Default: enabled. */
  temporalRecencyEnabled?: boolean;
  /** Multiply recencyWeight by this factor. Default: 1.0. */
  temporalRecencyBoost?: number;
  /** Override freshness (validFrom) signal weight (0 = disable OP-129 signal). Default: 0.2. */
  freshnessWeight?: number;
  /** Reranker config overrides for this variant. Default: from plugin config. */
  reranker?: Partial<RerankerConfig>;
};

// ============================================================================
// Built-in variants
// ============================================================================

export const EVAL_VARIANTS: Record<string, Partial<SearchConfig>> = {
  /** All signals enabled with default adaptive weights. */
  default: {},
  /** Disable graph search; vector + BM25 only. */
  "no-graph": { graphEnabled: false },
  /** Vector signal only (BM25 weight = 0, graph disabled). */
  "vector-only": { graphEnabled: false, bm25Weight: 0 },
  /** BM25 signal only (vector weight = 0, graph disabled). */
  "bm25-only": { graphEnabled: false, vectorWeight: 0 },
  /** Deeper graph traversal with more seed entities. */
  "high-graph": { graphSeedCap: 10, graphDepthLimit: 3 },
  /** Best-case lancedb: vec + BM25 + recency. No graph, no validFrom freshness. */
  "lancedb-best": { graphEnabled: false, freshnessWeight: 0 },
  /** Current lancedb impl: vec + recency only. No BM25, no graph, no validFrom. */
  "lancedb-current": { graphEnabled: false, bm25Weight: 0, freshnessWeight: 0 },
  /** memory-core proxy (OpenClaw default floor): vec only, no other signals. */
  "memory-core-proxy": {
    graphEnabled: false,
    bm25Weight: 0,
    freshnessWeight: 0,
    temporalRecencyEnabled: false,
  },
  /** Disable recency boost entirely. */
  "no-temporal": { temporalRecencyEnabled: false },
  /** Double the recency boost weight. */
  "high-temporal": { temporalRecencyBoost: 2.0 },
  /** Local ONNX cross-encoder reranker enabled (OP-130). Fetches topK=10, returns topJ=5.
   *  Abstention threshold 0.95 (OP-131): returns empty when top cross-encoder score < 0.95.
   *  Not applied to temporal/LLM-reranked queries (those score 0.8–0.9 on comparison queries).
   *  Cross-encoder scores for direct answers are 0.997+; abstention cases score 0.002–0.94. */
  "with-reranker-local": {
    reranker: {
      enabled: true,
      provider: "local" as const,
      topK: 10,
      topJ: 5,
      abstentionThreshold: 0.95,
    },
  },
};

/**
 * Resolve a variant by name, throwing on unknown names.
 */
export function resolveVariant(name: string): Partial<SearchConfig> {
  const variant = EVAL_VARIANTS[name];
  if (variant === undefined) {
    throw new Error(
      `Unknown eval variant: "${name}". Available variants: ${Object.keys(EVAL_VARIANTS).join(", ")}`,
    );
  }
  return variant;
}
