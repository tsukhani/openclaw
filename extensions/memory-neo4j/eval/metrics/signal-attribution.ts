/**
 * Signal attribution statistics for the eval harness.
 *
 * Analyses which search signals (vector, BM25, graph) contributed to finding
 * gold memories, and measures how much RRF fusion improves rank over any
 * individual signal.
 */

import type { CaseRetrievalMetrics, SignalAttributionStats } from "../types.js";

/**
 * Determine which signals contributed to a retrieved memory.
 * A signal contributed if its score > 0 (it appeared in that signal's results).
 */
function activeSignals(signals: {
  vector?: { rank: number; score: number };
  bm25?: { rank: number; score: number };
  graph?: { rank: number; score: number };
}): Set<"vector" | "bm25" | "graph"> {
  const active = new Set<"vector" | "bm25" | "graph">();
  if (signals.vector && signals.vector.score > 0) active.add("vector");
  if (signals.bm25 && signals.bm25.score > 0) active.add("bm25");
  if (signals.graph && signals.graph.score > 0) active.add("graph");
  return active;
}

/**
 * Best single-signal rank for a memory — the smallest (best) rank across all
 * signals that found it. Returns Infinity if no signal found it.
 */
function bestSingleSignalRank(signals: {
  vector?: { rank: number; score: number };
  bm25?: { rank: number; score: number };
  graph?: { rank: number; score: number };
}): number {
  let best = Infinity;
  if (signals.vector && signals.vector.rank > 0) best = Math.min(best, signals.vector.rank);
  if (signals.bm25 && signals.bm25.rank > 0) best = Math.min(best, signals.bm25.rank);
  if (signals.graph && signals.graph.rank > 0) best = Math.min(best, signals.graph.rank);
  return best;
}

/**
 * Compute signal attribution statistics from a list of per-case retrieval metrics.
 *
 * For each case, looks at the retrieved memories that appear in the gold set
 * and records which signals found them. This answers: "when a gold memory was
 * retrieved, was it due to vector, BM25, graph, or multiple signals?"
 *
 * rrfUplift is the fraction of multi-signal gold hits where the final fused
 * rank is better than the best individual signal rank — confirming RRF adds value.
 */
export function computeSignalAttributionStats(
  cases: CaseRetrievalMetrics[],
): SignalAttributionStats {
  let vectorOnly = 0;
  let bm25Only = 0;
  let graphOnly = 0;
  let multiSignal = 0;
  let total = 0;

  // For RRF uplift: count multi-signal hits where fused rank < best single rank
  let multiSignalWithUplift = 0;

  for (const c of cases) {
    const goldSet = new Set(c.goldIds);

    for (const mem of c.retrieved) {
      if (!goldSet.has(mem.id)) continue;
      total++;

      if (!mem.signals) {
        // No signal info available — count as multi-signal (fused without attribution)
        multiSignal++;
        continue;
      }

      const active = activeSignals(mem.signals);
      const count = active.size;

      if (count === 0) {
        // Retrieved without a signal score (edge case — treat as multi-signal)
        multiSignal++;
      } else if (count === 1) {
        if (active.has("vector")) vectorOnly++;
        else if (active.has("bm25")) bm25Only++;
        else graphOnly++;
      } else {
        multiSignal++;
        // Check RRF uplift: fused rank (mem.rank) vs best single-signal rank
        const bestSingle = bestSingleSignalRank(mem.signals);
        if (mem.rank < bestSingle) {
          multiSignalWithUplift++;
        }
      }
    }
  }

  const rrfUplift = multiSignal > 0 ? multiSignalWithUplift / multiSignal : 0;

  return {
    total,
    vectorOnlyHits: vectorOnly,
    bm25OnlyHits: bm25Only,
    graphOnlyHits: graphOnly,
    multiSignalHits: multiSignal,
    rrfUplift,
  };
}
