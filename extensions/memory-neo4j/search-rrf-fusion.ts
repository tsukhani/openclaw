/**
 * Confidence-weighted Reciprocal Rank Fusion (RRF) for hybrid search.
 *
 * Fuses multiple search signals using score-weighted RRF, preserving
 * score magnitude alongside rank position.
 *
 * Reference: Cormack et al. (2009), extended with confidence weighting.
 */

import type { SearchSignalResult, SignalAttribution, SignalProvenance } from "./schema.js";

// ============================================================================
// Signal Score Normalization
// ============================================================================

/**
 * Normalize signal scores to 0-1 range via max-scaling.
 *
 * Graph and community signals return raw Lucene fulltext scores (unbounded,
 * typically 0.5–5+) while vector (cosine) and BM25 are already in [0, 1].
 * Without normalization, the confidence-weighted RRF formula
 *   score += weight × signal_score / (k + rank)
 * lets unbounded signals dominate — a graph Entity at score 4.4 contributes
 * ~4× more than a vector Memory at score 0.92 per unit weight.
 *
 * Max-scaling divides all scores by the maximum so the top result gets 1.0
 * and the rest scale proportionally.
 */
export function normalizeSignalScores(results: SearchSignalResult[]): SearchSignalResult[] {
  if (results.length === 0) {
    return [];
  }
  const maxScore = results[0].score; // results are already sorted desc by score
  if (maxScore <= 0) {
    return results.map((r) => ({ ...r, score: 0 }));
  }
  return results.map((r) => ({ ...r, score: r.score / maxScore }));
}

// ============================================================================
// Confidence-Weighted RRF Fusion
// ============================================================================

export type SignalEntry = {
  rank: number; // 1-indexed
  score: number; // 0-1 normalized
  /** OP-200: Per-result provenance from this signal (when provenance tracking enabled). */
  provenance?: SignalProvenance;
};

export type FusedCandidate = {
  id: string;
  text: string;
  category: string;
  importance: number;
  createdAt: string;
  validFrom?: string;
  rrfScore: number;
  signals: {
    vector: SignalAttribution;
    bm25: SignalAttribution;
    graph: SignalAttribution;
    freshness: SignalAttribution;
    community: SignalAttribution;
    mpfp: SignalAttribution;
    observation: SignalAttribution;
    opinion?: SignalAttribution;
  };
  /** OP-200: Provenance records from all contributing signals. */
  provenance?: SignalProvenance[];
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
  // Build per-signal rank/score lookups (with provenance when present)
  const signalMaps: Map<string, SignalEntry>[] = signals.map((signal) => {
    const map = new Map<string, SignalEntry>();
    for (let i = 0; i < signal.length; i++) {
      const entry = signal[i];
      // If duplicate in same signal, keep first (higher ranked)
      if (!map.has(entry.id)) {
        map.set(entry.id, {
          rank: i + 1,
          score: entry.score,
          provenance: entry.provenance,
        });
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
      supersededBy?: string;
      trustScore?: number;
    }
  >();

  for (const signal of signals) {
    for (const entry of signal) {
      if (!candidateMetadata.has(entry.id)) {
        candidateMetadata.set(entry.id, {
          text: entry.text,
          category: entry.category,
          importance: Number.isFinite(entry.importance) ? entry.importance : 0.5,
          createdAt: entry.createdAt,
          validFrom: entry.validFrom,
          supersededBy: entry.supersededBy,
          trustScore: entry.trustScore,
        });
      }
    }
  }

  // Calculate confidence-weighted RRF score for each candidate
  const results: FusedCandidate[] = [];
  const NO_SIGNAL: SignalAttribution = { rank: 0, score: 0 };
  for (const [id, meta] of candidateMetadata) {
    let rrfScore = 0;
    // OP-200: Collect provenance from contributing signals.
    let provenance: SignalProvenance[] | undefined;

    for (let i = 0; i < signalMaps.length; i++) {
      const entry = signalMaps[i].get(id);
      if (entry && entry.rank > 0) {
        // Confidence-weighted: multiply by original score
        rrfScore += weights[i] * entry.score * (1 / (k + entry.rank));
        // OP-200: Collect provenance from this signal if present.
        if (entry.provenance) {
          provenance ??= [];
          provenance.push(entry.provenance);
        }
      }
    }

    // Build per-signal attribution from the existing signal maps
    const signals = {
      vector: signalMaps[0]?.get(id) ?? NO_SIGNAL,
      bm25: signalMaps[1]?.get(id) ?? NO_SIGNAL,
      graph: signalMaps[2]?.get(id) ?? NO_SIGNAL,
      freshness: signalMaps[3]?.get(id) ?? NO_SIGNAL,
      community: signalMaps[4]?.get(id) ?? NO_SIGNAL,
      mpfp: signalMaps[5]?.get(id) ?? NO_SIGNAL,
      observation: signalMaps[6]?.get(id) ?? NO_SIGNAL,
      opinion: signalMaps[7]?.get(id) ?? NO_SIGNAL,
    };

    // Apply trust score as multiplicative weight (default 1.0 = no change)
    const trustWeight = meta.trustScore ?? 1.0;
    const weightedRrfScore = rrfScore * trustWeight;

    results.push({
      id,
      text: meta.text,
      category: meta.category,
      importance: meta.importance,
      createdAt: meta.createdAt,
      validFrom: meta.validFrom,
      rrfScore: weightedRrfScore,
      signals,
      provenance,
    });
  }

  // Sort by RRF score descending
  results.sort((a, b) => b.rrfScore - a.rrfScore);
  return results;
}
