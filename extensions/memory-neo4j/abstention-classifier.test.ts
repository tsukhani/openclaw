/**
 * Tests for abstention-classifier.ts (OP-137, OP-191)
 *
 * Covers:
 *   - Empty candidate set → abstain
 *   - Low rawMaxScore (absolute confidence floor) → abstain
 *   - Score clustering + moderate rawMaxScore → abstain
 *   - High rawMaxScore → don't abstain even with clustering
 *   - Fallback v1 normalized-score checks (no rawMaxScore)
 *   - "long" query type with very few low-scoring results → abstain
 *   - "long" query type with adequate results → don't abstain
 *   - Edge cases
 */

import { describe, it, expect } from "vitest";
import {
  shouldAbstain,
  RAW_SCORE_FLOOR,
  RAW_SCORE_SOFT_CEIL,
  CLUSTER_RATIO_THRESHOLD,
} from "./abstention-classifier.js";
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

  it("should abstain when candidates is empty with rawMaxScore", () => {
    expect(shouldAbstain([], "default", 0.1)).toBe(true);
  });
});

// ============================================================================
// Gate 1: Raw score floor (OP-191)
// ============================================================================

describe("shouldAbstain — raw score floor (OP-191)", () => {
  it("should abstain when rawMaxScore is below RAW_SCORE_FLOOR", () => {
    const candidates = [makeCandidate("mem-1", 1.0), makeCandidate("mem-2", 0.8)];
    // Even though normalized scores look great, raw confidence is too low
    expect(shouldAbstain(candidates, "default", RAW_SCORE_FLOOR - 0.001)).toBe(true);
  });

  it("should NOT abstain when rawMaxScore is at RAW_SCORE_FLOOR", () => {
    const candidates = [makeCandidate("mem-1", 1.0), makeCandidate("mem-2", 0.5)];
    // At floor, not below — should pass floor check (may still pass/fail other gates)
    expect(shouldAbstain(candidates, "default", RAW_SCORE_FLOOR)).toBe(false);
  });

  it("should abstain for very low rawMaxScore even with high normalized scores", () => {
    const candidates = [makeCandidate("mem-1", 1.0), makeCandidate("mem-2", 0.95)];
    expect(shouldAbstain(candidates, "default", 0.001)).toBe(true);
  });
});

// ============================================================================
// Gate 2: Score clustering + moderate raw score (OP-191)
// ============================================================================

describe("shouldAbstain — score clustering (OP-191)", () => {
  it("should abstain when scores are clustered AND rawMaxScore is moderate", () => {
    // Simulates distractor-only retrieval: all scores tightly packed
    const candidates = [
      makeCandidate("mem-1", 1.0),
      makeCandidate("mem-2", 0.95), // ratio 0.95 > 0.9 threshold
      makeCandidate("mem-3", 0.92),
    ];
    expect(shouldAbstain(candidates, "default", RAW_SCORE_SOFT_CEIL - 0.01)).toBe(true);
  });

  it("should NOT abstain when scores are clustered but rawMaxScore is HIGH", () => {
    // Multiple genuinely relevant results — high raw confidence + clustering is OK
    const candidates = [
      makeCandidate("mem-1", 1.0),
      makeCandidate("mem-2", 0.95),
      makeCandidate("mem-3", 0.92),
    ];
    expect(shouldAbstain(candidates, "default", RAW_SCORE_SOFT_CEIL + 0.01)).toBe(false);
  });

  it("should NOT abstain when rawMaxScore is moderate but scores are spread out", () => {
    // Clear standout result — not clustered
    const candidates = [
      makeCandidate("mem-1", 1.0),
      makeCandidate("mem-2", 0.5), // ratio 0.5 < 0.9 threshold
      makeCandidate("mem-3", 0.3),
    ];
    expect(shouldAbstain(candidates, "default", RAW_SCORE_SOFT_CEIL - 0.01)).toBe(false);
  });

  it("should NOT trigger clustering gate with only 1 candidate", () => {
    // Clustering requires >= 2 candidates
    const candidates = [makeCandidate("mem-1", 1.0)];
    expect(shouldAbstain(candidates, "default", RAW_SCORE_SOFT_CEIL - 0.01)).toBe(false);
  });

  it("should abstain at exact CLUSTER_RATIO_THRESHOLD boundary", () => {
    const candidates = [
      makeCandidate("mem-1", 1.0),
      makeCandidate("mem-2", CLUSTER_RATIO_THRESHOLD + 0.01),
    ];
    expect(shouldAbstain(candidates, "default", RAW_SCORE_SOFT_CEIL - 0.01)).toBe(true);
  });

  it("should NOT abstain just below CLUSTER_RATIO_THRESHOLD", () => {
    const candidates = [
      makeCandidate("mem-1", 1.0),
      makeCandidate("mem-2", CLUSTER_RATIO_THRESHOLD - 0.01),
    ];
    expect(shouldAbstain(candidates, "default", RAW_SCORE_SOFT_CEIL - 0.01)).toBe(false);
  });
});

// ============================================================================
// Fallback v1 gates (no rawMaxScore)
// ============================================================================

describe("shouldAbstain — v1 fallback (no rawMaxScore)", () => {
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

  it("should NOT abstain when maxScore >= 0.35 (v1 gate)", () => {
    const candidates = [makeCandidate("mem-1", 0.85), makeCandidate("mem-2", 0.6)];
    expect(shouldAbstain(candidates, "default")).toBe(false);
  });
});

// ============================================================================
// High-score candidates → don't abstain
// ============================================================================

describe("shouldAbstain — high-score candidates with rawMaxScore", () => {
  it("should NOT abstain with high rawMaxScore and spread scores", () => {
    const candidates = [makeCandidate("mem-1", 1.0), makeCandidate("mem-2", 0.6)];
    expect(shouldAbstain(candidates, "default", 0.1)).toBe(false);
  });

  it("should NOT abstain for 'entity' query with good raw and normalized scores", () => {
    const candidates = [makeCandidate("mem-1", 0.75), makeCandidate("mem-2", 0.65)];
    expect(shouldAbstain(candidates, "entity", 0.08)).toBe(false);
  });

  it("should NOT abstain for 'long' query with multiple good candidates", () => {
    const candidates = [
      makeCandidate("mem-1", 0.6),
      makeCandidate("mem-2", 0.5),
      makeCandidate("mem-3", 0.4),
    ];
    expect(shouldAbstain(candidates, "long", 0.06)).toBe(false);
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

  it("should NOT apply long-query gate for 'short' query type", () => {
    const candidates = [makeCandidate("mem-1", 0.4)];
    expect(shouldAbstain(candidates, "short")).toBe(false);
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
    expect(shouldAbstain(candidates, "default", 0.1)).toBe(false);
  });

  it("should handle large candidate set with all low scores and low rawMaxScore", () => {
    const candidates = Array.from({ length: 20 }, (_, i) =>
      makeCandidate(`mem-${i}`, 0.1 + i * 0.005),
    );
    expect(shouldAbstain(candidates, "default", 0.005)).toBe(true);
  });

  it("should handle undefined rawMaxScore gracefully (backward compat)", () => {
    const candidates = [makeCandidate("mem-1", 0.85), makeCandidate("mem-2", 0.6)];
    // No rawMaxScore → skip raw gates, use v1 normalized gates only
    expect(shouldAbstain(candidates, "default", undefined)).toBe(false);
  });

  it("should abstain with clustered max-normalized scores (typical abstention case)", () => {
    // This is the typical abstention scenario: all results are max-normalized,
    // top result ≈ 1.0, others cluster near it because all are equally (ir)relevant
    const candidates = [
      makeCandidate("mem-1", 1.0),
      makeCandidate("mem-2", 0.97),
      makeCandidate("mem-3", 0.94),
      makeCandidate("mem-4", 0.91),
      makeCandidate("mem-5", 0.88),
    ];
    // Low raw score + clustering → abstain
    expect(shouldAbstain(candidates, "default", 0.02)).toBe(true);
  });
});
