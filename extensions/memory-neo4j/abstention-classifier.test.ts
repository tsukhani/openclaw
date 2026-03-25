/**
 * Tests for abstention-classifier.ts (OP-137)
 *
 * Covers:
 *   - Empty candidate set → abstain
 *   - Low-score candidates (maxScore < 0.35, meanScore < 0.25) → abstain
 *   - High-score candidates → don't abstain
 *   - Mixed scores where max is high → don't abstain
 *   - "long" query type with very few low-scoring results → abstain
 *   - "long" query type with adequate results → don't abstain
 *   - Non-"long" query type with few low-scoring results → don't abstain (less aggressive)
 */

import { describe, it, expect } from "vitest";
import { shouldAbstain } from "./abstention-classifier.js";
import type { ScoredMemory } from "./abstention-classifier.js";

function makeCandidate(id: string, score: number): ScoredMemory {
  return { id, score };
}

// ============================================================================
// Empty candidates
// ============================================================================

describe("shouldAbstain — empty candidates", () => {
  it("should abstain when candidates is empty", () => {
    expect(shouldAbstain([], "default")).toBe(true);
  });

  it("should abstain when candidates is empty for any query type", () => {
    expect(shouldAbstain([], "long")).toBe(true);
    expect(shouldAbstain([], "short")).toBe(true);
    expect(shouldAbstain([], "entity")).toBe(true);
  });
});

// ============================================================================
// Low-score candidates → abstain
// ============================================================================

describe("shouldAbstain — low-score candidates", () => {
  it("should abstain when maxScore < 0.35 and meanScore < 0.25", () => {
    const candidates = [
      makeCandidate("mem-1", 0.3), // maxScore
      makeCandidate("mem-2", 0.15),
      makeCandidate("mem-3", 0.1),
    ];
    // maxScore=0.30, meanScore=(0.30+0.15+0.10)/3≈0.183 → abstain
    expect(shouldAbstain(candidates, "default")).toBe(true);
  });

  it("should abstain with single very low-score candidate", () => {
    const candidates = [makeCandidate("mem-1", 0.2)];
    // maxScore=0.20, meanScore=0.20 → both below thresholds → abstain
    expect(shouldAbstain(candidates, "default")).toBe(true);
  });

  it("should abstain for 'short' query type when scores are very low", () => {
    const candidates = [makeCandidate("mem-1", 0.25), makeCandidate("mem-2", 0.2)];
    // maxScore=0.25, meanScore=0.225 → both below thresholds → abstain
    expect(shouldAbstain(candidates, "short")).toBe(true);
  });
});

// ============================================================================
// High-score candidates → don't abstain
// ============================================================================

describe("shouldAbstain — high-score candidates", () => {
  it("should NOT abstain when maxScore >= 0.35", () => {
    const candidates = [makeCandidate("mem-1", 0.85), makeCandidate("mem-2", 0.6)];
    expect(shouldAbstain(candidates, "default")).toBe(false);
  });

  it("should NOT abstain when maxScore is exactly 0.35", () => {
    const candidates = [makeCandidate("mem-1", 0.35)];
    // maxScore=0.35 — NOT below threshold (strict <) → don't abstain
    expect(shouldAbstain(candidates, "default")).toBe(false);
  });

  it("should NOT abstain when maxScore is high but mean is low (high variance)", () => {
    // Max is strong → content exists
    const candidates = [
      makeCandidate("mem-1", 0.92), // maxScore > 0.35
      makeCandidate("mem-2", 0.05),
      makeCandidate("mem-3", 0.03),
    ];
    // maxScore=0.92 → global gate stays open
    expect(shouldAbstain(candidates, "default")).toBe(false);
  });

  it("should NOT abstain for 'entity' query with good scores", () => {
    const candidates = [makeCandidate("mem-1", 0.75), makeCandidate("mem-2", 0.65)];
    expect(shouldAbstain(candidates, "entity")).toBe(false);
  });

  it("should NOT abstain for 'long' query with multiple good candidates", () => {
    const candidates = [
      makeCandidate("mem-1", 0.6),
      makeCandidate("mem-2", 0.5),
      makeCandidate("mem-3", 0.4),
    ];
    expect(shouldAbstain(candidates, "long")).toBe(false);
  });
});

// ============================================================================
// "long" query type — more aggressive abstention
// ============================================================================

describe("shouldAbstain — long query type specifics", () => {
  it("should abstain for 'long' query with only 1 result and maxScore < 0.5", () => {
    const candidates = [makeCandidate("mem-1", 0.4)];
    // candidates.length < 2 AND maxScore < 0.5 AND queryType === "long" → abstain
    expect(shouldAbstain(candidates, "long")).toBe(true);
  });

  it("should NOT abstain for 'long' query with 1 result but maxScore >= 0.5", () => {
    const candidates = [makeCandidate("mem-1", 0.55)];
    expect(shouldAbstain(candidates, "long")).toBe(false);
  });

  it("should NOT abstain for 'long' query with 2+ results even if maxScore < 0.5", () => {
    const candidates = [makeCandidate("mem-1", 0.45), makeCandidate("mem-2", 0.35)];
    // candidates.length >= 2 → long-query gate doesn't fire
    // maxScore=0.45 > 0.35 threshold → global gate also stays open (meanScore check needed)
    // meanScore=(0.45+0.35)/2=0.40 > 0.25 → no abstain
    expect(shouldAbstain(candidates, "long")).toBe(false);
  });

  it("should NOT apply long-query gate for 'short' query type", () => {
    // Same conditions as long-query gate — but queryType !== "long"
    const candidates = [makeCandidate("mem-1", 0.4)];
    // For "short": global gate fires only if maxScore < 0.35 (not the case here, 0.4 > 0.35)
    expect(shouldAbstain(candidates, "short")).toBe(false);
  });

  it("should NOT apply long-query gate for 'entity' query type", () => {
    const candidates = [makeCandidate("mem-1", 0.4)];
    expect(shouldAbstain(candidates, "entity")).toBe(false);
  });
});

// ============================================================================
// Edge cases
// ============================================================================

describe("shouldAbstain — edge cases", () => {
  it("should handle candidates with score exactly 0", () => {
    const candidates = [makeCandidate("mem-1", 0), makeCandidate("mem-2", 0)];
    // maxScore=0 < 0.35, meanScore=0 < 0.25 → abstain
    expect(shouldAbstain(candidates, "default")).toBe(true);
  });

  it("should handle candidates with score exactly 1.0", () => {
    const candidates = [makeCandidate("mem-1", 1.0)];
    expect(shouldAbstain(candidates, "default")).toBe(false);
  });

  it("should handle large candidate set with all low scores", () => {
    const candidates = Array.from({ length: 20 }, (_, i) =>
      makeCandidate(`mem-${i}`, 0.1 + i * 0.005),
    );
    // maxScore = 0.1 + 19*0.005 = 0.195, meanScore well below 0.25 → abstain
    expect(shouldAbstain(candidates, "default")).toBe(true);
  });
});

// ============================================================================
// Config mode switching — integration with hybridSearch
// ============================================================================

describe("shouldAbstain — config mode switching (via hybridSearch)", () => {
  // These tests verify that the classifier can be bypassed by passing mode="threshold"
  // to hybridSearch. We test shouldAbstain() directly here since hybridSearch()
  // is tested separately in search.test.ts.

  it("classifier returns true for empty input regardless of mode logic", () => {
    // This always returns true — the classifier is the direct path
    expect(shouldAbstain([], "default")).toBe(true);
  });

  it("classifier correctly rejects low-confidence retrieval (would be abstained)", () => {
    const weakCandidates = [makeCandidate("mem-1", 0.2), makeCandidate("mem-2", 0.18)];
    expect(shouldAbstain(weakCandidates, "default")).toBe(true);
  });

  it("classifier correctly accepts high-confidence retrieval (would NOT be abstained)", () => {
    const strongCandidates = [makeCandidate("mem-1", 0.9), makeCandidate("mem-2", 0.7)];
    expect(shouldAbstain(strongCandidates, "default")).toBe(false);
  });
});
