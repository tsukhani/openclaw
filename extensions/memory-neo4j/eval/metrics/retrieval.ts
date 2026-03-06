/**
 * Retrieval quality metrics for the eval harness.
 *
 * Implements: Precision@K, Recall@K, F1@K, MRR (Mean Reciprocal Rank), NDCG@K
 *
 * All metrics are computed per-case first, then aggregated across cases.
 */

import type {
  AbilityMetrics,
  CaseRetrievalMetrics,
  MemoryAbility,
  RetrievedMemory,
} from "../types.js";

/**
 * Compute retrieval metrics for a single test case.
 *
 * @param caseId - Test case ID
 * @param ability - Memory ability category
 * @param question - The search query
 * @param retrieved - Retrieved memories (in rank order)
 * @param goldIds - Gold set of memory IDs that should be retrieved
 * @param k - Retrieval cutoff
 */
export function computeCaseMetrics(
  caseId: string,
  ability: MemoryAbility,
  question: string,
  retrieved: RetrievedMemory[],
  goldIds: string[],
  k: number,
): CaseRetrievalMetrics {
  const topK = retrieved.slice(0, k);
  const retrievedIds = new Set(topK.map((r) => r.id));
  const goldSet = new Set(goldIds);

  // Abstention cases have empty gold sets — retrieval metrics are N/A
  // Convention: treat 0 gold IDs as "anything retrieved is wrong" for precision,
  // but recall = 1.0 (nothing to recall) and F1 = 0.
  if (goldSet.size === 0) {
    return {
      caseId,
      ability,
      question,
      retrieved: topK,
      goldIds,
      hitsAtK: 0,
      precisionAtK: 0,
      recallAtK: 1.0, // nothing to recall → vacuously true
      f1AtK: 0,
      firstRelevantRank: 0,
      reciprocalRank: 0,
      ndcgAtK: 0,
    };
  }

  // Count hits: how many gold memories appear in top-K
  const hits = topK.filter((r) => goldSet.has(r.id)).length;

  const precisionAtK = hits / k;
  const recallAtK = hits / goldSet.size;
  const f1AtK =
    precisionAtK + recallAtK > 0 ? (2 * precisionAtK * recallAtK) / (precisionAtK + recallAtK) : 0;

  // MRR: rank of first relevant result (across full retrieved list, not just topK)
  let firstRelevantRank = 0;
  for (let i = 0; i < retrieved.length; i++) {
    if (goldSet.has(retrieved[i].id)) {
      firstRelevantRank = i + 1; // 1-indexed
      break;
    }
  }
  const reciprocalRank = firstRelevantRank > 0 ? 1 / firstRelevantRank : 0;

  // NDCG@K: Normalized Discounted Cumulative Gain
  // Relevance is binary (1 if in gold set, 0 otherwise)
  let dcg = 0;
  for (let i = 0; i < topK.length; i++) {
    const rel = goldSet.has(topK[i].id) ? 1 : 0;
    dcg += rel / Math.log2(i + 2); // log2(rank + 1), rank is 0-indexed
  }

  // IDCG: ideal DCG — top min(|gold|, K) results are all relevant
  const idealHits = Math.min(goldSet.size, k);
  let idcg = 0;
  for (let i = 0; i < idealHits; i++) {
    idcg += 1 / Math.log2(i + 2);
  }

  const ndcgAtK = idcg > 0 ? dcg / idcg : 0;

  return {
    caseId,
    ability,
    question,
    retrieved: topK,
    goldIds,
    hitsAtK: hits,
    precisionAtK,
    recallAtK,
    f1AtK,
    firstRelevantRank,
    reciprocalRank,
    ndcgAtK,
  };
}

/**
 * Aggregate per-case metrics into per-ability averages.
 */
export function aggregateByAbility(cases: CaseRetrievalMetrics[]): AbilityMetrics[] {
  const byAbility = new Map<MemoryAbility, CaseRetrievalMetrics[]>();

  for (const c of cases) {
    const list = byAbility.get(c.ability) ?? [];
    list.push(c);
    byAbility.set(c.ability, list);
  }

  const result: AbilityMetrics[] = [];
  for (const [ability, abilityCases] of byAbility) {
    result.push(aggregateMetrics(ability, abilityCases));
  }

  return result;
}

/**
 * Compute per-ability aggregate from a list of case metrics.
 */
export function aggregateMetrics(
  ability: MemoryAbility,
  cases: CaseRetrievalMetrics[],
): AbilityMetrics {
  if (cases.length === 0) {
    return {
      ability,
      caseCount: 0,
      avgPrecisionAtK: 0,
      avgRecallAtK: 0,
      avgF1AtK: 0,
      avgMRR: 0,
      avgNDCG: 0,
      hitRate: 0,
    };
  }

  const n = cases.length;
  const avg = (fn: (c: CaseRetrievalMetrics) => number) =>
    cases.reduce((sum, c) => sum + fn(c), 0) / n;

  return {
    ability,
    caseCount: n,
    avgPrecisionAtK: avg((c) => c.precisionAtK),
    avgRecallAtK: avg((c) => c.recallAtK),
    avgF1AtK: avg((c) => c.f1AtK),
    avgMRR: avg((c) => c.reciprocalRank),
    avgNDCG: avg((c) => c.ndcgAtK),
    hitRate: cases.filter((c) => c.hitsAtK > 0).length / n,
  };
}

/**
 * Compute overall aggregate from all cases (across abilities).
 */
export function aggregateOverall(cases: CaseRetrievalMetrics[]): EvalRunResult["overall"] {
  const metrics = aggregateMetrics("extraction" as MemoryAbility, cases);
  return {
    caseCount: metrics.caseCount,
    avgPrecisionAtK: metrics.avgPrecisionAtK,
    avgRecallAtK: metrics.avgRecallAtK,
    avgF1AtK: metrics.avgF1AtK,
    avgMRR: metrics.avgMRR,
    avgNDCG: metrics.avgNDCG,
    hitRate: metrics.hitRate,
  };
}

// Import needed for return type
import type { EvalRunResult } from "../types.js";
