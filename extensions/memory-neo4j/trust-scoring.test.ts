import { describe, expect, it } from "vitest";
import type { SearchSignalResult } from "./schema.js";
import { fuseWithConfidenceRRF } from "./search.js";

function makeSignalResult(id: string, score: number, trustScore?: number): SearchSignalResult {
  return {
    id,
    text: `Memory ${id}`,
    category: "fact",
    importance: 0.8,
    createdAt: "2026-01-01T00:00:00Z",
    score,
    trustScore,
  };
}

describe("trust scoring", () => {
  describe("trust-weighted RRF ranking", () => {
    it("higher trust memory ranks above lower trust for equal relevance", () => {
      const vectorSignal = [
        makeSignalResult("high-trust", 0.9, 1.0),
        makeSignalResult("low-trust", 0.9, 0.5),
      ];

      const fused = fuseWithConfidenceRRF([vectorSignal, [], [], [], []], 60, [1, 0, 0, 0, 0]);

      expect(fused.length).toBe(2);
      expect(fused[0].id).toBe("high-trust");
      expect(fused[1].id).toBe("low-trust");
      // High trust score should produce higher weighted RRF score
      expect(fused[0].rrfScore).toBeGreaterThan(fused[1].rrfScore);
    });

    it("high relevance overcomes low trust", () => {
      // High relevance but low trust
      const signal1 = [makeSignalResult("relevant-untrusted", 0.95, 0.3)];
      // Low relevance but high trust
      const signal2 = [makeSignalResult("irrelevant-trusted", 0.2, 1.0)];

      const fused = fuseWithConfidenceRRF(
        [[...signal1, ...signal2], [], [], [], []],
        60,
        [1, 0, 0, 0, 0],
      );

      // Relevant-untrusted: 0.3 * 0.95 * (1/61) ≈ 0.00467
      // Irrelevant-trusted: 1.0 * 0.2 * (1/62) ≈ 0.00323
      // Relevant-untrusted should still rank higher due to score advantage
      expect(fused[0].id).toBe("relevant-untrusted");
    });

    it("default trustScore of 1.0 preserves original ranking", () => {
      const signal = [
        makeSignalResult("a", 0.9, undefined), // no trustScore → defaults to 1.0
        makeSignalResult("b", 0.7, undefined),
      ];

      const fused = fuseWithConfidenceRRF([signal, [], [], [], []], 60, [1, 0, 0, 0, 0]);

      expect(fused[0].id).toBe("a");
      expect(fused[1].id).toBe("b");
      // With trust=1.0, scores should be same as without trust weighting
      const noTrustSignal = [makeSignalResult("a", 0.9, 1.0), makeSignalResult("b", 0.7, 1.0)];
      const noTrustFused = fuseWithConfidenceRRF(
        [noTrustSignal, [], [], [], []],
        60,
        [1, 0, 0, 0, 0],
      );
      expect(fused[0].rrfScore).toBeCloseTo(noTrustFused[0].rrfScore, 10);
    });

    it("trustScore=0 produces zero weighted score (quarantine)", () => {
      const signal = [makeSignalResult("quarantined", 0.95, 0.0)];

      const fused = fuseWithConfidenceRRF([signal, [], [], [], []], 60, [1, 0, 0, 0, 0]);

      expect(fused[0].rrfScore).toBe(0);
    });
  });

  describe("5-signal fusion with community", () => {
    it("community signal contributes to fusion", () => {
      const communityResult = makeSignalResult("community-found", 0.8, 1.0);

      const fused = fuseWithConfidenceRRF([[], [], [], [], [communityResult]], 60, [0, 0, 0, 0, 1]);

      expect(fused.length).toBe(1);
      expect(fused[0].id).toBe("community-found");
      expect(fused[0].rrfScore).toBeGreaterThan(0);
    });
  });
});
