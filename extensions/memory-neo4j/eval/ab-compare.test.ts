import { describe, expect, it } from "vitest";
import { pairedBootstrapCI } from "./ab-compare.js";
import type { CaseRetrievalMetrics } from "./types.js";

describe("pairedBootstrapCI", () => {
  const avgPrecision = (cases: CaseRetrievalMetrics[]) =>
    cases.length === 0 ? 0 : cases.reduce((s, c) => s + c.precisionAtK, 0) / cases.length;

  function makeCase(precisionAtK: number): CaseRetrievalMetrics {
    return {
      caseId: "c1",
      ability: "extraction",
      question: "q?",
      retrieved: [],
      goldIds: [],
      hitsAtK: 0,
      precisionAtK,
      recallAtK: 0,
      f1AtK: 0,
      firstRelevantRank: 0,
      reciprocalRank: 0,
      ndcgAtK: 0,
      emptyGoldSet: false,
    };
  }

  it("returns zero delta for identical inputs", () => {
    const cases = [makeCase(0.5), makeCase(0.8)];
    const ci = pairedBootstrapCI(avgPrecision, cases, cases, 100);
    expect(ci.mean).toBe(0);
    expect(ci.lower).toBe(0);
    expect(ci.upper).toBe(0);
  });

  it("detects positive delta when B is better", () => {
    const casesA = [makeCase(0.2), makeCase(0.3), makeCase(0.25)];
    const casesB = [makeCase(0.8), makeCase(0.9), makeCase(0.85)];
    const ci = pairedBootstrapCI(avgPrecision, casesA, casesB, 1000);
    expect(ci.mean).toBeGreaterThan(0);
    expect(ci.lower).toBeGreaterThan(0);
  });

  it("handles empty cases", () => {
    const ci = pairedBootstrapCI(avgPrecision, [], [], 100);
    expect(ci.mean).toBe(0);
  });

  it("uses consistent percentile indexing at n=1000", () => {
    // With identical data, all deltas are 0, so lower and upper should both be 0
    const cases = [makeCase(0.5)];
    const ci = pairedBootstrapCI(avgPrecision, cases, cases, 1000);
    expect(ci.lower).toBe(0);
    expect(ci.upper).toBe(0);
  });

  it("emptyGoldSet cases are excluded when avg filters them", () => {
    // avg() in METRIC_SPECS filters emptyGoldSet; verify the pattern works
    const avgFiltered = (cases: CaseRetrievalMetrics[]) => {
      const scorable = cases.filter((c) => !c.emptyGoldSet);
      return scorable.length === 0
        ? 0
        : scorable.reduce((s, c) => s + c.precisionAtK, 0) / scorable.length;
    };

    const scorableA = makeCase(0.4);
    const scorableB = makeCase(0.8);
    // emptyGoldSet case with vacuous precision=0 should not dilute the average
    const abstention: CaseRetrievalMetrics = {
      ...makeCase(0),
      emptyGoldSet: true,
      recallAtK: 1.0,
    };

    const casesA = [scorableA, abstention];
    const casesB = [scorableB, abstention];

    const ci = pairedBootstrapCI(avgFiltered, casesA, casesB, 100);
    // Delta should be 0.8 - 0.4 = 0.4, not diluted by the abstention case
    expect(ci.mean).toBeCloseTo(0.4);
  });
});
