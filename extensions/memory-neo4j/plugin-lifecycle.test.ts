/**
 * E2E plugin lifecycle tests for memory-neo4j.
 *
 * Exercises the real register() function with fully mocked dependencies
 * to verify the full lifecycle: register -> start -> tool calls -> stop.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ============================================================================
// Module mocks — must be hoisted before imports
// ============================================================================

// Mock Neo4j driver with a proper Neo4jError class for instanceof checks in errors.ts
vi.mock("neo4j-driver", () => {
  class Neo4jError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.code = code;
      this.name = "Neo4jError";
    }
  }

  const mockSession = {
    run: vi.fn().mockResolvedValue({ records: [] }),
    executeRead: vi.fn().mockResolvedValue([]),
    executeWrite: vi.fn().mockResolvedValue([]),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const mockDriver = {
    session: vi.fn(() => mockSession),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return {
    default: {
      driver: vi.fn(() => mockDriver),
      auth: { basic: vi.fn(() => ({})) },
      Neo4jError,
    },
    Neo4jError,
    __mockDriver: mockDriver,
    __mockSession: mockSession,
  };
});

// Mock the Neo4jMemoryClient at the module level so register() builds a mock instance
const mockDbInstance = {
  ensureInitialized: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
  findSimilar: vi.fn().mockResolvedValue([]),
  storeMemory: vi.fn().mockResolvedValue(undefined),
  deleteMemory: vi.fn().mockResolvedValue(true),
  vectorSearch: vi.fn().mockResolvedValue([]),
  detectConflicts: vi.fn().mockResolvedValue(0),
  createSession: vi.fn(),
  searchCache: undefined,
};

vi.mock("./neo4j-client.js", () => {
  class MockNeo4jMemoryClient {
    ensureInitialized = mockDbInstance.ensureInitialized;
    close = mockDbInstance.close;
    findSimilar = mockDbInstance.findSimilar;
    storeMemory = mockDbInstance.storeMemory;
    deleteMemory = mockDbInstance.deleteMemory;
    vectorSearch = mockDbInstance.vectorSearch;
    detectConflicts = mockDbInstance.detectConflicts;
    createSession = mockDbInstance.createSession;
    searchCache = mockDbInstance.searchCache;
  }
  return { Neo4jMemoryClient: MockNeo4jMemoryClient };
});

vi.mock("./embeddings.js", () => {
  class MockEmbeddings {
    embed = vi.fn().mockResolvedValue(new Array(768).fill(0.1));
  }
  return { Embeddings: MockEmbeddings };
});

vi.mock("./search.js", () => ({
  hybridSearch: vi.fn().mockResolvedValue([]),
}));

vi.mock("./auto-capture.js", () => ({
  runAutoCapture: vi.fn().mockResolvedValue(undefined),
  _captureMessage: vi.fn(),
  _runAutoCapture: vi.fn(),
}));

vi.mock("./sleep-cycle.js", () => ({
  runSleepCycle: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./llm-client.js", () => ({
  setPluginLlm: vi.fn(),
  callLlm: vi.fn().mockResolvedValue(""),
}));

vi.mock("croner", () => {
  const Cron = vi.fn().mockImplementation(() => ({
    stop: vi.fn(),
  }));
  return { Cron };
});

import neo4j from "neo4j-driver";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import memoryNeo4jPlugin from "./index.js";
import { hybridSearch } from "./search.js";

// ============================================================================
// Helpers
// ============================================================================

type ToolFactory = (ctx: { agentId?: string; sessionKey?: string }) => {
  name: string;
  execute: (toolCallId: string, params: unknown) => Promise<unknown>;
};

type ServiceRegistration = {
  id: string;
  start: (ctx: unknown) => Promise<void>;
  stop?: (ctx: unknown) => Promise<void>;
};

type HookHandler = (...args: unknown[]) => unknown;

function createMockApi(): {
  api: OpenClawPluginApi;
  tools: Map<string, ToolFactory>;
  services: Map<string, ServiceRegistration>;
  hooks: Map<string, HookHandler>;
} {
  const tools = new Map<string, ToolFactory>();
  const services = new Map<string, ServiceRegistration>();
  const hooks = new Map<string, HookHandler>();

  const api = {
    id: "test-plugin",
    name: "Test Plugin",
    source: "test",
    config: {},
    pluginConfig: {
      neo4j: {
        uri: "bolt://localhost:7687",
        username: "neo4j",
        password: "testpassword",
      },
      embedding: {
        provider: "ollama",
        model: "nomic-embed-text",
      },
      autoCapture: false,
      autoRecall: false,
      coreMemory: { enabled: false },
      sleepCycle: {},
      conflictDetection: { enabled: false },
      decomposition: { enabled: false },
    },
    runtime: {
      llm: {
        callModel: vi.fn().mockResolvedValue({ text: "" }),
      },
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    registerTool: vi.fn((factoryOrTool: ToolFactory, opts?: { name?: string }) => {
      const name = opts?.name ?? "unknown";
      tools.set(name, factoryOrTool);
    }),
    registerHook: vi.fn(),
    registerHttpRoute: vi.fn(),
    registerChannel: vi.fn(),
    registerGatewayMethod: vi.fn(),
    registerCli: vi.fn(),
    registerService: vi.fn((service: ServiceRegistration) => {
      services.set(service.id, service);
    }),
    registerProvider: vi.fn(),
    registerCommand: vi.fn(),
    registerContextEngine: vi.fn(),
    resolvePath: vi.fn((p: string) => p),
    on: vi.fn((hookName: string, handler: HookHandler) => {
      hooks.set(hookName, handler);
    }),
  } as unknown as OpenClawPluginApi;

  return { api, tools, services, hooks };
}

/** Get a tool's execute function by calling the factory with a default context. */
function getToolExecute(
  tools: Map<string, ToolFactory>,
  toolName: string,
): (toolCallId: string, params: unknown) => Promise<unknown> {
  const factory = tools.get(toolName);
  if (!factory) throw new Error(`Tool "${toolName}" not registered`);
  const tool = factory({ agentId: "test-agent", sessionKey: "test-session" });
  return tool.execute;
}

// ============================================================================
// Tests
// ============================================================================

describe("plugin lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mock defaults
    mockDbInstance.ensureInitialized.mockResolvedValue(undefined);
    mockDbInstance.close.mockResolvedValue(undefined);
    mockDbInstance.findSimilar.mockResolvedValue([]);
    mockDbInstance.storeMemory.mockResolvedValue(undefined);
    mockDbInstance.deleteMemory.mockResolvedValue(true);
    mockDbInstance.vectorSearch.mockResolvedValue([]);
    mockDbInstance.detectConflicts.mockResolvedValue(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --------------------------------------------------------------------------
  // Test 1: Plugin registers and starts successfully
  // --------------------------------------------------------------------------

  describe("register and start", () => {
    it("registers tools and starts service without error", async () => {
      const { api, tools, services } = createMockApi();

      // Register the plugin
      memoryNeo4jPlugin.register(api);

      // Verify tools were registered
      expect(tools.has("memory_recall")).toBe(true);
      expect(tools.has("memory_store")).toBe(true);
      expect(tools.has("memory_forget")).toBe(true);

      // Verify service was registered
      expect(services.has("memory-neo4j")).toBe(true);

      // Start the service
      const service = services.get("memory-neo4j")!;
      await expect(service.start({})).resolves.not.toThrow();

      // Verify initialization was called
      expect(mockDbInstance.ensureInitialized).toHaveBeenCalledTimes(1);

      // Verify logger reported successful start
      expect(api.logger.info).toHaveBeenCalledWith(expect.stringContaining("service started"));
    });

    it("registers all three expected tool names", () => {
      const { api } = createMockApi();
      memoryNeo4jPlugin.register(api);

      // registerTool should have been called at least 3 times (recall, store, forget)
      expect(api.registerTool).toHaveBeenCalledWith(expect.any(Function), {
        name: "memory_recall",
      });
      expect(api.registerTool).toHaveBeenCalledWith(expect.any(Function), { name: "memory_store" });
      expect(api.registerTool).toHaveBeenCalledWith(expect.any(Function), {
        name: "memory_forget",
      });
    });
  });

  // --------------------------------------------------------------------------
  // Test 2: Tool calls work after service start (store -> recall -> forget)
  // --------------------------------------------------------------------------

  describe("tool call lifecycle: store -> recall -> forget", () => {
    it("stores, recalls, and forgets a memory", async () => {
      const { api, tools, services } = createMockApi();

      memoryNeo4jPlugin.register(api);

      // Start the service
      const service = services.get("memory-neo4j")!;
      await service.start({});

      // --- memory_store ---
      // findSimilar returns no duplicates (default mock)
      const storeExecute = getToolExecute(tools, "memory_store");
      const storeResult = (await storeExecute("call-1", {
        text: "E2E test memory",
        importance: 0.8,
        category: "fact",
      })) as {
        content: Array<{ type: string; text: string }>;
        details: { action: string; id: string };
      };

      // Verify store succeeded with a created action
      expect(storeResult.details.action).toBe("created");
      expect(storeResult.details.id).toBeDefined();
      expect(typeof storeResult.details.id).toBe("string");
      expect(storeResult.content[0].text).toContain("E2E test memory");

      // Verify storeMemory was called on the client
      expect(mockDbInstance.storeMemory).toHaveBeenCalledOnce();
      expect(mockDbInstance.storeMemory).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "E2E test memory",
          category: "fact",
          importance: 0.8,
        }),
      );

      const storedId = storeResult.details.id;

      // --- memory_recall ---
      const mockHybridSearch = hybridSearch as ReturnType<typeof vi.fn>;
      mockHybridSearch.mockResolvedValueOnce([
        {
          id: storedId,
          text: "E2E test memory",
          category: "fact",
          importance: 0.8,
          score: 0.92,
          signals: { vector: { rank: 1 }, bm25: { rank: 0 }, graph: { rank: 0 } },
        },
      ]);

      const recallExecute = getToolExecute(tools, "memory_recall");
      const recallResult = (await recallExecute("call-2", {
        query: "E2E test",
        limit: 5,
      })) as {
        content: Array<{ type: string; text: string }>;
        details: { count: number; memories: Array<{ id: string; text: string }> };
      };

      // Verify recall found the stored memory
      expect(recallResult.details.count).toBe(1);
      expect(recallResult.details.memories).toHaveLength(1);
      expect(recallResult.details.memories[0].id).toBe(storedId);
      expect(recallResult.details.memories[0].text).toBe("E2E test memory");
      expect(recallResult.content[0].text).toContain("Found 1 memories");

      // --- memory_forget ---
      // deleteMemory returns true (deleted)
      mockDbInstance.deleteMemory.mockResolvedValueOnce(true);

      const forgetExecute = getToolExecute(tools, "memory_forget");
      const forgetResult = (await forgetExecute("call-3", {
        memoryId: storedId,
      })) as {
        content: Array<{ type: string; text: string }>;
        details: { action: string; id: string };
      };

      // Verify forget succeeded
      expect(forgetResult.details.action).toBe("deleted");
      expect(forgetResult.details.id).toBe(storedId);
      expect(forgetResult.content[0].text).toContain("forgotten");
    });

    it("memory_recall returns empty when no memories match", async () => {
      const { api, tools, services } = createMockApi();
      memoryNeo4jPlugin.register(api);
      await services.get("memory-neo4j")!.start({});

      const mockHybridSearch = hybridSearch as ReturnType<typeof vi.fn>;
      mockHybridSearch.mockResolvedValueOnce([]);

      const recallExecute = getToolExecute(tools, "memory_recall");
      const result = (await recallExecute("call-1", {
        query: "nonexistent topic",
      })) as { content: Array<{ type: string; text: string }>; details: { count: number } };

      expect(result.details.count).toBe(0);
      expect(result.content[0].text).toBe("No relevant memories found.");
    });

    it("memory_store detects duplicates via findSimilar", async () => {
      const { api, tools, services } = createMockApi();
      memoryNeo4jPlugin.register(api);
      await services.get("memory-neo4j")!.start({});

      // Mock findSimilar to return an existing duplicate
      mockDbInstance.findSimilar.mockResolvedValueOnce([
        { id: "existing-id", text: "E2E test memory", score: 0.97 },
      ]);

      const storeExecute = getToolExecute(tools, "memory_store");
      const result = (await storeExecute("call-1", {
        text: "E2E test memory",
        importance: 0.8,
      })) as {
        content: Array<{ type: string; text: string }>;
        details: { action: string; existingId?: string };
      };

      // Verify duplicate detected
      expect(result.details.action).toBe("duplicate");
      expect(result.details.existingId).toBe("existing-id");
      expect(result.content[0].text).toContain("Similar memory already exists");

      // Verify storeMemory was NOT called (short-circuited by duplicate check)
      expect(mockDbInstance.storeMemory).not.toHaveBeenCalled();
    });

    it("memory_forget returns not_found for unknown ID", async () => {
      const { api, tools, services } = createMockApi();
      memoryNeo4jPlugin.register(api);
      await services.get("memory-neo4j")!.start({});

      // Mock deleteMemory returning false (not found)
      mockDbInstance.deleteMemory.mockResolvedValueOnce(false);

      const forgetExecute = getToolExecute(tools, "memory_forget");
      const result = (await forgetExecute("call-1", {
        memoryId: "nonexistent-id",
      })) as {
        content: Array<{ type: string; text: string }>;
        details: { action: string; id: string };
      };

      expect(result.details.action).toBe("not_found");
      expect(result.details.id).toBe("nonexistent-id");
      expect(result.content[0].text).toContain("not found");
    });
  });

  // --------------------------------------------------------------------------
  // Test 3: Service stop drains captures and closes connection
  // --------------------------------------------------------------------------

  describe("service stop", () => {
    it("closes the Neo4j driver on stop", async () => {
      const { api, services } = createMockApi();
      memoryNeo4jPlugin.register(api);

      const service = services.get("memory-neo4j")!;
      await service.start({});

      // Reset mock to track close call
      mockDbInstance.close.mockClear();

      // Stop the service
      await service.stop!({});

      // Verify the client's close() was called
      expect(mockDbInstance.close).toHaveBeenCalledTimes(1);

      // Verify logger reported stop
      expect(api.logger.info).toHaveBeenCalledWith("memory-neo4j: service stopped");
    });

    it("handles stop when no captures are in-flight", async () => {
      const { api, services } = createMockApi();
      memoryNeo4jPlugin.register(api);

      const service = services.get("memory-neo4j")!;
      await service.start({});

      // Should complete without errors even with no in-flight captures
      await expect(service.stop!({})).resolves.not.toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // Test 4: Service handles Neo4j unavailability gracefully
  // --------------------------------------------------------------------------

  describe("Neo4j unavailability", () => {
    it("start completes without throwing when Neo4j is unreachable", async () => {
      const { api, services } = createMockApi();

      // Make ensureInitialized fail (simulating connection error)
      mockDbInstance.ensureInitialized.mockRejectedValueOnce(
        new Error("ServiceUnavailable: connection refused"),
      );

      memoryNeo4jPlugin.register(api);

      const service = services.get("memory-neo4j")!;

      // Should NOT throw — graceful degradation
      await expect(service.start({})).resolves.not.toThrow();

      // Verify error was logged
      expect(api.logger.error).toHaveBeenCalledWith(expect.stringContaining("failed to start"));
    });

    it("logs connection error details when Neo4j is unavailable", async () => {
      const { api, services } = createMockApi();

      const connectionError = new Error(
        "ServiceUnavailable: connection refused to bolt://localhost:7687",
      );
      mockDbInstance.ensureInitialized.mockRejectedValueOnce(connectionError);

      memoryNeo4jPlugin.register(api);

      const service = services.get("memory-neo4j")!;
      await service.start({});

      // Verify the error message includes the connection error text
      expect(api.logger.error).toHaveBeenCalledWith(expect.stringContaining("connection refused"));

      // Verify it mentions lazy initialization fallback
      expect(api.logger.error).toHaveBeenCalledWith(expect.stringContaining("lazy initialization"));
    });
  });
});
