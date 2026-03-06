/**
 * Named search config variants for A/B evaluation testing.
 *
 * Each variant defines overrides applied to the hybridSearch call during eval.
 * The 'default' variant leaves all settings at their configured values.
 */

// ============================================================================
// SearchConfig — subset of hybridSearch options relevant to eval variants
// ============================================================================

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
  /** Disable recency boost entirely. */
  "no-temporal": { temporalRecencyEnabled: false },
  /** Double the recency boost weight. */
  "high-temporal": { temporalRecencyBoost: 2.0 },
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
