import { describe, expect, it } from "vitest";
import type { RetrievedMemory, CaseRetrievalMetrics, MemoryAbility } from "../types.js";
import { computeCaseMetrics, aggregateMetrics } from "./retrieval.js";

function mem(id: string, rank: number): RetrievedMemory {
  return { id, text: `text-${id}`, score: 1 - rank * 0.1, rank };
}

describe("computeCaseMetrics", () => {
  it("returns zeros for empty gold set (abstention) and sets emptyGoldSet", () => {
    const result = computeCaseMetrics("c1", "abstention", "q?", [mem("a", 1)], [], 5);
    expect(result.precisionAtK).toBe(0);
    expect(result.recallAtK).toBe(1.0);
    expect(result.f1AtK).toBe(0);
    expect(result.reciprocalRank).toBe(0);
    expect(result.ndcgAtK).toBe(0);
    expect(result.hitsAtK).toBe(0);
    expect(result.emptyGoldSet).toBe(true);
  });

  it("sets emptyGoldSet false for non-empty gold set", () => {
    const result = computeCaseMetrics("c1", "extraction", "q?", [mem("g1", 1)], ["g1"], 5);
    expect(result.emptyGoldSet).toBe(false);
  });

  it("returns perfect scores when all gold in top-K", () => {
    const retrieved = [mem("g1", 1), mem("g2", 2)];
    const result = computeCaseMetrics("c1", "extraction", "q?", retrieved, ["g1", "g2"], 5);
    expect(result.hitsAtK).toBe(2);
    expect(result.precisionAtK).toBe(2 / 5);
    expect(result.recallAtK).toBe(1.0);
    expect(result.reciprocalRank).toBe(1.0);
    expect(result.ndcgAtK).toBeGreaterThan(0);
  });

  it("returns zeros when no gold found", () => {
    const retrieved = [mem("x", 1), mem("y", 2)];
    const result = computeCaseMetrics("c1", "extraction", "q?", retrieved, ["g1"], 5);
    expect(result.hitsAtK).toBe(0);
    expect(result.precisionAtK).toBe(0);
    expect(result.recallAtK).toBe(0);
    expect(result.f1AtK).toBe(0);
    expect(result.reciprocalRank).toBe(0);
    expect(result.ndcgAtK).toBe(0);
  });

  it("MRR only considers top-K results", () => {
    // Gold is at position 6 (beyond k=5) — should NOT be found by MRR
    const retrieved = [
      mem("x1", 1),
      mem("x2", 2),
      mem("x3", 3),
      mem("x4", 4),
      mem("x5", 5),
      mem("g1", 6),
    ];
    const result = computeCaseMetrics("c1", "extraction", "q?", retrieved, ["g1"], 5);
    expect(result.reciprocalRank).toBe(0);
    expect(result.firstRelevantRank).toBe(0);
  });

  it("MRR finds gold within top-K", () => {
    const retrieved = [mem("x1", 1), mem("g1", 2), mem("x3", 3)];
    const result = computeCaseMetrics("c1", "extraction", "q?", retrieved, ["g1"], 5);
    expect(result.firstRelevantRank).toBe(2);
    expect(result.reciprocalRank).toBe(0.5);
  });

  it("computes correct NDCG with binary relevance", () => {
    // gold at rank 1 only
    const retrieved = [mem("g1", 1), mem("x", 2)];
    const result = computeCaseMetrics("c1", "extraction", "q?", retrieved, ["g1"], 5);
    // DCG = 1/log2(2) = 1.0, IDCG = 1/log2(2) = 1.0 → NDCG = 1.0
    expect(result.ndcgAtK).toBeCloseTo(1.0);
  });

  it("computes correct F1", () => {
    // 1 hit out of k=2, 1 gold total → P=0.5, R=1.0, F1 = 2*0.5*1/(0.5+1) = 2/3
    const retrieved = [mem("g1", 1), mem("x", 2)];
    const result = computeCaseMetrics("c1", "extraction", "q?", retrieved, ["g1"], 2);
    expect(result.f1AtK).toBeCloseTo(2 / 3);
  });

  it("handles empty retrieved list", () => {
    const result = computeCaseMetrics("c1", "extraction", "q?", [], ["g1"], 5);
    expect(result.hitsAtK).toBe(0);
    expect(result.precisionAtK).toBe(0);
    expect(result.recallAtK).toBe(0);
    expect(result.reciprocalRank).toBe(0);
    expect(result.ndcgAtK).toBe(0);
  });
});

describe("aggregateMetrics", () => {
  it("returns zeros for empty case list", () => {
    const result = aggregateMetrics("extraction", []);
    expect(result.caseCount).toBe(0);
    expect(result.avgMRR).toBe(0);
    expect(result.hitRate).toBe(0);
  });

  it("averages metrics across cases", () => {
    const cases: CaseRetrievalMetrics[] = [
      {
        caseId: "c1",
        ability: "extraction",
        question: "q1",
        retrieved: [],
        goldIds: ["g1"],
        hitsAtK: 1,
        precisionAtK: 0.5,
        recallAtK: 1.0,
        f1AtK: 0.67,
        firstRelevantRank: 1,
        reciprocalRank: 1.0,
        ndcgAtK: 1.0,
        emptyGoldSet: false,
      },
      {
        caseId: "c2",
        ability: "extraction",
        question: "q2",
        retrieved: [],
        goldIds: ["g2"],
        hitsAtK: 0,
        precisionAtK: 0,
        recallAtK: 0,
        f1AtK: 0,
        firstRelevantRank: 0,
        reciprocalRank: 0,
        ndcgAtK: 0,
        emptyGoldSet: false,
      },
    ];
    const result = aggregateMetrics("extraction", cases);
    expect(result.caseCount).toBe(2);
    expect(result.avgPrecisionAtK).toBe(0.25);
    expect(result.avgRecallAtK).toBe(0.5);
    expect(result.avgMRR).toBe(0.5);
    expect(result.hitRate).toBe(0.5);
  });

  it("excludes emptyGoldSet cases from metric averages but keeps caseCount", () => {
    const cases: CaseRetrievalMetrics[] = [
      {
        caseId: "c1",
        ability: "extraction",
        question: "q1",
        retrieved: [],
        goldIds: ["g1"],
        hitsAtK: 1,
        precisionAtK: 0.4,
        recallAtK: 1.0,
        f1AtK: 0.57,
        firstRelevantRank: 1,
        reciprocalRank: 1.0,
        ndcgAtK: 1.0,
        emptyGoldSet: false,
      },
      {
        caseId: "c2",
        ability: "extraction",
        question: "q2",
        retrieved: [],
        goldIds: [],
        hitsAtK: 0,
        precisionAtK: 0,
        recallAtK: 1.0,
        f1AtK: 0,
        firstRelevantRank: 0,
        reciprocalRank: 0,
        ndcgAtK: 0,
        emptyGoldSet: true,
      },
    ];
    const result = aggregateMetrics("extraction", cases);
    // caseCount includes all cases
    expect(result.caseCount).toBe(2);
    // metric averages computed over scorable case (c1) only
    expect(result.avgPrecisionAtK).toBe(0.4);
    expect(result.avgRecallAtK).toBe(1.0);
    expect(result.avgMRR).toBe(1.0);
    expect(result.hitRate).toBe(1.0);
  });

  it("returns zeros when all cases have empty gold sets", () => {
    const cases: CaseRetrievalMetrics[] = [
      {
        caseId: "c1",
        ability: "extraction",
        question: "q1",
        retrieved: [],
        goldIds: [],
        hitsAtK: 0,
        precisionAtK: 0,
        recallAtK: 1.0,
        f1AtK: 0,
        firstRelevantRank: 0,
        reciprocalRank: 0,
        ndcgAtK: 0,
        emptyGoldSet: true,
      },
    ];
    const result = aggregateMetrics("extraction", cases);
    expect(result.caseCount).toBe(1);
    expect(result.avgPrecisionAtK).toBe(0);
    expect(result.avgRecallAtK).toBe(0);
    expect(result.avgMRR).toBe(0);
    expect(result.hitRate).toBe(0);
  });
});
