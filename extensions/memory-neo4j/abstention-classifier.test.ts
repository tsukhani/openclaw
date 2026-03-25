/**
 * Tests for abstention-classifier.ts (OP-137)
 *
 * Covers:
 *   - Empty candidate set → abstain
 *   - Global low-confidence (maxScore < 0.35 AND meanScore < 0.25) → abstain
 *   - "long" query type with very few low-scoring results → abstain
 *   - "long" query type with adequate results → don't abstain
 *   - High-score candidates → don't abstain
 *   - Edge cases
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
// Global low-confidence gate
// ============================================================================

describe("shouldAbstain — global low-confidence", () => {
  it("should abstain when maxScore < 0.35 and meanScore < 0.25", () => {
    const candidates = [
      makeCandidate("mem-1", 0.3),
      makeCandidate("mem-2", 0.15),
      makeCandidate("mem-3", 0.1),
    ];
    expect(shouldAbstain(candidates, "default")).toBe(true);
  });

  it("should abstain with single very low-score candidate", () => {
    const candidates = [makeCandidate("mem-1", 0.2)];
    expect(shouldAbstain(candidates, "default")).toBe(true);
  });

  it("should NOT abstain when maxScore >= 0.35", () => {
    const candidates = [makeCandidate("mem-1", 0.85), makeCandidate("mem-2", 0.6)];
    expect(shouldAbstain(candidates, "default")).toBe(false);
  });

  it("should NOT abstain when a single high-scoring match exists", () => {
    // One strong match + low-scoring others — max gate open
    const candidates = [
      makeCandidate("mem-1", 0.8),
      makeCandidate("mem-2", 0.1),
      makeCandidate("mem-3", 0.05),
    ];
    expect(shouldAbstain(candidates, "default")).toBe(false);
  });
});

// ============================================================================
// "long" query type — more aggressive abstention
// ============================================================================

describe("shouldAbstain — long query type specifics", () => {
  it("should abstain for 'long' query with only 1 result and maxScore < 0.5", () => {
    const candidates = [makeCandidate("mem-1", 0.4)];
    expect(shouldAbstain(candidates, "long")).toBe(true);
  });

  it("should NOT abstain for 'long' query with 1 result but maxScore >= 0.5", () => {
    const candidates = [makeCandidate("mem-1", 0.55)];
    expect(shouldAbstain(candidates, "long")).toBe(false);
  });

  it("should NOT abstain for 'long' query with 2+ results", () => {
    const candidates = [makeCandidate("mem-1", 0.4), makeCandidate("mem-2", 0.3)];
    expect(shouldAbstain(candidates, "long")).toBe(false);
  });

  it("should NOT apply long-query gate for 'short' query type", () => {
    const candidates = [makeCandidate("mem-1", 0.4)];
    expect(shouldAbstain(candidates, "short")).toBe(false);
  });
});

// ============================================================================
// High-score candidates → don't abstain
// ============================================================================

describe("shouldAbstain — high-score candidates", () => {
  it("should NOT abstain with strong scores", () => {
    const candidates = [makeCandidate("mem-1", 1.0), makeCandidate("mem-2", 0.6)];
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
// Edge cases
// ============================================================================

describe("shouldAbstain — edge cases", () => {
  it("should handle candidates with score exactly 0", () => {
    const candidates = [makeCandidate("mem-1", 0), makeCandidate("mem-2", 0)];
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
    // max = 0.195, mean = ~0.15 → both below thresholds → abstain
    expect(shouldAbstain(candidates, "default")).toBe(true);
  });
});
