/**
 * Tests for the auto-capture pipeline: captureMessage and runAutoCapture.
 *
 * Tests the embed → dedup → rate → store pipeline including:
 * - Pre-computed vector usage (batch embedding optimization)
 * - Exact dedup (≥0.95 score band)
 * - Semantic dedup (0.75-0.95 score band via LLM)
 * - Importance pre-screening for assistant messages
 * - Batch embedding in runAutoCapture
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _captureMessage as captureMessage,
  _runAutoCapture as runAutoCapture,
} from "./_testing.js";
import type { ExtractionConfig } from "./config.js";
import type { Embeddings } from "./embeddings.js";
import type { Neo4jMemoryClient } from "./neo4j-client.js";
// ============================================================================
// Mocks
// ============================================================================

const enabledConfig: ExtractionConfig = {
  enabled: true,
  apiKey: "test-key",
  model: "test-model",
  baseUrl: "https://test.ai/api/v1",
  temperature: 0.0,
  maxRetries: 0,
  timeout: 30_000,
  concurrency: 8,
  localNerEnabled: false,
  maxTokens: 4096,
};

const disabledConfig: ExtractionConfig = {
  ...enabledConfig,
  enabled: false,
};

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

function createMockDb(overrides?: Partial<Neo4jMemoryClient>): Neo4jMemoryClient {
  return {
    findSimilar: vi.fn().mockResolvedValue([]),
    storeMemory: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as Neo4jMemoryClient;
}

function createMockEmbeddings(overrides?: Partial<Embeddings>): Embeddings {
  return {
    embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    embedBatch: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
    ...overrides,
  } as unknown as Embeddings;
}

// ============================================================================
// captureMessage
// ============================================================================

describe("captureMessage", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should store a new memory when no duplicates exist", async () => {
    const db = createMockDb();
    const embeddings = createMockEmbeddings();

    // Mock rateImportance (LLM call via fetch)
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: JSON.stringify({ score: 7 }) } }],
        }),
    });

    const result = await captureMessage(
      "I prefer TypeScript over JavaScript",
      "auto-capture",
      0.5,
      1.0,
      "test-agent",
      "session-1",
      db,
      embeddings,
      enabledConfig,
      mockLogger,
    );

    expect(result.stored).toBe(true);
    expect(result.semanticDeduped).toBe(false);
    expect(db.storeMemory).toHaveBeenCalledOnce();
    expect(embeddings.embed).toHaveBeenCalledWith("I prefer TypeScript over JavaScript");
  });

  it("should use pre-computed vector when provided", async () => {
    const db = createMockDb();
    const embeddings = createMockEmbeddings();
    const precomputedVector = [0.5, 0.6, 0.7];

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: JSON.stringify({ score: 7 }) } }],
        }),
    });

    const result = await captureMessage(
      "test text",
      "auto-capture",
      0.5,
      1.0,
      "test-agent",
      undefined,
      db,
      embeddings,
      enabledConfig,
      mockLogger,
      precomputedVector,
    );

    expect(result.stored).toBe(true);
    // Should NOT call embed() since pre-computed vector was provided
    expect(embeddings.embed).not.toHaveBeenCalled();
    // Should use the pre-computed vector for findSimilar
    expect(db.findSimilar).toHaveBeenCalledWith(precomputedVector, 0.75, 3, "test-agent");
  });

  it("should skip storage when exact duplicate found (score >= 0.95)", async () => {
    const db = createMockDb({
      findSimilar: vi
        .fn()
        .mockResolvedValue([{ id: "existing-1", text: "duplicate text", score: 0.97 }]),
    });
    const embeddings = createMockEmbeddings();

    const result = await captureMessage(
      "duplicate text",
      "auto-capture",
      0.5,
      1.0,
      "test-agent",
      undefined,
      db,
      embeddings,
      enabledConfig,
      mockLogger,
    );

    expect(result.stored).toBe(false);
    expect(result.semanticDeduped).toBe(false);
    expect(db.storeMemory).not.toHaveBeenCalled();
  });

  it("should semantic dedup when candidate in 0.75-0.95 band is LLM-confirmed duplicate", async () => {
    const db = createMockDb({
      findSimilar: vi
        .fn()
        .mockResolvedValue([{ id: "candidate-1", text: "User prefers TypeScript", score: 0.88 }]),
    });
    const embeddings = createMockEmbeddings();

    // First call: rateImportance, second call: isSemanticDuplicate
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // rateImportance response
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              choices: [{ message: { content: JSON.stringify({ score: 7 }) } }],
            }),
        });
      }
      // isSemanticDuplicate response
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    verdict: "duplicate",
                    reason: "same preference",
                  }),
                },
              },
            ],
          }),
      });
    });

    const result = await captureMessage(
      "I like TypeScript",
      "auto-capture",
      0.5,
      1.0,
      "test-agent",
      undefined,
      db,
      embeddings,
      enabledConfig,
      mockLogger,
    );

    expect(result.stored).toBe(false);
    expect(result.semanticDeduped).toBe(true);
    expect(db.storeMemory).not.toHaveBeenCalled();
  });

  it("should skip importance check when extraction is disabled", async () => {
    const db = createMockDb();
    const embeddings = createMockEmbeddings();

    // With extraction disabled, rateImportance returns 0.5 fallback,
    // so the threshold check is skipped entirely
    const result = await captureMessage(
      "some text to store",
      "auto-capture",
      0.5,
      1.0,
      "test-agent",
      undefined,
      db,
      embeddings,
      disabledConfig,
      mockLogger,
    );

    expect(result.stored).toBe(true);
    expect(db.storeMemory).toHaveBeenCalledOnce();
    // Verify stored with fallback importance * discount
    const storeCall = (db.storeMemory as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(storeCall.importance).toBe(0.5); // 0.5 fallback * 1.0 discount
    expect(storeCall.extractionStatus).toBe("skipped");
  });

  it("should reject user messages below importance threshold", async () => {
    const db = createMockDb();
    const embeddings = createMockEmbeddings();

    // Low importance score
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: JSON.stringify({ score: 2 }) } }],
        }),
    });

    const result = await captureMessage(
      "okay thanks",
      "auto-capture",
      0.5, // threshold 0.5
      1.0,
      "test-agent",
      undefined,
      db,
      embeddings,
      enabledConfig,
      mockLogger,
    );

    expect(result.stored).toBe(false);
    expect(db.storeMemory).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Inline contradiction detection
// ============================================================================

describe("captureMessage — inline contradiction", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should supersede contradicting memory and store the new one", async () => {
    const supersedeMemory = vi.fn().mockResolvedValue(undefined);
    const db = createMockDb({
      findSimilar: vi
        .fn()
        .mockResolvedValue([{ id: "old-memory", text: "Alice works at Beta Inc", score: 0.85 }]),
      supersedeMemory,
    });
    const embeddings = createMockEmbeddings();

    // LLM calls: 1) rateImportance, 2) isSemanticDuplicate, 3) isContradiction
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // rateImportance
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              choices: [{ message: { content: JSON.stringify({ score: 8 }) } }],
            }),
        });
      }
      if (callCount === 2) {
        // isSemanticDuplicate → unique (not a paraphrase)
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              choices: [
                {
                  message: {
                    content: JSON.stringify({ verdict: "unique", reason: "different employer" }),
                  },
                },
              ],
            }),
        });
      }
      // isContradiction → contradiction
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    verdict: "contradiction",
                    reason: "conflicting employers",
                  }),
                },
              },
            ],
          }),
      });
    });

    const result = await captureMessage(
      "Alice works at Acme Corp",
      "auto-capture",
      0.5,
      1.0,
      "test-agent",
      undefined,
      db,
      embeddings,
      enabledConfig,
      mockLogger,
    );

    expect(result.stored).toBe(true);
    expect(db.storeMemory).toHaveBeenCalledOnce();
    expect(supersedeMemory).toHaveBeenCalledWith("old-memory", expect.any(String));
  });

  it("should not supersede when memories are compatible", async () => {
    const supersedeMemory = vi.fn().mockResolvedValue(undefined);
    const db = createMockDb({
      findSimilar: vi
        .fn()
        .mockResolvedValue([{ id: "old-memory", text: "Alice enjoys morning walks", score: 0.8 }]),
      supersedeMemory,
    });
    const embeddings = createMockEmbeddings();

    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              choices: [{ message: { content: JSON.stringify({ score: 7 }) } }],
            }),
        });
      }
      if (callCount === 2) {
        // Not a duplicate
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              choices: [
                {
                  message: {
                    content: JSON.stringify({ verdict: "unique", reason: "different topic" }),
                  },
                },
              ],
            }),
        });
      }
      // Compatible (not a contradiction)
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [
              {
                message: { content: JSON.stringify({ verdict: "compatible", reason: "additive" }) },
              },
            ],
          }),
      });
    });

    const result = await captureMessage(
      "Alice likes coffee",
      "auto-capture",
      0.5,
      1.0,
      "test-agent",
      undefined,
      db,
      embeddings,
      enabledConfig,
      mockLogger,
    );

    expect(result.stored).toBe(true);
    expect(supersedeMemory).not.toHaveBeenCalled();
  });

  it("should skip contradiction check when extraction is disabled", async () => {
    const supersedeMemory = vi.fn().mockResolvedValue(undefined);
    const db = createMockDb({
      findSimilar: vi
        .fn()
        .mockResolvedValue([{ id: "old-memory", text: "Alice works at Beta", score: 0.85 }]),
      supersedeMemory,
    });
    const embeddings = createMockEmbeddings();

    // With disabled config, no LLM calls should be made for dedup/contradiction
    const result = await captureMessage(
      "Alice works at Acme",
      "auto-capture",
      0.5,
      1.0,
      "test-agent",
      undefined,
      db,
      embeddings,
      disabledConfig,
      mockLogger,
    );

    expect(result.stored).toBe(true);
    expect(supersedeMemory).not.toHaveBeenCalled();
  });
});

// ============================================================================
// runAutoCapture
// ============================================================================

describe("runAutoCapture", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should batch-embed all retained messages at once", async () => {
    const db = createMockDb();
    const embedBatchMock = vi.fn().mockResolvedValue([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    const embeddings = createMockEmbeddings({ embedBatch: embedBatchMock });

    // Mock rateImportance calls
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: JSON.stringify({ score: 7 }) } }],
        }),
    });

    const messages = [
      {
        role: "user",
        content: "I prefer TypeScript over JavaScript for backend development",
      },
      {
        role: "user",
        content:
          "TypeScript is great for type safety and developer experience, especially with Node.js projects",
      },
    ];

    await runAutoCapture(
      messages,
      "test-agent",
      "session-1",
      db,
      embeddings,
      enabledConfig,
      mockLogger,
    );

    // Should call embedBatch once with both texts
    expect(embedBatchMock).toHaveBeenCalledOnce();
    const batchTexts = embedBatchMock.mock.calls[0][0];
    expect(batchTexts.length).toBe(2);
  });

  it("should not call embedBatch when no messages pass the gate", async () => {
    const db = createMockDb();
    const embedBatchMock = vi.fn().mockResolvedValue([]);
    const embeddings = createMockEmbeddings({ embedBatch: embedBatchMock });

    // Short messages that won't pass attention gate
    const messages = [
      { role: "user", content: "ok" },
      { role: "assistant", content: "yes" },
    ];

    await runAutoCapture(
      messages,
      "test-agent",
      "session-1",
      db,
      embeddings,
      enabledConfig,
      mockLogger,
    );

    expect(embedBatchMock).not.toHaveBeenCalled();
    expect(db.storeMemory).not.toHaveBeenCalled();
  });

  it("should handle empty messages array", async () => {
    const db = createMockDb();
    const embeddings = createMockEmbeddings();

    await runAutoCapture([], "test-agent", undefined, db, embeddings, enabledConfig, mockLogger);

    expect(db.storeMemory).not.toHaveBeenCalled();
  });

  it("should continue processing if one message fails", async () => {
    const db = createMockDb();
    // First embed call fails, second succeeds
    let embedCallCount = 0;
    const findSimilarMock = vi.fn().mockImplementation(() => {
      embedCallCount++;
      if (embedCallCount === 1) {
        return Promise.reject(new Error("DB connection failed"));
      }
      return Promise.resolve([]);
    });
    const embedBatchMock = vi.fn().mockResolvedValue([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    const dbWithError = createMockDb({
      findSimilar: findSimilarMock,
    });
    const embeddings = createMockEmbeddings({ embedBatch: embedBatchMock });

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: JSON.stringify({ score: 7 }) } }],
        }),
    });

    const messages = [
      {
        role: "user",
        content: "First message that is long enough to pass the attention gate filter",
      },
      {
        role: "user",
        content: "Second message that is also long enough to pass the attention gate",
      },
    ];

    // Should not throw — errors are caught per-message
    await runAutoCapture(
      messages,
      "test-agent",
      "session-1",
      dbWithError,
      embeddings,
      enabledConfig,
      mockLogger,
    );

    // The second message should still have been attempted
    expect(findSimilarMock).toHaveBeenCalledTimes(2);
  });

  it("should return immediately when signal is already aborted", async () => {
    const db = createMockDb();
    const embedBatchMock = vi.fn().mockResolvedValue([[0.1, 0.2]]);
    const embeddings = createMockEmbeddings({ embedBatch: embedBatchMock });

    const controller = new AbortController();
    controller.abort();

    const messages = [
      {
        role: "user",
        content: "A long enough message to pass the attention gate for testing purposes",
      },
    ];

    await runAutoCapture(
      messages,
      "test-agent",
      "session-1",
      db,
      embeddings,
      enabledConfig,
      mockLogger,
      controller.signal,
    );

    // Signal was already aborted — no embed or DB calls should happen
    expect(embedBatchMock).not.toHaveBeenCalled();
    expect(db.storeMemory).not.toHaveBeenCalled();
  });

  it("should stop processing remaining messages when signal is aborted mid-loop", async () => {
    const storeMemoryMock = vi.fn().mockResolvedValue(undefined);
    const db = createMockDb({ storeMemory: storeMemoryMock });
    const controller = new AbortController();

    // embedBatch returns two vectors; abort after first captureMessage processes
    const embedBatchMock = vi.fn().mockResolvedValue([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    const embeddings = createMockEmbeddings({ embedBatch: embedBatchMock });

    let findSimilarCallCount = 0;
    (db.findSimilar as ReturnType<typeof vi.fn>).mockImplementation(() => {
      findSimilarCallCount++;
      // Abort after the first message is processed
      if (findSimilarCallCount === 1) {
        controller.abort();
      }
      return Promise.resolve([]);
    });

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: JSON.stringify({ score: 7 }) } }],
        }),
    });

    const messages = [
      {
        role: "user",
        content: "First message that is long enough to pass the attention gate filter",
      },
      {
        role: "user",
        content: "Second message that is also long enough to pass the attention gate",
      },
    ];

    await runAutoCapture(
      messages,
      "test-agent",
      "session-1",
      db,
      embeddings,
      enabledConfig,
      mockLogger,
      controller.signal,
    );

    // Only the first message should have been processed; second was skipped due to abort
    expect(findSimilarCallCount).toBe(1);
  });

  it("should log capture errors without throwing", async () => {
    const embedBatchMock = vi.fn().mockRejectedValue(new Error("embedding service down"));
    const embeddings = createMockEmbeddings({ embedBatch: embedBatchMock });
    const db = createMockDb();

    const messages = [
      {
        role: "user",
        content: "A long enough message to pass the attention gate for testing purposes",
      },
    ];

    // Should not throw
    await runAutoCapture(
      messages,
      "test-agent",
      "session-1",
      db,
      embeddings,
      enabledConfig,
      mockLogger,
    );

    // Should have logged the error
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  // ============================================================================
  // Decomposition
  // ============================================================================

  it("should skip decomposition when decompose=false even for long text", async () => {
    const db = createMockDb();
    const storeMemoryMock = vi.fn().mockResolvedValue(undefined);
    const dbWithStore = createMockDb({ storeMemory: storeMemoryMock });
    const embedBatchMock = vi.fn().mockResolvedValue([[0.1, 0.2]]);
    const embeddings = createMockEmbeddings({ embedBatch: embedBatchMock });

    // Only rateImportance should be called (no decomposition LLM call)
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: JSON.stringify({ score: 8 }) } }],
        }),
    });

    const longText =
      "I prefer TypeScript over JavaScript. I also like Neo4j for graph databases. My team uses pnpm as the package manager.";

    await runAutoCapture(
      [{ role: "user", content: longText }],
      "test-agent",
      "session-1",
      dbWithStore,
      embeddings,
      enabledConfig,
      mockLogger,
      undefined, // signal
      false, // decompose=false
    );

    // embedBatch should be called with exactly one text (the original, not decomposed)
    expect(embedBatchMock).toHaveBeenCalledOnce();
    expect(embedBatchMock.mock.calls[0][0]).toHaveLength(1);
    expect(embedBatchMock.mock.calls[0][0][0]).toBe(longText);
  });

  it("should skip decomposition for texts shorter than 200 chars", async () => {
    const db = createMockDb();
    const storeMemoryMock = vi.fn().mockResolvedValue(undefined);
    const dbWithStore = createMockDb({ storeMemory: storeMemoryMock });
    const embedBatchMock = vi.fn().mockResolvedValue([[0.1, 0.2]]);
    const embeddings = createMockEmbeddings({ embedBatch: embedBatchMock });

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: JSON.stringify({ score: 8 }) } }],
        }),
    });

    // Text that passes the attention gate but is < 200 chars
    const shortText = "I prefer TypeScript over JavaScript for backend services.";

    await runAutoCapture(
      [{ role: "user", content: shortText }],
      "test-agent",
      "session-1",
      dbWithStore,
      embeddings,
      enabledConfig,
      mockLogger,
      undefined, // signal
      true, // decompose=true, but text is too short
    );

    // Should embed the original text unchanged (no decomposition LLM call means
    // fetch was only called for rateImportance, not decomposition)
    expect(embedBatchMock).toHaveBeenCalledOnce();
    expect(embedBatchMock.mock.calls[0][0][0]).toBe(shortText);
    // Only one fetch call (rateImportance), no decomposition LLM call
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("should expand multi-fact text into multiple stored memories when decompose=true", async () => {
    const storeMemoryMock = vi.fn().mockResolvedValue(undefined);
    const dbWithStore = createMockDb({ storeMemory: storeMemoryMock });
    const embedBatchMock = vi.fn().mockResolvedValue([
      [0.1, 0.2],
      [0.3, 0.4],
      [0.5, 0.6],
    ]);
    const embeddings = createMockEmbeddings({ embedBatch: embedBatchMock });

    // Helper: SSE stream body for callOpenRouterStream (decomposeIntoAtomicFacts)
    const factsJson = JSON.stringify({
      facts: [
        "I prefer TypeScript over JavaScript for backend services.",
        "I use Neo4j as my primary graph database.",
        "My team adopted pnpm as the package manager.",
      ],
    });
    const encoder = new TextEncoder();
    const sseBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ choices: [{ delta: { content: factsJson } }] })}\n\ndata: [DONE]\n\n`,
          ),
        );
        controller.close();
      },
    });

    // First call: decomposition (streaming); subsequent: rateImportance (non-streaming)
    let fetchCallCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      fetchCallCount++;
      if (fetchCallCount === 1) {
        return Promise.resolve({ ok: true, body: sseBody });
      }
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: JSON.stringify({ score: 8 }) } }],
          }),
      });
    });

    // Text >= 200 chars to trigger decomposition
    const multiFactText =
      "I prefer TypeScript over JavaScript for backend services and type safety. " +
      "I use Neo4j as my primary graph database for all relationship queries. " +
      "My team adopted pnpm as the package manager for all our Node.js monorepo projects.";

    await runAutoCapture(
      [{ role: "user", content: multiFactText }],
      "test-agent",
      "session-1",
      dbWithStore,
      embeddings,
      enabledConfig,
      mockLogger,
      undefined, // signal
      true, // decompose=true
    );

    // embedBatch should receive 3 atomic facts instead of 1 original text
    expect(embedBatchMock).toHaveBeenCalledOnce();
    expect(embedBatchMock.mock.calls[0][0]).toHaveLength(3);
    // All 3 facts should be stored independently
    expect(storeMemoryMock).toHaveBeenCalledTimes(3);
  });

  it("should run dedup independently for each atomic fact", async () => {
    const findSimilarMock = vi
      .fn()
      // First fact: has a duplicate (score >= 0.95) → skip
      .mockResolvedValueOnce([{ id: "dup-1", text: "I prefer TypeScript", score: 0.97 }])
      // Second fact: no duplicate → store
      .mockResolvedValue([]);

    const storeMemoryMock = vi.fn().mockResolvedValue(undefined);
    const dbWithStore = createMockDb({
      findSimilar: findSimilarMock,
      storeMemory: storeMemoryMock,
    });
    const embedBatchMock = vi.fn().mockResolvedValue([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    const embeddings = createMockEmbeddings({ embedBatch: embedBatchMock });

    const factsJson2 = JSON.stringify({
      facts: [
        "I prefer TypeScript over JavaScript for all my development work.",
        "I use Neo4j as my graph database for all relationship queries in production.",
      ],
    });
    const encoder2 = new TextEncoder();
    const sseBody2 = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder2.encode(
            `data: ${JSON.stringify({ choices: [{ delta: { content: factsJson2 } }] })}\n\ndata: [DONE]\n\n`,
          ),
        );
        controller.close();
      },
    });

    let fetchCallCount2 = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      fetchCallCount2++;
      if (fetchCallCount2 === 1) {
        return Promise.resolve({ ok: true, body: sseBody2 });
      }
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: JSON.stringify({ score: 8 }) } }],
          }),
      });
    });

    // Text >= 200 chars to ensure decomposition runs
    const multiFactText =
      "I strongly prefer TypeScript over JavaScript for all my development work because of superior type safety and tooling. " +
      "I also rely on Neo4j as my graph database for all relationship queries in production systems at work.";

    await runAutoCapture(
      [{ role: "user", content: multiFactText }],
      "test-agent",
      "session-1",
      dbWithStore,
      embeddings,
      enabledConfig,
      mockLogger,
      undefined, // signal
      true, // decompose=true
    );

    // findSimilar called once per fact
    expect(findSimilarMock).toHaveBeenCalledTimes(2);
    // Only the second fact stored (first was an exact duplicate)
    expect(storeMemoryMock).toHaveBeenCalledTimes(1);
  });
});
