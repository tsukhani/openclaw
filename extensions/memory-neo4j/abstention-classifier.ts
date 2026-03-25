/**
 * Abstention Classifier (OP-137)
 *
 * Feature-based classifier that decides whether a query has a retrievable answer
 * in the memory store. Replaces the fixed `abstentionThreshold` scalar with a
 * multi-signal decision that understands when low scores reflect genuinely absent
 * information vs. weak but valid matches.
 *
 * Features used:
 *   - maxScore: highest normalized score among candidates
 *   - meanScore: average normalized score
 *   - candidateCount: number of returned candidates
 *   - queryType: influences aggressiveness of the low-recall check
 *
 * No ML model needed — the retrieval signals themselves are strong enough
 * discriminators between answerable and unanswerable queries.
 */

/** Minimal shape needed by the classifier — avoids importing the full schema. */
export interface ScoredMemory {
  id: string;
  score: number;
}

/**
 * Decide whether to abstain from returning results for a query.
 *
 * Returns `true` (abstain / return empty) when the candidates look too weak
 * to be useful context — likely because the answer is not in the memory store.
 *
 * Thresholds (v1):
 *   - Empty candidate set → always abstain
 *   - maxScore < 0.35 AND meanScore < 0.25 → abstain (global low-confidence)
 *   - "long" query type with very few results AND maxScore < 0.5 → abstain
 *     (long queries matched by vector usually surface several candidates;
 *      <2 results with mediocre scores means the content is absent)
 *
 * @param candidates - Scored memory candidates (post-RRF, pre-delivery)
 * @param queryType  - Query classification from classifyQuery()
 */
export function shouldAbstain(candidates: ScoredMemory[], queryType: string): boolean {
  if (candidates.length === 0) {
    return true;
  }

  let maxScore = -Infinity;
  let sumScore = 0;
  for (const c of candidates) {
    if (c.score > maxScore) maxScore = c.score;
    sumScore += c.score;
  }
  const meanScore = sumScore / candidates.length;

  // Global low-confidence gate: both max and mean must be below threshold.
  // A single high-scoring match keeps this gate open even if others are weak.
  if (maxScore < 0.35 && meanScore < 0.25) {
    return true;
  }

  // Long queries matched by vector/semantic similarity should surface several
  // candidates if the content exists. Few results + mediocre top score = absent.
  if (queryType === "long" && candidates.length < 2 && maxScore < 0.5) {
    return true;
  }

  return false;
}
