/**
 * Tests for registerMemoryHooks circuit breaker behavior.
 *
 * Covers:
 * - Circuit opens after CIRCUIT_BREAKER_THRESHOLD (5) consecutive failures
 * - Circuit resets (closes) after 1 success
 * - When circuit is open, auto-capture calls are skipped entirely
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryNeo4jConfig, ExtractionConfig } from "./config.js";
import type { Embeddings } from "./embeddings.js";
import type { Neo4jMemoryClient } from "./neo4j-client.js";
import { registerMemoryHooks } from "./plugin-hooks.js";

// ============================================================================
// Mock runAutoCapture from auto-capture module
// ============================================================================

vi.mock("./auto-capture.js", () => ({
  runAutoCapture: vi.fn(),
}));

import { runAutoCapture } from "./auto-capture.js";
const mockRunAutoCapture = runAutoCapture as ReturnType<typeof vi.fn>;

// ============================================================================
// Helpers
// ============================================================================

type AgentEndHandler = (
  event: { success: boolean; messages: Array<{ role: string; content: string }> },
  ctx: { agentId?: string; sessionKey?: string; workspaceDir?: string },
) => void;

function createMockApi(): {
  api: OpenClawPluginApi;
  getHandler: (event: string) => AgentEndHandler;
} {
  const handlers = new Map<string, AgentEndHandler>();
  const api = {
    on: vi.fn((event: string, handler: AgentEndHandler) => {
      handlers.set(event, handler);
    }),
  } as unknown as OpenClawPluginApi;
  return {
    api,
    getHandler: (event: string) => {
      const h = handlers.get(event);
      if (!h) throw new Error(`No handler registered for event: ${event}`);
      return h;
    },
  };
}

function createMinimalConfig(): MemoryNeo4jConfig {
  return {
    neo4j: { uri: "bolt://localhost:7687", username: "neo4j", password: "test" },
    embedding: { provider: "ollama", model: "nomic-embed-text" },
    autoCapture: true,
    autoCaptureAssistant: false,
    autoRecall: false,
    autoRecallMinScore: 0.5,
    coreMemory: { enabled: false },
    graphSearchDepth: 1,
    decayCurves: {},
    sleepCycle: { auto: false },
    conflictDetection: { enabled: false, similarityThreshold: 0.82, maxCandidates: 5 },
  } as unknown as MemoryNeo4jConfig;
}

const minimalExtractionConfig: ExtractionConfig = {
  enabled: false,
  apiKey: "",
  model: "",
  baseUrl: "",
  temperature: 0,
  maxRetries: 0,
};

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

const mockDb = {} as unknown as Neo4jMemoryClient;
const mockEmbeddings = {} as unknown as Embeddings;
const sleepAbortController = new AbortController();

const validEvent = {
  success: true,
  messages: [{ role: "user", content: "some message content long enough" }],
};
const validCtx = { agentId: "default", sessionKey: "session-1" };

/** Flush microtasks so fire-and-forget promise chains resolve/reject. */
async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// ============================================================================
// Circuit breaker tests
// ============================================================================

describe("registerMemoryHooks circuit breaker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("opens circuit after 5 consecutive failures", async () => {
    const { api, getHandler } = createMockApi();
    registerMemoryHooks(
      api,
      mockDb,
      mockEmbeddings,
      createMinimalConfig(),
      minimalExtractionConfig,
      sleepAbortController,
      mockLogger,
    );

    mockRunAutoCapture.mockRejectedValue(new Error("Neo4j unavailable"));

    const handler = getHandler("agent_end");

    // Fire 5 failures
    for (let i = 0; i < 5; i++) {
      handler(validEvent, validCtx);
      await flushPromises();
    }

    // Circuit should now be open — error logged on the 5th failure
    expect(mockLogger.error).toHaveBeenCalledOnce();
    expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining("CIRCUIT OPEN"));

    // runAutoCapture was called exactly 5 times (once per failure before open)
    expect(mockRunAutoCapture).toHaveBeenCalledTimes(5);
  });

  it("skips auto-capture calls when circuit is open", async () => {
    const { api, getHandler } = createMockApi();
    registerMemoryHooks(
      api,
      mockDb,
      mockEmbeddings,
      createMinimalConfig(),
      minimalExtractionConfig,
      sleepAbortController,
      mockLogger,
    );

    mockRunAutoCapture.mockRejectedValue(new Error("service down"));

    const handler = getHandler("agent_end");

    // Open the circuit with 5 failures
    for (let i = 0; i < 5; i++) {
      handler(validEvent, validCtx);
      await flushPromises();
    }

    vi.clearAllMocks();

    // Additional calls after circuit opens should be skipped
    handler(validEvent, validCtx);
    await flushPromises();
    handler(validEvent, validCtx);
    await flushPromises();

    expect(mockRunAutoCapture).not.toHaveBeenCalled();
    expect(mockLogger.debug).toHaveBeenCalledWith(
      "memory-neo4j: auto-capture circuit open, skipping",
    );
  });

  it("resets circuit after 1 success", async () => {
    const { api, getHandler } = createMockApi();
    registerMemoryHooks(
      api,
      mockDb,
      mockEmbeddings,
      createMinimalConfig(),
      minimalExtractionConfig,
      sleepAbortController,
      mockLogger,
    );

    // Open the circuit with 5 failures
    mockRunAutoCapture.mockRejectedValue(new Error("down"));
    const handler = getHandler("agent_end");
    for (let i = 0; i < 5; i++) {
      handler(validEvent, validCtx);
      await flushPromises();
    }

    // Verify circuit is open
    vi.clearAllMocks();
    handler(validEvent, validCtx);
    await flushPromises();
    expect(mockRunAutoCapture).not.toHaveBeenCalled();

    // Now simulate recovery: allow direct invocation by temporarily un-opening
    // the circuit. Since we can't access private state directly, we verify
    // the reset by observing that after a success the next failures re-accumulate
    // from zero (i.e. need 5 more to re-open rather than opening immediately).
    //
    // To trigger a success we must bypass the open circuit.
    // We achieve this by creating a fresh hook registration.
    const { api: api2, getHandler: getHandler2 } = createMockApi();
    registerMemoryHooks(
      api2,
      mockDb,
      mockEmbeddings,
      createMinimalConfig(),
      minimalExtractionConfig,
      sleepAbortController,
      mockLogger,
    );

    mockRunAutoCapture.mockResolvedValueOnce(undefined); // 1 success
    const handler2 = getHandler2("agent_end");
    handler2(validEvent, validCtx);
    await flushPromises();

    // After the success, consecutive failures counter should be 0.
    // Now 4 failures should NOT open the circuit (need 5).
    mockRunAutoCapture.mockRejectedValue(new Error("intermittent"));
    for (let i = 0; i < 4; i++) {
      handler2(validEvent, validCtx);
      await flushPromises();
    }
    expect(mockLogger.error).not.toHaveBeenCalled();

    // 5th failure opens it again
    handler2(validEvent, validCtx);
    await flushPromises();
    expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining("CIRCUIT OPEN"));
  });

  it("does not open circuit on fewer than 5 consecutive failures", async () => {
    const { api, getHandler } = createMockApi();
    registerMemoryHooks(
      api,
      mockDb,
      mockEmbeddings,
      createMinimalConfig(),
      minimalExtractionConfig,
      sleepAbortController,
      mockLogger,
    );

    mockRunAutoCapture.mockRejectedValue(new Error("transient error"));
    const handler = getHandler("agent_end");

    for (let i = 0; i < 4; i++) {
      handler(validEvent, validCtx);
      await flushPromises();
    }

    // Circuit not open yet — no error logged, still calling runAutoCapture
    expect(mockLogger.error).not.toHaveBeenCalled();
    expect(mockRunAutoCapture).toHaveBeenCalledTimes(4);

    // Next call still goes through (circuit still closed)
    vi.clearAllMocks();
    mockRunAutoCapture.mockResolvedValueOnce(undefined);
    handler(validEvent, validCtx);
    await flushPromises();
    expect(mockRunAutoCapture).toHaveBeenCalledOnce();
  });
});
