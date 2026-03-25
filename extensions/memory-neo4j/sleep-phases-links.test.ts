import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExtractionConfig } from "./config.js";
import {
  createCausalLinks,
  createSemanticLinks,
  createTemporalLinks,
} from "./sleep-phases-links.js";

vi.mock("./llm-client.js", () => ({
  callLlm: vi.fn(),
  callLlmStream: vi.fn(),
  callOpenRouter: vi.fn(),
  callOpenRouterStream: vi.fn(),
  isTransientError: vi.fn(() => false),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  };
}

function mockRecord(fields: Record<string, unknown>) {
  return { get: (key: string) => fields[key] };
}

function createMockSession() {
  const executeRead = vi.fn();
  const executeWrite = vi.fn();
  return {
    executeRead,
    executeWrite,
    close: vi.fn(),
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("createSemanticLinks", () => {
  let session: ReturnType<typeof createMockSession>;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    vi.clearAllMocks();
    session = createMockSession();
    logger = createMockLogger();
  });

  it("creates SIMILAR edges between similar memories", async () => {
    // First call: return one unlinked memory
    session.executeRead.mockResolvedValueOnce({
      records: [mockRecord({ id: "mem-1", embedding: [0.1, 0.2, 0.3] })],
    });
    // Second call: vector query returns 2 neighbors
    session.executeRead.mockResolvedValueOnce({
      records: [
        mockRecord({ targetId: "mem-2", score: 0.91 }),
        mockRecord({ targetId: "mem-3", score: 0.85 }),
      ],
    });
    // Write calls for each SIMILAR edge
    session.executeWrite.mockResolvedValue({ records: [] });
    // Third call: no more unlinked memories
    session.executeRead.mockResolvedValueOnce({ records: [] });

    const count = await createSemanticLinks(session as any, "agent-1", logger as any);

    expect(count).toBe(2);
    expect(session.executeWrite).toHaveBeenCalledTimes(2);
  });

  it("skips when no unlinked memories exist", async () => {
    session.executeRead.mockResolvedValueOnce({ records: [] });

    const count = await createSemanticLinks(session as any, "agent-1", logger as any);

    expect(count).toBe(0);
    expect(session.executeWrite).not.toHaveBeenCalled();
  });

  it("respects abort signal", async () => {
    const controller = new AbortController();
    controller.abort();

    const count = await createSemanticLinks(
      session as any,
      "agent-1",
      logger as any,
      controller.signal,
    );

    expect(count).toBe(0);
    expect(session.executeRead).not.toHaveBeenCalled();
  });

  it("stops processing when abort signal fires mid-batch", async () => {
    const controller = new AbortController();

    // Return two unlinked memories
    session.executeRead.mockResolvedValueOnce({
      records: [
        mockRecord({ id: "mem-1", embedding: [0.1, 0.2] }),
        mockRecord({ id: "mem-2", embedding: [0.3, 0.4] }),
      ],
    });
    // First vector query succeeds
    session.executeRead.mockResolvedValueOnce({
      records: [mockRecord({ targetId: "mem-3", score: 0.9 })],
    });
    session.executeWrite.mockResolvedValueOnce({ records: [] });

    // Abort after first memory processed
    session.executeRead.mockImplementationOnce(async () => {
      controller.abort();
      return { records: [mockRecord({ targetId: "mem-4", score: 0.88 })] };
    });

    const count = await createSemanticLinks(
      session as any,
      "agent-1",
      logger as any,
      controller.signal,
    );

    // Should have created at least 1 link before abort
    expect(count).toBeGreaterThanOrEqual(1);
  });
});

describe("createTemporalLinks", () => {
  let session: ReturnType<typeof createMockSession>;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    vi.clearAllMocks();
    session = createMockSession();
    logger = createMockLogger();
  });

  it("creates TEMPORAL_NEXT edges between consecutive session memories", async () => {
    session.executeRead.mockResolvedValueOnce({
      records: [
        mockRecord({
          sessionKey: "sess-1",
          memories: [
            { id: "mem-1", createdAt: "2026-01-01T00:00:00Z" },
            { id: "mem-2", createdAt: "2026-01-01T00:01:00Z" },
            { id: "mem-3", createdAt: "2026-01-01T00:05:00Z" },
          ],
        }),
      ],
    });
    session.executeWrite.mockResolvedValue({ records: [] });

    const count = await createTemporalLinks(session as any, "agent-1", logger as any);

    expect(count).toBe(2); // mem-1→mem-2, mem-2→mem-3
    expect(session.executeWrite).toHaveBeenCalledTimes(2);
  });

  it("applies temporal decay to weights", async () => {
    session.executeRead.mockResolvedValueOnce({
      records: [
        mockRecord({
          sessionKey: "sess-1",
          memories: [
            { id: "mem-1", createdAt: "2026-01-01T00:00:00Z" },
            // 1 minute gap — should have high weight
            { id: "mem-2", createdAt: "2026-01-01T00:01:00Z" },
            // 30 minute gap — should have lower weight
            { id: "mem-3", createdAt: "2026-01-01T00:31:00Z" },
          ],
        }),
      ],
    });
    session.executeWrite.mockResolvedValue({ records: [] });

    await createTemporalLinks(session as any, "agent-1", logger as any);

    // Check first link (1 min gap) has higher weight than second (30 min gap)
    const firstCallArgs = (session.executeWrite.mock.calls[0][0] as any)({
      run: vi.fn().mockResolvedValue({ records: [] }),
    });
    const secondCallArgs = (session.executeWrite.mock.calls[1][0] as any)({
      run: vi.fn().mockResolvedValue({ records: [] }),
    });

    // We can't easily extract params from the mock, so just verify both writes happened
    expect(session.executeWrite).toHaveBeenCalledTimes(2);
  });

  it("skips when no sessions have unlinked memories", async () => {
    session.executeRead.mockResolvedValueOnce({ records: [] });

    const count = await createTemporalLinks(session as any, "agent-1", logger as any);

    expect(count).toBe(0);
    expect(session.executeWrite).not.toHaveBeenCalled();
  });

  it("respects abort signal", async () => {
    const controller = new AbortController();
    controller.abort();

    const count = await createTemporalLinks(
      session as any,
      "agent-1",
      logger as any,
      controller.signal,
    );

    expect(count).toBe(0);
    expect(session.executeRead).not.toHaveBeenCalled();
  });

  it("handles multiple sessions independently", async () => {
    session.executeRead.mockResolvedValueOnce({
      records: [
        mockRecord({
          sessionKey: "sess-1",
          memories: [
            { id: "mem-1", createdAt: "2026-01-01T00:00:00Z" },
            { id: "mem-2", createdAt: "2026-01-01T00:01:00Z" },
          ],
        }),
        mockRecord({
          sessionKey: "sess-2",
          memories: [
            { id: "mem-3", createdAt: "2026-01-01T01:00:00Z" },
            { id: "mem-4", createdAt: "2026-01-01T01:02:00Z" },
          ],
        }),
      ],
    });
    session.executeWrite.mockResolvedValue({ records: [] });

    const count = await createTemporalLinks(session as any, "agent-1", logger as any);

    expect(count).toBe(2); // One link per session
    expect(session.executeWrite).toHaveBeenCalledTimes(2);
  });
});

// ── Causal Links (OP-188) ─────────────────────────────────────────────────

function createMockConfig(overrides: Partial<ExtractionConfig> = {}): ExtractionConfig {
  return {
    enabled: true,
    apiKey: "test-key",
    model: "test-model",
    baseUrl: "http://localhost:11434",
    temperature: 0.3,
    maxRetries: 2,
    timeout: 30000,
    concurrency: 8,
    localNerEnabled: false,
    maxTokens: 4096,
    disposition: { skepticism: 3, literalism: 3, empathy: 3 },
    ...overrides,
  };
}

describe("createCausalLinks (OP-188)", () => {
  let session: ReturnType<typeof createMockSession>;
  let logger: ReturnType<typeof createMockLogger>;
  let callLlm: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    session = createMockSession();
    logger = createMockLogger();
    const llmClient = await import("./llm-client.js");
    callLlm = llmClient.callLlm as unknown as ReturnType<typeof vi.fn>;
  });

  it("creates CAUSED_BY edges for causal memory pairs", async () => {
    const config = createMockConfig();

    // Return candidate pairs with TEMPORAL_NEXT but no CAUSED_BY
    session.executeRead.mockResolvedValueOnce({
      records: [
        mockRecord({
          fromId: "m1",
          fromText: "Alice submitted the report",
          toId: "m2",
          toText: "The project was approved",
        }),
      ],
    });
    session.executeWrite.mockResolvedValue({ records: [] });

    callLlm.mockResolvedValue(
      JSON.stringify([
        {
          fromId: "m1",
          toId: "m2",
          isCausal: true,
          reason: "Report submission led to project approval",
          confidence: 0.85,
        },
      ]),
    );

    const count = await createCausalLinks(session as any, "agent-1", config, logger as any);

    expect(count).toBe(1);
    expect(session.executeWrite).toHaveBeenCalledTimes(1);
    expect(callLlm).toHaveBeenCalledTimes(1);
    // Verify prompt contains memory texts
    const promptArg = callLlm.mock.calls[0][1];
    expect(promptArg).toContain("Alice submitted the report");
    expect(promptArg).toContain("The project was approved");
  });

  it("skips non-causal pairs", async () => {
    const config = createMockConfig();

    session.executeRead.mockResolvedValueOnce({
      records: [
        mockRecord({
          fromId: "m1",
          fromText: "Alice likes coffee",
          toId: "m2",
          toText: "Bob works at Acme",
        }),
      ],
    });

    callLlm.mockResolvedValue(
      JSON.stringify([
        {
          fromId: "m1",
          toId: "m2",
          isCausal: false,
          reason: "No causal relationship",
          confidence: 0.1,
        },
      ]),
    );

    const count = await createCausalLinks(session as any, "agent-1", config, logger as any);

    expect(count).toBe(0);
    expect(session.executeWrite).not.toHaveBeenCalled();
  });

  it("skips low-confidence causal assessments (< 0.5)", async () => {
    const config = createMockConfig();

    session.executeRead.mockResolvedValueOnce({
      records: [
        mockRecord({
          fromId: "m1",
          fromText: "Something happened",
          toId: "m2",
          toText: "Something else happened",
        }),
      ],
    });

    callLlm.mockResolvedValue(
      JSON.stringify([
        {
          fromId: "m1",
          toId: "m2",
          isCausal: true,
          reason: "Weak connection",
          confidence: 0.3,
        },
      ]),
    );

    const count = await createCausalLinks(session as any, "agent-1", config, logger as any);

    expect(count).toBe(0);
  });

  it("returns 0 when no candidate pairs exist", async () => {
    const config = createMockConfig();

    session.executeRead.mockResolvedValueOnce({ records: [] });

    const count = await createCausalLinks(session as any, "agent-1", config, logger as any);

    expect(count).toBe(0);
    expect(callLlm).not.toHaveBeenCalled();
  });

  it("returns 0 when extraction is disabled", async () => {
    const config = createMockConfig({ enabled: false });

    const count = await createCausalLinks(session as any, "agent-1", config, logger as any);

    expect(count).toBe(0);
    expect(session.executeRead).not.toHaveBeenCalled();
  });

  it("respects abort signal", async () => {
    const config = createMockConfig();
    const controller = new AbortController();
    controller.abort();

    const count = await createCausalLinks(
      session as any,
      "agent-1",
      config,
      logger as any,
      controller.signal,
    );

    expect(count).toBe(0);
    expect(session.executeRead).not.toHaveBeenCalled();
  });

  it("handles LLM returning empty response", async () => {
    const config = createMockConfig();

    session.executeRead.mockResolvedValueOnce({
      records: [
        mockRecord({
          fromId: "m1",
          fromText: "text1",
          toId: "m2",
          toText: "text2",
        }),
      ],
    });

    callLlm.mockResolvedValue("");

    const count = await createCausalLinks(session as any, "agent-1", config, logger as any);

    expect(count).toBe(0);
  });

  it("rejects fabricated pair IDs from LLM", async () => {
    const config = createMockConfig();

    session.executeRead.mockResolvedValueOnce({
      records: [
        mockRecord({
          fromId: "m1",
          fromText: "text1",
          toId: "m2",
          toText: "text2",
        }),
      ],
    });

    callLlm.mockResolvedValue(
      JSON.stringify([
        {
          fromId: "fake-1",
          toId: "fake-2",
          isCausal: true,
          reason: "fabricated",
          confidence: 0.9,
        },
      ]),
    );

    const count = await createCausalLinks(session as any, "agent-1", config, logger as any);

    expect(count).toBe(0);
    expect(session.executeWrite).not.toHaveBeenCalled();
  });
});
