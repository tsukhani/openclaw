import { describe, expect, it } from "vitest";
import type { CaseRetrievalMetrics, RetrievedMemory, RetrievedSignals } from "../types.js";
import { computeSignalAttributionStats } from "./signal-attribution.js";

function makeCase(retrieved: RetrievedMemory[], goldIds: string[]): CaseRetrievalMetrics {
  return {
    caseId: "c1",
    ability: "extraction",
    question: "q?",
    retrieved,
    goldIds,
    hitsAtK: 0,
    precisionAtK: 0,
    recallAtK: 0,
    f1AtK: 0,
    firstRelevantRank: 0,
    reciprocalRank: 0,
    ndcgAtK: 0,
    emptyGoldSet: goldIds.length === 0,
  };
}

function memWithSignals(id: string, rank: number, signals?: RetrievedSignals): RetrievedMemory {
  return { id, text: `text-${id}`, score: 0.5, rank, signals };
}

const zeroSignal = { rank: 0, score: 0 };
const activeSignal = (rank: number, score: number) => ({ rank, score });

describe("computeSignalAttributionStats", () => {
  it("returns zeros for empty cases", () => {
    const result = computeSignalAttributionStats([]);
    expect(result.total).toBe(0);
    expect(result.vectorOnlyHits).toBe(0);
    expect(result.rrfUplift).toBe(0);
  });

  it("counts single-signal vector-only hit", () => {
    const mem = memWithSignals("g1", 1, {
      vector: activeSignal(1, 0.9),
      bm25: zeroSignal,
      graph: zeroSignal,
    });
    const result = computeSignalAttributionStats([makeCase([mem], ["g1"])]);
    expect(result.total).toBe(1);
    expect(result.vectorOnlyHits).toBe(1);
    expect(result.bm25OnlyHits).toBe(0);
    expect(result.multiSignalHits).toBe(0);
  });

  it("counts multi-signal hit with RRF uplift", () => {
    const mem = memWithSignals("g1", 1, {
      vector: activeSignal(3, 0.7),
      bm25: activeSignal(2, 0.5),
      graph: zeroSignal,
    });
    // fused rank 1 < best single rank 2 → uplift
    const result = computeSignalAttributionStats([makeCase([mem], ["g1"])]);
    expect(result.multiSignalHits).toBe(1);
    expect(result.rrfUplift).toBe(1.0);
  });

  it("excludes memories without signal info from multiSignal denominator", () => {
    // One memory with no signals, one with multi-signal + uplift
    const noSignals = memWithSignals("g1", 1, undefined);
    const withSignals = memWithSignals("g2", 2, {
      vector: activeSignal(3, 0.9),
      bm25: activeSignal(4, 0.5),
      graph: zeroSignal,
    });
    // fused rank 2 < best single rank 3 → uplift
    const result = computeSignalAttributionStats([
      makeCase([noSignals, withSignals], ["g1", "g2"]),
    ]);
    expect(result.total).toBe(2);
    // g1 (no signals) should NOT inflate multiSignalHits
    expect(result.multiSignalHits).toBe(1);
    // uplift = 1/1 = 1.0 (not 1/2 which was the old bug)
    expect(result.rrfUplift).toBe(1.0);
  });

  it("excludes zero-score memories from multiSignal denominator", () => {
    const zeroMem = memWithSignals("g1", 1, {
      vector: zeroSignal,
      bm25: zeroSignal,
      graph: zeroSignal,
    });
    const result = computeSignalAttributionStats([makeCase([zeroMem], ["g1"])]);
    expect(result.total).toBe(1);
    expect(result.multiSignalHits).toBe(0);
  });

  it("skips non-gold memories", () => {
    const mem = memWithSignals("x1", 1, {
      vector: activeSignal(1, 0.9),
      bm25: zeroSignal,
      graph: zeroSignal,
    });
    const result = computeSignalAttributionStats([makeCase([mem], ["g1"])]);
    expect(result.total).toBe(0);
  });
});
