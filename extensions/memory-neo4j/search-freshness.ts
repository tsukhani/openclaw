/**
 * Temporal freshness signal and low-confidence detection for hybrid search (OP-129).
 *
 * Builds a synthetic freshness signal from candidate validFrom dates and
 * provides low-confidence result detection for search abstention.
 */

import type { HybridSearchResult, SearchSignalResult } from "./schema.js";

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

/** M26: Module-level constant for freshness signal threshold. */
export const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
/** Freshness decay period in days — exp(-daysSince / FRESHNESS_DECAY_DAYS). */
export const FRESHNESS_DECAY_DAYS = 365;
/** L3: Default RRF k parameter (rank smoothing constant). */
export const DEFAULT_RRF_K = 60;
/** L3: Default candidate multiplier for non-reranker path. */
export const DEFAULT_CANDIDATE_MULTIPLIER = 3;
/** L3: Recency decay period in days — same scale as freshness for consistency. */
export const RECENCY_DECAY_DAYS = 365;

/**
 * Build a synthetic freshness signal from candidate validFrom dates.
 *
 * Only includes candidates where validFrom differs from createdAt by more than
 * 7 days — i.e. the memory was explicitly back-dated or represents an update
 * to an earlier fact. Sorted by freshness score descending to create ranks for RRF.
 *
 * Freshness score: exp(-daysSince / 365) — decays over ~1 year.
 */
export function buildFreshnessSignal(
  candidates: SearchSignalResult[],
  now: number,
): SearchSignalResult[] {
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
    if (Number.isNaN(validFromMs)) continue; // M9: skip malformed date strings
    const createdAtMs = c.createdAt ? new Date(c.createdAt).getTime() : NaN;
    // M7: Skip when createdAt is missing/malformed — NaN comparison would bypass the 7-day guard
    if (Number.isNaN(createdAtMs)) continue;
    // Only apply freshness when validFrom was explicitly set to differ from createdAt
    if (Math.abs(validFromMs - createdAtMs) <= SEVEN_DAYS_MS) {
      continue;
    }

    const daysSince = (now - validFromMs) / (1000 * 60 * 60 * 24);
    // M1: Clamp to [0, 1] — future validFrom (daysSince < 0) would produce score > 1
    const freshnessScore = Math.min(1.0, Math.exp(-daysSince / FRESHNESS_DECAY_DAYS));
    withFreshness.push({ ...c, score: freshnessScore });
  }

  withFreshness.sort((a, b) => b.score - a.score);
  return withFreshness;
}
