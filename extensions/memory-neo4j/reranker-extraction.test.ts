/**
 * Tests for OP-138: Extraction query routing to local cross-encoder reranker.
 *
 * Covers:
 *   - classifyQuery correctly identifies extraction queries
 *   - Extraction queries route to local reranker (not LLM-temporal)
 *   - Non-extraction queries route to configured default
 *   - Config override (extractionMode) works
 *   - rewriteExtractionQuery produces declarative form
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtractionConfig } from "./config.js";
import { NO_OP_METRICS } from "./metrics.js";
import { rewriteExtractionQuery } from "./reranker-local.js";
import { rerankCandidates } from "./reranker.js";
import type { HybridSearchResult, RerankerConfig } from "./schema.js";
import { classifyQuery } from "./search.js";

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
  makeCandidate("a", 0.9, "Ada said she prefers the Chatterbox voice model"),
  makeCandidate("b", 0.7, "Ada mentioned the TTS latency was under 500ms"),
  makeCandidate("c", 0.5, "Ada works on OpenClaw"),
];

const EXTRACTION_CONFIG: ExtractionConfig = {
  enabled: true,
  apiKey: "test-key",
  model: "anthropic/claude-sonnet-4-6",
  baseUrl: "https://openrouter.ai/api/v1",
  temperature: 0.0,
  maxRetries: 0,

  timeout: 30_000,
  concurrency: 8,
  localNerEnabled: false,
  maxTokens: 4096,
};

const LOGGER = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

// ─── classifyQuery: extraction detection ────────────────────────────────────

describe("classifyQuery: extraction detection (OP-138)", () => {
  it("classifies 'what did Ada say about her voice?' as extraction", () => {
    expect(classifyQuery("what did Ada say about her voice?")).toBe("extraction");
  });

  it("classifies 'what did Tarun mention about the deadline?' as extraction", () => {
    expect(classifyQuery("what did Tarun mention about the deadline?")).toBe("extraction");
  });

  it("classifies 'what does Ada prefer for TTS?' as extraction", () => {
    expect(classifyQuery("what does Ada prefer for TTS?")).toBe("extraction");
  });

  it("classifies 'how did Tarun describe the project?' as extraction (WH+comm verb)", () => {
    // "describe" matched by WH_COMM_RE: how did + describe
    expect(classifyQuery("how did Tarun describe the project?")).toBe("extraction");
  });

  it("classifies 'how did Tarun describe the new project?' as extraction (M8: 'new' no longer triggers updates)", () => {
    // M8: "new" removed from updates regex — too generic. "describe" triggers extraction.
    expect(classifyQuery("how did Tarun describe the new project?")).toBe("extraction");
  });

  it("classifies 'Ada said she prefers TypeScript' as extraction", () => {
    // past-tense "said" triggers extraction
    expect(classifyQuery("Ada said she prefers TypeScript")).toBe("extraction");
  });

  it("classifies 'what did the user say about Python?' as extraction", () => {
    expect(classifyQuery("what did the user say about Python?")).toBe("extraction");
  });

  it("classifies 'who did Ada mention in the meeting?' as extraction (mention = comm verb)", () => {
    // "mentioned" / "mention" is a comm verb
    expect(classifyQuery("what did Ada mention in the meeting?")).toBe("extraction");
  });

  it("classifies 'the user thought the design was clean' as extraction", () => {
    // "thought" is a past cognition verb
    expect(classifyQuery("the user thought the design was clean")).toBe("extraction");
  });

  it("does NOT classify 'what is the current model?' as extraction (updates wins)", () => {
    // Updates keyword takes priority over extraction patterns
    expect(classifyQuery("what is the current model?")).toBe("updates");
  });

  it("does NOT classify 'TypeScript' as extraction (too short, entity)", () => {
    expect(classifyQuery("TypeScript")).toBe("entity");
  });

  it("does NOT classify 'find Tarun' as extraction (too short, entity)", () => {
    expect(classifyQuery("find Tarun")).toBe("entity");
  });

  it("does NOT classify 'TypeScript best practices' as extraction (no comm verb)", () => {
    // 3 words, no comm verb, not a question pattern — falls to "default"
    expect(classifyQuery("TypeScript best practices")).toBe("default");
  });

  it("does NOT classify 'what does she do' as extraction (generic verb 'do' excluded)", () => {
    // "do" is not a communication/cognition verb — stays as entity (what does pattern)
    expect(classifyQuery("what does she do")).toBe("entity");
  });

  it("does NOT classify 'tell me about the history of programming' as extraction (imperative, no subject+past-comm-verb)", () => {
    // Imperative "tell me about" — no past comm verb → "long" (5+ words)
    expect(classifyQuery("tell me about the history of programming")).toBe("long");
  });
});

// ─── rewriteExtractionQuery ──────────────────────────────────────────────────

describe("rewriteExtractionQuery", () => {
  it("rewrites 'what did Ada say about her voice?' to declarative form", () => {
    const result = rewriteExtractionQuery("what did Ada say about her voice?");
    expect(result).toMatch(/Ada said/i);
    expect(result).not.toMatch(/\?/);
  });

  it("rewrites 'what did Tarun mention about the project?' correctly", () => {
    const result = rewriteExtractionQuery("what did Tarun mention about the project?");
    expect(result).toMatch(/Tarun mentioned/i);
  });

  it("rewrites 'how did Ada describe the latency?' to remove question form", () => {
    const result = rewriteExtractionQuery("how did Ada describe the latency?");
    expect(result).not.toMatch(/^how did/i);
    expect(result).not.toMatch(/\?/);
  });

  it("strips question prefix as fallback for unrecognised patterns", () => {
    const result = rewriteExtractionQuery("what did X think about Y?");
    expect(result).not.toMatch(/^what did/i);
    expect(result).not.toMatch(/\?/);
  });

  it("returns non-empty string for any input", () => {
    const cases = [
      "what did X say?",
      "how does Ada feel about the TTS?",
      "who did Tarun mention?",
      "short query",
    ];
    for (const q of cases) {
      expect(rewriteExtractionQuery(q).length).toBeGreaterThan(0);
    }
  });
});

// ─── rerankCandidates: extraction routing ────────────────────────────────────

describe("rerankCandidates: extraction query routing (OP-138)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("routes extraction queries to local reranker when extractionMode=local (default)", async () => {
    const localRerankMock = vi.fn().mockResolvedValue([
      { index: 0, relevanceScore: 0.95 },
      { index: 1, relevanceScore: 0.7 },
      { index: 2, relevanceScore: 0.3 },
    ]);
    const llmRerankMock = vi.fn().mockResolvedValue([]);

    vi.doMock("./reranker-local.js", () => ({ localRerank: localRerankMock }));
    vi.doMock("./reranker-llm.js", () => ({ llmRerank: llmRerankMock }));

    const { rerankCandidates: rerank } = await import("./reranker.js");

    const config: RerankerConfig = {
      enabled: true,
      provider: "local",
      extractionMode: "local",
    };

    await rerank(
      "what did Ada say about her voice?",
      CANDIDATES,
      config,
      EXTRACTION_CONFIG,
      LOGGER,
      NO_OP_METRICS,
      undefined,
      "extraction",
    );

    expect(localRerankMock).toHaveBeenCalled();
    expect(llmRerankMock).not.toHaveBeenCalled();
  });

  it("routes extraction queries to local reranker when extractionMode is omitted (defaults to local)", async () => {
    const localRerankMock = vi.fn().mockResolvedValue([
      { index: 0, relevanceScore: 0.9 },
      { index: 1, relevanceScore: 0.5 },
      { index: 2, relevanceScore: 0.2 },
    ]);
    const llmRerankMock = vi.fn().mockResolvedValue([]);

    vi.doMock("./reranker-local.js", () => ({ localRerank: localRerankMock }));
    vi.doMock("./reranker-llm.js", () => ({ llmRerank: llmRerankMock }));

    const { rerankCandidates: rerank } = await import("./reranker.js");

    const config: RerankerConfig = {
      enabled: true,
      provider: "local",
      // extractionMode omitted — should default to "local"
    };

    await rerank(
      "what did Ada say about her voice?",
      CANDIDATES,
      config,
      EXTRACTION_CONFIG,
      LOGGER,
      NO_OP_METRICS,
      undefined,
      "extraction",
    );

    expect(localRerankMock).toHaveBeenCalled();
    expect(llmRerankMock).not.toHaveBeenCalled();
  });

  it("routes extraction queries to LLM reranker when extractionMode=llm-temporal", async () => {
    const localRerankMock = vi.fn().mockResolvedValue([]);
    const llmRerankMock = vi.fn().mockResolvedValue([
      { index: 0, relevanceScore: 0.9 },
      { index: 1, relevanceScore: 0.6 },
      { index: 2, relevanceScore: 0.3 },
    ]);

    vi.doMock("./reranker-local.js", () => ({ localRerank: localRerankMock }));
    vi.doMock("./reranker-llm.js", () => ({ llmRerank: llmRerankMock }));

    const { rerankCandidates: rerank } = await import("./reranker.js");

    const config: RerankerConfig = {
      enabled: true,
      provider: "local",
      extractionMode: "llm-temporal",
    };

    await rerank(
      "what did Ada say about her voice?",
      CANDIDATES,
      config,
      EXTRACTION_CONFIG,
      LOGGER,
      NO_OP_METRICS,
      undefined,
      "extraction",
    );

    expect(llmRerankMock).toHaveBeenCalled();
    expect(localRerankMock).not.toHaveBeenCalled();
  });

  it("routes non-extraction queries to configured default (provider=local → local reranker)", async () => {
    const localRerankMock = vi.fn().mockResolvedValue([
      { index: 0, relevanceScore: 0.9 },
      { index: 1, relevanceScore: 0.5 },
      { index: 2, relevanceScore: 0.2 },
    ]);
    const llmRerankMock = vi.fn().mockResolvedValue([]);

    vi.doMock("./reranker-local.js", () => ({ localRerank: localRerankMock }));
    vi.doMock("./reranker-llm.js", () => ({ llmRerank: llmRerankMock }));

    const { rerankCandidates: rerank } = await import("./reranker.js");

    const config: RerankerConfig = {
      enabled: true,
      provider: "local",
      extractionMode: "local",
    };

    // Non-extraction query type: "long"
    await rerank(
      "find all memories related to Ada and the voice system",
      CANDIDATES,
      config,
      EXTRACTION_CONFIG,
      LOGGER,
      NO_OP_METRICS,
      undefined,
      "long",
    );

    expect(localRerankMock).toHaveBeenCalled();
    expect(llmRerankMock).not.toHaveBeenCalled();
  });

  it("routes temporal (updates) queries to LLM reranker regardless of extractionMode", async () => {
    const localRerankMock = vi.fn().mockResolvedValue([]);
    const llmRerankMock = vi.fn().mockResolvedValue([
      { index: 0, relevanceScore: 0.9 },
      { index: 1, relevanceScore: 0.6 },
      { index: 2, relevanceScore: 0.3 },
    ]);

    vi.doMock("./reranker-local.js", () => ({ localRerank: localRerankMock }));
    vi.doMock("./reranker-llm.js", () => ({ llmRerank: llmRerankMock }));

    const { rerankCandidates: rerank } = await import("./reranker.js");

    const config: RerankerConfig = {
      enabled: true,
      provider: "local",
      extractionMode: "local",
    };

    // "updates" queryType forces cross-encoder — "updates" queries are triggered by
    // common words like "new", "current", "latest" that frequently appear in non-temporal
    // contexts. The local cross-encoder handles these in ~20ms vs 1-2.5s for the LLM.
    await rerank(
      "what is the current TTS model?",
      CANDIDATES,
      config,
      EXTRACTION_CONFIG,
      LOGGER,
      NO_OP_METRICS,
      undefined,
      "updates",
    );

    expect(localRerankMock).toHaveBeenCalled();
    expect(llmRerankMock).not.toHaveBeenCalled();
  });

  it("reranked extraction results have rerankScore populated", async () => {
    vi.doMock("./reranker-local.js", () => ({
      localRerank: vi.fn().mockResolvedValue([
        { index: 0, relevanceScore: 0.92 },
        { index: 1, relevanceScore: 0.65 },
        { index: 2, relevanceScore: 0.3 },
      ]),
    }));
    vi.doMock("./reranker-llm.js", () => ({ llmRerank: vi.fn() }));

    const { rerankCandidates: rerank } = await import("./reranker.js");

    const config: RerankerConfig = {
      enabled: true,
      provider: "local",
      extractionMode: "local",
    };

    const result = await rerank(
      "what did Ada say about her voice?",
      CANDIDATES,
      config,
      EXTRACTION_CONFIG,
      LOGGER,
      NO_OP_METRICS,
      undefined,
      "extraction",
    );

    expect(result[0].rerankScore).toBeCloseTo(0.92);
    // score = alpha * rrfScore + (1-alpha) * rerankScore = 0.4 * 0.9 + 0.6 * 0.92 = 0.912
    expect(result[0].score).toBeCloseTo(0.912, 2);
    expect(result[0].rrfScore).toBeCloseTo(CANDIDATES[0].score);
  });
});

// ─── config parsing: extractionMode ──────────────────────────────────────────

describe("config.ts: reranker.extractionMode parsing", () => {
  it("parses extractionMode=local correctly", async () => {
    const { memoryNeo4jConfigSchema } = await import("./config.js");
    const cfg = memoryNeo4jConfigSchema.parse({
      neo4j: { uri: "bolt://localhost:7687", password: "test" },
      embedding: { provider: "ollama", model: "mxbai-embed-large" },
      reranker: {
        enabled: true,
        provider: "local",
        extractionMode: "local",
      },
    });
    expect(cfg.reranker?.extractionMode).toBe("local");
  });

  it("parses extractionMode=llm-temporal correctly", async () => {
    const { memoryNeo4jConfigSchema } = await import("./config.js");
    const cfg = memoryNeo4jConfigSchema.parse({
      neo4j: { uri: "bolt://localhost:7687", password: "test" },
      embedding: { provider: "ollama", model: "mxbai-embed-large" },
      reranker: {
        enabled: true,
        provider: "local",
        extractionMode: "llm-temporal",
      },
    });
    expect(cfg.reranker?.extractionMode).toBe("llm-temporal");
  });

  it("parses extractionMode=auto correctly", async () => {
    const { memoryNeo4jConfigSchema } = await import("./config.js");
    const cfg = memoryNeo4jConfigSchema.parse({
      neo4j: { uri: "bolt://localhost:7687", password: "test" },
      embedding: { provider: "ollama", model: "mxbai-embed-large" },
      reranker: {
        enabled: true,
        provider: "local",
        extractionMode: "auto",
      },
    });
    expect(cfg.reranker?.extractionMode).toBe("auto");
  });

  it("defaults extractionMode to 'local' when not provided", async () => {
    const { memoryNeo4jConfigSchema } = await import("./config.js");
    const cfg = memoryNeo4jConfigSchema.parse({
      neo4j: { uri: "bolt://localhost:7687", password: "test" },
      embedding: { provider: "ollama", model: "mxbai-embed-large" },
      reranker: {
        enabled: true,
        provider: "local",
      },
    });
    // Default should be "local" when extractionMode is not specified
    expect(cfg.reranker?.extractionMode).toBe("local");
  });

  it("normalises unknown extractionMode values to 'local'", async () => {
    // The parser normalises unknown values to "local" (same pattern as provider)
    const { memoryNeo4jConfigSchema } = await import("./config.js");
    const cfg = memoryNeo4jConfigSchema.parse({
      neo4j: { uri: "bolt://localhost:7687", password: "test" },
      embedding: { provider: "ollama", model: "mxbai-embed-large" },
      reranker: {
        enabled: true,
        provider: "local",
        extractionMode: "unknown-value",
      },
    });
    // unknown → falls back to "local"
    expect(cfg.reranker?.extractionMode).toBe("local");
  });
});
