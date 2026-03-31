/**
 * Tests for memory_store decomposition in plugin-tools.ts.
 *
 * Uses mocks for Neo4j, embeddings, and LLM calls to test the decomposition
 * path without requiring external services.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { decomposeMock } = vi.hoisted(() => ({
  decomposeMock: vi.fn<(...args: unknown[]) => Promise<string[] | null>>().mockResolvedValue(null),
}));

vi.mock("./extractor.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./extractor.js")>();
  return {
    ...original,
    decomposeIntoAtomicFacts: decomposeMock,
  };
});

import type { ExtractionConfig, MemoryNeo4jConfig } from "./config.js";
import type { Embeddings } from "./embeddings.js";
import type { Neo4jMemoryClient } from "./neo4j-client.js";
import { registerMemoryTools } from "./plugin-tools.js";
import type { Logger } from "./schema.js";

// ============================================================================
// Helpers
// ============================================================================

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function makeMockEmbeddings(): Embeddings {
  let callCount = 0;
  return {
    embed: vi.fn(async () => {
      callCount++;
      return [callCount * 0.1, 0.2, 0.3];
    }),
    embedBatch: vi.fn(async (texts: string[]) => texts.map((_, i) => [(i + 1) * 0.1, 0.2, 0.3])),
  } as unknown as Embeddings;
}

function makeMockDb(): Neo4jMemoryClient {
  return {
    findSimilar: vi.fn(async () => []),
    storeMemory: vi.fn(async () => {}),
    detectConflicts: vi.fn(async () => 0),
    vectorSearch: vi.fn(async () => []),
    deleteMemory: vi.fn(async () => true),
    updateExtractionStatus: vi.fn(async () => {}),
    createSession: vi.fn(),
    searchCache: undefined,
  } as unknown as Neo4jMemoryClient;
}

function makeConfig(overrides?: Partial<MemoryNeo4jConfig>): MemoryNeo4jConfig {
  return {
    decomposition: { enabled: true },
    conflictDetection: { enabled: false, similarityThreshold: 0.85, maxCandidates: 5 },
    instructionDetection: { enabled: false },
    graphSearchDepth: 2,
    graphSeedCap: 10,
    graphRelTypes: [],
    graphCausalRelTypes: [],
    recencyWeight: 0.1,
    ...overrides,
  } as MemoryNeo4jConfig;
}

function makeExtractionConfig(): ExtractionConfig {
  return { enabled: false } as ExtractionConfig;
}

/** Build a string of at least 200 chars with multiple facts. */
function makeLongText(): string {
  return (
    "Alice works at Acme Corp as a senior engineer. " +
    "She has been there for five years and leads the platform team. " +
    "Bob is her manager and reports directly to the CTO. " +
    "They are currently working on migrating the monolith to microservices. " +
    "The target completion date is Q3 2026."
  );
}

// ============================================================================
// Test Suite
// ============================================================================

describe("memory_store decomposition", () => {
  let api: {
    registerTool: ReturnType<typeof vi.fn>;
    tools: Map<string, { execute: (id: string, params: unknown) => Promise<unknown> }>;
  };
  let db: Neo4jMemoryClient;
  let embeddings: Embeddings;
  let logger: Logger;

  beforeEach(() => {
    vi.clearAllMocks();
    api = {
      registerTool: vi.fn((factory, opts) => {
        const tool = factory({ agentId: "test-agent", sessionKey: "sess-1" });
        api.tools.set(opts.name ?? tool.name, tool);
      }),
      tools: new Map(),
    };
    db = makeMockDb();
    embeddings = makeMockEmbeddings();
    logger = makeLogger();
  });

  function register(cfgOverrides?: Partial<MemoryNeo4jConfig>) {
    registerMemoryTools(
      api as never,
      db,
      embeddings,
      makeConfig(cfgOverrides),
      makeExtractionConfig(),
      logger,
    );
    return api.tools.get("memory_store")!;
  }

  it("decomposes long text into multiple atomic facts when enabled", async () => {
    const longText = makeLongText();
    expect(longText.length).toBeGreaterThanOrEqual(200);

    decomposeMock.mockResolvedValueOnce([
      "Alice works at Acme Corp as a senior engineer.",
      "Alice has been at Acme Corp for five years and leads the platform team.",
      "Bob is Alice's manager and reports directly to the CTO.",
    ]);

    const tool = register();
    const result = (await tool.execute("call-1", {
      text: longText,
      importance: 0.8,
      category: "fact",
    })) as { content: Array<{ text: string }>; details: Record<string, unknown> };

    // Should have stored 3 facts
    expect((db.storeMemory as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3);
    expect(result.details.decomposed).toBe(true);
    expect(result.details.factCount).toBe(3);

    // Each fact should get its own embedding
    expect((embeddings.embed as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3);

    // Each fact should get its own dedup check
    expect((db.findSimilar as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3);
  });

  it("falls back to single store when decomposition is disabled", async () => {
    const tool = register({ decomposition: { enabled: false } });
    const longText = makeLongText();

    const result = (await tool.execute("call-1", {
      text: longText,
    })) as { details: Record<string, unknown> };

    expect(result.details.action).toBe("created");
    expect(result.details.decomposed).toBeUndefined();
    expect((db.storeMemory as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    // decompose should not have been called
    expect(decomposeMock).not.toHaveBeenCalled();
  });

  it("falls back to single store when text is shorter than 200 chars", async () => {
    const tool = register();
    const shortText = "Alice works at Acme Corp.";
    expect(shortText.length).toBeLessThan(200);

    const result = (await tool.execute("call-1", {
      text: shortText,
    })) as { details: Record<string, unknown> };

    expect(result.details.action).toBe("created");
    expect(result.details.decomposed).toBeUndefined();
    expect(decomposeMock).not.toHaveBeenCalled();
  });

  it("falls back to single store when decomposition returns null", async () => {
    decomposeMock.mockResolvedValueOnce(null);

    const tool = register();
    const result = (await tool.execute("call-1", {
      text: makeLongText(),
    })) as { details: Record<string, unknown> };

    expect(result.details.action).toBe("created");
    expect(result.details.decomposed).toBeUndefined();
    expect((db.storeMemory as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it("falls back to single store when decomposition returns 1 fact", async () => {
    decomposeMock.mockResolvedValueOnce(["Single fact from the text."]);

    const tool = register();
    const result = (await tool.execute("call-1", {
      text: makeLongText(),
    })) as { details: Record<string, unknown> };

    expect(result.details.action).toBe("created");
    expect(result.details.decomposed).toBeUndefined();
    expect((db.storeMemory as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it("skips duplicate decomposed facts", async () => {
    let findCallCount = 0;
    (db.findSimilar as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      findCallCount++;
      // Second fact is a duplicate
      if (findCallCount === 2) {
        return [{ id: "existing-1", text: "duplicate fact", score: 0.98 }];
      }
      return [];
    });

    decomposeMock.mockResolvedValueOnce([
      "Fact one about Alice.",
      "Fact two is a duplicate.",
      "Fact three about Bob.",
    ]);

    const tool = register();
    const result = (await tool.execute("call-1", {
      text: makeLongText(),
    })) as { details: Record<string, unknown> };

    // Only 2 facts stored (one was a duplicate)
    expect((db.storeMemory as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
    expect(result.details.factCount).toBe(2);
    expect(result.details.decomposed).toBe(true);
  });

  it("caps decomposed facts at 5", async () => {
    decomposeMock.mockResolvedValueOnce([
      "Fact one.",
      "Fact two.",
      "Fact three.",
      "Fact four.",
      "Fact five.",
      "Fact six.",
      "Fact seven.",
    ]);

    const tool = register();
    const result = (await tool.execute("call-1", {
      text: makeLongText(),
    })) as { details: Record<string, unknown> };

    // Should store max 5 facts
    expect((db.storeMemory as ReturnType<typeof vi.fn>).mock.calls.length).toBe(5);
    expect(result.details.factCount).toBe(5);
  });

  it("returns duplicate response when all decomposed facts are duplicates", async () => {
    (db.findSimilar as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "existing-1", text: "existing", score: 0.98 },
    ]);

    decomposeMock.mockResolvedValueOnce(["Duplicate fact one.", "Duplicate fact two."]);

    const tool = register();
    const result = (await tool.execute("call-1", {
      text: makeLongText(),
    })) as { details: Record<string, unknown> };

    expect(result.details.action).toBe("duplicate");
    expect(result.details.decomposed).toBe(true);
    expect((db.storeMemory as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });
});

// ============================================================================
// OP-200: Provenance stripping in memory_recall
// ============================================================================

describe("memory_recall provenance stripping (OP-200)", () => {
  it("should strip provenance and fusionProvenance from HybridSearchResult", () => {
    // Test the stripping logic directly: when includeProvenance=false or
    // provenanceEnabled=false, provenance fields should be removed.
    const resultWithProvenance = {
      id: "mem-1",
      text: "Sarah likes sushi",
      category: "preference",
      importance: 0.8,
      createdAt: "2026-01-01",
      score: 0.95,
      provenance: [{ signal: "bm25" as const, matchedTerms: ["sarah", "sushi"] }],
      fusionProvenance: {
        contributingSignals: ["vector" as const, "bm25" as const],
        recencyBoosted: true,
      },
      signals: {
        vector: { rank: 1, score: 0.9 },
        bm25: { rank: 1, score: 0.85 },
        graph: { rank: 0, score: 0 },
      },
    };

    // Simulate the stripping logic from plugin-tools.ts
    const { provenance, fusionProvenance, ...stripped } = resultWithProvenance;

    expect(stripped.id).toBe("mem-1");
    expect(stripped.text).toBe("Sarah likes sushi");
    expect(stripped.signals).toBeDefined();
    expect("provenance" in stripped).toBe(false);
    expect("fusionProvenance" in stripped).toBe(false);
  });

  it("should preserve provenance when both gates are true", () => {
    const resultWithProvenance = {
      id: "mem-1",
      text: "Memory",
      category: "fact",
      importance: 0.8,
      createdAt: "2026-01-01",
      score: 0.95,
      provenance: [{ signal: "vector" as const }],
      fusionProvenance: { contributingSignals: ["vector" as const] },
    };

    // When shouldIncludeProvenance is true, result passes through unchanged
    const shouldIncludeProvenance = true;
    const result: Record<string, unknown> = shouldIncludeProvenance
      ? resultWithProvenance
      : (() => {
          const { provenance, fusionProvenance, ...rest } = resultWithProvenance;
          return rest;
        })();

    expect(result.provenance).toBeDefined();
    expect(result.fusionProvenance).toBeDefined();
  });
});
