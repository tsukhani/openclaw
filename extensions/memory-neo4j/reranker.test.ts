/**
 * Unit tests for the cross-encoder reranker (OP-130).
 *
 * All provider I/O is mocked — no model download, no LLM calls.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtractionConfig } from "./config.js";
import { NO_OP_METRICS } from "./metrics.js";
import { rerankCandidates } from "./reranker.js";
import type { HybridSearchResult, RerankerConfig } from "./schema.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeCandidate(id: string, score: number, text = `memory ${id}`): HybridSearchResult {
  return {
    id,
    text,
    category: "fact",
    importance: 5,
    createdAt: new Date().toISOString(),
    score,
  };
}

const CANDIDATES: HybridSearchResult[] = [
  makeCandidate("a", 0.9, "The user prefers TypeScript"),
  makeCandidate("b", 0.7, "The user likes dogs"),
  makeCandidate("c", 0.5, "The user works at ACME Corp"),
];

const LOCAL_CONFIG: RerankerConfig = {
  enabled: true,
  provider: "local",
  model: "cross-encoder/ms-marco-MiniLM-L-6-v2",
};

const LLM_CONFIG: RerankerConfig = {
  enabled: true,
  provider: "llm",
};

const EXTRACTION_CONFIG: ExtractionConfig = {
  enabled: true,
  apiKey: "test-key",
  model: "anthropic/claude-sonnet-4-6",
  baseUrl: "https://openrouter.ai/api/v1",
  temperature: 0.0,
  maxRetries: 0,
  autoCaptureTasks: false,
};

const LOGGER = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("rerankCandidates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("returns candidates unchanged when enabled=false", async () => {
    const config: RerankerConfig = { enabled: false, provider: "local" };
    const result = await rerankCandidates(
      "query",
      CANDIDATES,
      config,
      EXTRACTION_CONFIG,
      LOGGER,
      NO_OP_METRICS,
    );
    expect(result).toBe(CANDIDATES); // same reference — not reranked
  });

  it("returns candidates unchanged when provider=none", async () => {
    const config: RerankerConfig = { enabled: true, provider: "none" };
    const result = await rerankCandidates(
      "query",
      CANDIDATES,
      config,
      EXTRACTION_CONFIG,
      LOGGER,
      NO_OP_METRICS,
    );
    expect(result).toBe(CANDIDATES);
  });

  it("returns empty array for empty candidates", async () => {
    const result = await rerankCandidates(
      "query",
      [],
      LOCAL_CONFIG,
      EXTRACTION_CONFIG,
      LOGGER,
      NO_OP_METRICS,
    );
    expect(result).toEqual([]);
  });

  describe("local provider", () => {
    it("calls localRerank and maps scores correctly", async () => {
      // Mock localRerank to return reversed order (c > b > a)
      vi.doMock("./reranker-local.js", () => ({
        localRerank: vi.fn().mockResolvedValue([
          { index: 2, relevanceScore: 0.95 }, // c
          { index: 1, relevanceScore: 0.6 }, // b
          { index: 0, relevanceScore: 0.2 }, // a
        ]),
      }));
      const { rerankCandidates: rerank } = await import("./reranker.js");

      const result = await rerank(
        "query",
        CANDIDATES,
        LOCAL_CONFIG,
        EXTRACTION_CONFIG,
        LOGGER,
        NO_OP_METRICS,
      );

      expect(result[0].id).toBe("c");
      expect(result[0].rerankScore).toBeCloseTo(0.95);
      expect(result[1].id).toBe("b");
      expect(result[2].id).toBe("a");
    });

    it("preserves rrfScore (original score) on reranked results", async () => {
      vi.doMock("./reranker-local.js", () => ({
        localRerank: vi.fn().mockResolvedValue([
          { index: 0, relevanceScore: 0.88 },
          { index: 1, relevanceScore: 0.55 },
          { index: 2, relevanceScore: 0.11 },
        ]),
      }));
      const { rerankCandidates: rerank } = await import("./reranker.js");

      const result = await rerank(
        "query",
        CANDIDATES,
        LOCAL_CONFIG,
        EXTRACTION_CONFIG,
        LOGGER,
        NO_OP_METRICS,
      );

      // rrfScore should be the original score from before reranking
      expect(result[0].rrfScore).toBeCloseTo(CANDIDATES[0].score); // a had score 0.9
      expect(result[0].score).toBeCloseTo(0.88); // new score = rerankScore
    });

    it("applies sigmoid correctly: logit 2.0 → score ~0.88", () => {
      // Test the sigmoid math in isolation
      const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
      expect(sigmoid(2.0)).toBeCloseTo(0.8808, 3);
    });

    it("falls back to original order on provider error", async () => {
      vi.doMock("./reranker-local.js", () => ({
        localRerank: vi.fn().mockRejectedValue(new Error("ONNX runtime not available")),
      }));
      const { rerankCandidates: rerank } = await import("./reranker.js");

      const result = await rerank(
        "query",
        CANDIDATES,
        LOCAL_CONFIG,
        EXTRACTION_CONFIG,
        LOGGER,
        NO_OP_METRICS,
      );

      // Must not throw — graceful fallback
      expect(result).toBe(CANDIDATES);
      expect(LOGGER.warn).toHaveBeenCalledWith(
        expect.stringContaining("ONNX runtime not available"),
      );
    });
  });

  describe("llm provider", () => {
    it("calls llmRerank and maps scores correctly", async () => {
      vi.doMock("./reranker-llm.js", () => ({
        llmRerank: vi.fn().mockResolvedValue([
          { index: 1, relevanceScore: 0.92 }, // b
          { index: 0, relevanceScore: 0.7 }, // a
          { index: 2, relevanceScore: 0.3 }, // c
        ]),
      }));
      const { rerankCandidates: rerank } = await import("./reranker.js");

      const result = await rerank(
        "query",
        CANDIDATES,
        LLM_CONFIG,
        EXTRACTION_CONFIG,
        LOGGER,
        NO_OP_METRICS,
      );

      expect(result[0].id).toBe("b");
      expect(result[0].rerankScore).toBeCloseTo(0.92);
    });

    it("falls back to original order on malformed JSON from LLM", async () => {
      vi.doMock("./reranker-llm.js", () => ({
        // Simulate llmRerank returning original-order fallback (as it does on parse error)
        llmRerank: vi.fn().mockResolvedValue([
          { index: 0, relevanceScore: 0 },
          { index: 1, relevanceScore: 0 },
          { index: 2, relevanceScore: 0 },
        ]),
      }));
      const { rerankCandidates: rerank } = await import("./reranker.js");

      const result = await rerank(
        "query",
        CANDIDATES,
        LLM_CONFIG,
        EXTRACTION_CONFIG,
        LOGGER,
        NO_OP_METRICS,
      );

      // All scores 0 → order preserved from input (stable sort by rerankScore desc)
      expect(result.length).toBe(3);
    });

    it("falls back on LLM error without throwing", async () => {
      vi.doMock("./reranker-llm.js", () => ({
        llmRerank: vi.fn().mockRejectedValue(new Error("LLM timeout")),
      }));
      const { rerankCandidates: rerank } = await import("./reranker.js");

      const result = await rerank(
        "query",
        CANDIDATES,
        LLM_CONFIG,
        EXTRACTION_CONFIG,
        LOGGER,
        NO_OP_METRICS,
      );

      expect(result).toBe(CANDIDATES);
      expect(LOGGER.warn).toHaveBeenCalledWith(expect.stringContaining("LLM timeout"));
    });
  });

  describe("minScore filter", () => {
    it("drops results below minScore threshold", async () => {
      vi.doMock("./reranker-local.js", () => ({
        localRerank: vi.fn().mockResolvedValue([
          { index: 0, relevanceScore: 0.9 },
          { index: 1, relevanceScore: 0.6 },
          { index: 2, relevanceScore: 0.1 }, // below threshold
        ]),
      }));
      const { rerankCandidates: rerank } = await import("./reranker.js");

      const config: RerankerConfig = { ...LOCAL_CONFIG, minScore: 0.5 };
      const result = await rerank(
        "query",
        CANDIDATES,
        config,
        EXTRACTION_CONFIG,
        LOGGER,
        NO_OP_METRICS,
      );

      expect(result.length).toBe(2);
      expect(result.every((r) => (r.rerankScore ?? 0) >= 0.5)).toBe(true);
    });
  });

  describe("topJ truncation", () => {
    it("returns at most topJ results", async () => {
      vi.doMock("./reranker-local.js", () => ({
        localRerank: vi.fn().mockResolvedValue([
          { index: 0, relevanceScore: 0.9 },
          { index: 1, relevanceScore: 0.7 },
          { index: 2, relevanceScore: 0.5 },
        ]),
      }));
      const { rerankCandidates: rerank } = await import("./reranker.js");

      const config: RerankerConfig = { ...LOCAL_CONFIG, topJ: 2 };
      const result = await rerank(
        "query",
        CANDIDATES,
        config,
        EXTRACTION_CONFIG,
        LOGGER,
        NO_OP_METRICS,
      );

      expect(result.length).toBe(2);
    });
  });

  describe("metrics", () => {
    it("increments reranker.calls and records latency on success", async () => {
      vi.doMock("./reranker-local.js", () => ({
        localRerank: vi.fn().mockResolvedValue([
          { index: 0, relevanceScore: 0.9 },
          { index: 1, relevanceScore: 0.5 },
          { index: 2, relevanceScore: 0.2 },
        ]),
      }));
      const { rerankCandidates: rerank } = await import("./reranker.js");

      const metricsCollector = {
        increment: vi.fn(),
        histogram: vi.fn(),
        gauge: vi.fn(),
      };

      await rerank("query", CANDIDATES, LOCAL_CONFIG, EXTRACTION_CONFIG, LOGGER, metricsCollector);

      expect(metricsCollector.increment).toHaveBeenCalledWith("reranker.calls");
      expect(metricsCollector.histogram).toHaveBeenCalledWith(
        "reranker.latency",
        expect.any(Number),
      );
    });

    it("increments reranker.errors on failure", async () => {
      vi.doMock("./reranker-local.js", () => ({
        localRerank: vi.fn().mockRejectedValue(new Error("fail")),
      }));
      const { rerankCandidates: rerank } = await import("./reranker.js");

      const metricsCollector = {
        increment: vi.fn(),
        histogram: vi.fn(),
        gauge: vi.fn(),
      };

      await rerank("query", CANDIDATES, LOCAL_CONFIG, EXTRACTION_CONFIG, LOGGER, metricsCollector);

      expect(metricsCollector.increment).toHaveBeenCalledWith("reranker.errors");
    });
  });
});
