/**
 * Abstention Classifier (OP-137, OP-191)
 *
 * Feature-based classifier that decides whether a query has a retrievable answer
 * in the memory store. Uses raw (pre-normalization) RRF scores as an absolute
 * confidence signal plus score distribution analysis on normalized scores.
 *
 * OP-191 fix: v1 thresholds were ineffective because final scores are
 * max-normalized (top result always ≈ 1.0). v2 adds:
 *   - rawMaxScore: pre-normalization max boosted RRF score (absolute confidence)
 *   - Score clustering detection: when top-k scores are tightly packed,
 *     no single result stands out — hallmark of distractor-only retrieval.
 *
 * No ML model needed — the retrieval signals themselves are strong enough
 * discriminators between answerable and unanswerable queries.
 */

/** Minimal shape needed by the classifier — avoids importing the full schema. */
export interface ScoredMemory {
  id: string;
  score: number;
}

// ---------------------------------------------------------------------------
// Thresholds (v2)
// ---------------------------------------------------------------------------

/**
 * Absolute RRF floor: below this raw score, retrieval confidence is too low
 * to trust any result. Calibrated for confidence-weighted RRF with k=60.
 *
 * Typical raw RRF scores:
 *   - Strong match (high vector + BM25): 0.05–0.2+
 *   - Weak/distractor match: 0.005–0.03
 */
export const RAW_SCORE_FLOOR = 0.008;

/**
 * Soft ceiling for score-clustering gate: when rawMaxScore is below this AND
 * scores are tightly clustered, abstain. Above this threshold, clustering alone
 * doesn't trigger abstention (multiple genuinely relevant results can cluster).
 */
export const RAW_SCORE_SOFT_CEIL = 0.04;

/**
 * Score clustering threshold: if the second-highest normalized score is above
 * this fraction of the max (i.e., results are tightly packed), the result set
 * likely contains only distractors with no clear standout match.
 */
export const CLUSTER_RATIO_THRESHOLD = 0.9;

/**
 * Decide whether to abstain from returning results for a query.
 *
 * Returns `true` (abstain / return empty) when the candidates look too weak
 * to be useful context — likely because the answer is not in the memory store.
 *
 * Decision gates (v2):
 *   1. Empty candidate set → always abstain
 *   2. rawMaxScore < RAW_SCORE_FLOOR → abstain (absolute confidence too low)
 *   3. rawMaxScore < RAW_SCORE_SOFT_CEIL AND scores clustered → abstain
 *      (moderate confidence + no standout = likely absent content)
 *   4. "long" query type with < 2 results AND weak scores → abstain
 *
 * @param candidates  - Scored memory candidates (post-RRF normalization)
 * @param queryType   - Query classification from classifyQuery()
 * @param rawMaxScore - Pre-normalization max boosted RRF score (absolute confidence).
 *                      When undefined, falls back to v1 normalized-score-only checks.
 */
export function shouldAbstain(
  candidates: ScoredMemory[],
  queryType: string,
  rawMaxScore?: number,
): boolean {
  if (candidates.length === 0) {
    return true;
  }

  // Compute normalized score statistics
  let maxScore = -Infinity;
  let sumScore = 0;
  for (const c of candidates) {
    if (c.score > maxScore) maxScore = c.score;
    sumScore += c.score;
  }
  const meanScore = sumScore / candidates.length;

  // Gate 1: Absolute confidence floor (OP-191).
  // Raw RRF score reflects true retrieval strength before max-normalization
  // erases it. Very low raw scores mean no signal found a strong match.
  if (rawMaxScore !== undefined && rawMaxScore < RAW_SCORE_FLOOR) {
    return true;
  }

  // Gate 2: Score clustering + moderate absolute confidence (OP-191).
  // When top-k results have tightly packed normalized scores AND the raw
  // confidence is only moderate, no single result stands out — the system
  // is returning the "least bad" distractors rather than a genuine match.
  if (rawMaxScore !== undefined && rawMaxScore < RAW_SCORE_SOFT_CEIL && candidates.length >= 2) {
    // Sort descending to get top-2 scores reliably
    const sorted = candidates.map((c) => c.score).sort((a, b) => b - a);
    const secondRatio = sorted[1] / sorted[0];
    if (secondRatio > CLUSTER_RATIO_THRESHOLD) {
      return true;
    }
  }

  // Gate 3 (v1 preserved): Global low-confidence on normalized scores.
  // Still useful when rawMaxScore is not provided (backward compat).
  if (maxScore < 0.35 && meanScore < 0.25) {
    return true;
  }

  // Gate 4 (v1 preserved): Long queries with very few weak results.
  if (queryType === "long" && candidates.length < 2 && maxScore < 0.5) {
    return true;
  }

  return false;
}
