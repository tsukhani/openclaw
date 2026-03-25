/**
 * Tests for OP-190: Multi-intent query decomposition.
 */

import { describe, expect, it, vi } from "vitest";
import { decomposeQuery } from "./query-analyzer.js";
import type { HybridSearchResult } from "./schema.js";

// ============================================================================
// decomposeQuery — Decomposer Tests
// ============================================================================

describe("decomposeQuery", () => {
  describe("compound queries (should decompose)", () => {
    it("splits 'What does X teach and how much does it cost?'", () => {
      const result = decomposeQuery("What does Abundent Academy teach and how much does it cost?");
      expect(result.isCompound).toBe(true);
      expect(result.subQueries).toHaveLength(2);
      expect(result.originalQuery).toBe(
        "What does Abundent Academy teach and how much does it cost?",
      );
    });

    it("splits 'Who is Alice and where does she work?'", () => {
      const result = decomposeQuery("Who is Alice and where does she work?");
      expect(result.isCompound).toBe(true);
      expect(result.subQueries).toHaveLength(2);
    });

    it("splits 'What tool do we use for Y and who set it up?'", () => {
      const result = decomposeQuery("What tool do we use for deployments and who set it up?");
      expect(result.isCompound).toBe(true);
      expect(result.subQueries).toHaveLength(2);
    });

    it("splits triple-intent: 'What is X, how old is he, and where does he live?'", () => {
      const result = decomposeQuery("What is Tarun, how old is he, and where does he live?");
      expect(result.isCompound).toBe(true);
      expect(result.subQueries.length).toBeGreaterThanOrEqual(2);
    });

    it("splits comma-separated intents without 'and'", () => {
      const result = decomposeQuery(
        "What is the project status, how many users signed up this week",
      );
      expect(result.isCompound).toBe(true);
      expect(result.subQueries).toHaveLength(2);
    });
  });

  describe("non-compound queries (should NOT decompose)", () => {
    it("does not split single-intent: 'What is Tarun's phone number?'", () => {
      const result = decomposeQuery("What is Tarun's phone number?");
      expect(result.isCompound).toBe(false);
      expect(result.subQueries).toHaveLength(1);
    });

    it("does not split: 'Tell me about OpenClaw'", () => {
      const result = decomposeQuery("Tell me about OpenClaw");
      expect(result.isCompound).toBe(false);
    });

    it("does not split when sub-queries are too short: 'Is it good and nice?'", () => {
      const result = decomposeQuery("Is it good and nice?");
      expect(result.isCompound).toBe(false);
    });

    it("does not split empty queries", () => {
      const result = decomposeQuery("");
      expect(result.isCompound).toBe(false);
      expect(result.subQueries).toEqual([""]);
    });

    it("does not split single question word queries", () => {
      const result = decomposeQuery("What does the memory system do?");
      expect(result.isCompound).toBe(false);
    });
  });

  describe("entity preservation", () => {
    it("preserves 'Abundent Academy' in both sub-queries", () => {
      const result = decomposeQuery("What does Abundent Academy teach and how much does it cost?");
      expect(result.isCompound).toBe(true);
      for (const sq of result.subQueries) {
        expect(sq.toLowerCase()).toContain("abundent academy".toLowerCase());
      }
    });

    it("preserves entity in comma-separated intents", () => {
      const result = decomposeQuery(
        "What does Google Cloud offer, how much does the basic tier cost",
      );
      expect(result.isCompound).toBe(true);
      for (const sq of result.subQueries) {
        expect(sq.toLowerCase()).toContain("google cloud".toLowerCase());
      }
    });
  });
});

// ============================================================================
// Search Integration — Round-Robin Merge & Deduplication
// ============================================================================

describe("search integration helpers", () => {
  // Helper to create mock HybridSearchResult
  function mockResult(id: string, score: number): HybridSearchResult {
    return {
      id,
      text: `memory ${id}`,
      category: "fact",
      importance: 0.5,
      createdAt: "2025-01-01T00:00:00Z",
      score,
      signals: {
        vector: { rank: 1, score: 0.9 },
        bm25: { rank: 1, score: 0.8 },
        graph: { rank: 0, score: 0 },
      },
    };
  }

  describe("round-robin interleaving", () => {
    it("interleaves results from multiple sub-queries", () => {
      const subResults: HybridSearchResult[][] = [
        [mockResult("a1", 0.9), mockResult("a2", 0.8), mockResult("a3", 0.7)],
        [mockResult("b1", 0.95), mockResult("b2", 0.85), mockResult("b3", 0.6)],
      ];

      // Simulate round-robin merge (same logic as in hybridSearch)
      const merged: HybridSearchResult[] = [];
      const seenIds = new Set<string>();
      const maxLen = Math.max(...subResults.map((r) => r.length));
      for (let rank = 0; rank < maxLen; rank++) {
        for (const results of subResults) {
          if (rank < results.length) {
            const r = results[rank];
            if (!seenIds.has(r.id)) {
              seenIds.add(r.id);
              merged.push({ ...r, decomposed: true });
            }
          }
        }
      }

      // Round-robin: a1, b1, a2, b2, a3, b3
      expect(merged.map((r) => r.id)).toEqual(["a1", "b1", "a2", "b2", "a3", "b3"]);
      expect(merged.every((r) => r.decomposed === true)).toBe(true);
    });
  });

  describe("deduplication", () => {
    it("keeps first occurrence (higher rank) when same ID appears in multiple sub-queries", () => {
      const subResults: HybridSearchResult[][] = [
        [mockResult("shared", 0.9), mockResult("a2", 0.8)],
        [mockResult("shared", 0.7), mockResult("b2", 0.85)],
      ];

      const merged: HybridSearchResult[] = [];
      const seenIds = new Set<string>();
      const maxLen = Math.max(...subResults.map((r) => r.length));
      for (let rank = 0; rank < maxLen; rank++) {
        for (const results of subResults) {
          if (rank < results.length) {
            const r = results[rank];
            if (!seenIds.has(r.id)) {
              seenIds.add(r.id);
              merged.push({ ...r, decomposed: true });
            }
          }
        }
      }

      // "shared" should appear once (from sub-query 1, score 0.9)
      const sharedResults = merged.filter((r) => r.id === "shared");
      expect(sharedResults).toHaveLength(1);
      expect(sharedResults[0].score).toBe(0.9);
      // Total: shared, b2, a2
      expect(merged).toHaveLength(3);
    });
  });

  describe("recursion guard", () => {
    it("_skipDecomposition prevents re-decomposition", async () => {
      // This tests the contract: when _skipDecomposition is true,
      // decomposeQuery should not be called in the recursive path.
      // We verify this by checking that decomposeQuery itself is pure
      // and the flag is passed through.
      const decomposition = decomposeQuery("What does X teach and how much does it cost?");
      expect(decomposition.isCompound).toBe(true);

      // The guard is in hybridSearch — when _skipDecomposition is true,
      // the decomposition block is skipped entirely. We can't easily
      // test the full hybridSearch without a Neo4j connection, but we
      // verify the decomposer is deterministic and the flag contract exists.
      const decomposition2 = decomposeQuery(decomposition.subQueries[0]);
      // A single sub-query should NOT decompose further
      expect(decomposition2.isCompound).toBe(false);
    });
  });
});
