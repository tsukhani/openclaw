/**
 * Conformance test for config.ts migration.
 *
 * Captures the exact parse behavior of memoryNeo4jConfigSchema.parse() across
 * a wide range of input shapes. When the implementation is migrated to TypeBox,
 * these tests assert that runtime behavior is identical.
 */

import { describe, it, expect, afterEach } from "vitest";
import { memoryNeo4jConfigSchema } from "./config.js";

const MINIMAL_NEO4J = { uri: "bolt://localhost:7687", password: "" };
const MINIMAL = { neo4j: MINIMAL_NEO4J, embedding: { provider: "ollama" as const } };

describe("config conformance", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  // --------------------------------------------------------------------------
  // 1. Minimal config
  // --------------------------------------------------------------------------
  it("minimal ollama config produces correct defaults", () => {
    const result = memoryNeo4jConfigSchema.parse(MINIMAL);
    expect(result.neo4j).toEqual({ uri: "bolt://localhost:7687", username: "neo4j", password: "" });
    expect(result.embedding).toEqual({
      provider: "ollama",
      apiKey: undefined,
      model: "mxbai-embed-large",
      baseUrl: undefined,
    });
    expect(result.autoCapture).toBe(true);
    expect(result.autoCaptureSkipPattern).toBeUndefined();
    expect(result.autoRecall).toBe(true);
    expect(result.autoRecallMinScore).toBe(0.25);
    expect(result.autoRecallSkipPattern).toBeUndefined();
    expect(result.coreMemory).toEqual({ enabled: true, refreshAtContextPercent: undefined });
    expect(result.graphSearchDepth).toBe(2);
    expect(result.graphSeedCap).toBeUndefined();
    expect(result.graphRelTypes).toBeUndefined();
    expect(result.graphCausalRelTypes).toBeUndefined();
    expect(result.decayCurves).toEqual({});
    expect(result.sleepCycle).toEqual({ schedule: null, tz: "local" });
    expect(result.conflictDetection).toEqual({
      enabled: true,
      model: undefined,
      similarityThreshold: 0.82,
      maxCandidates: 5,
      sleepScanBatchSize: 50,
    });
    expect(result.recencyWeight).toBe(0.1);
    expect(result.decomposition).toEqual({ enabled: false });
    expect(result.metrics).toBeUndefined();
    expect(result.reranker).toBeUndefined();
    expect(result.cache).toBeUndefined();
    expect(result.trustScoring).toEqual({ enabled: true, sourceDefaults: undefined });
    expect(result.communityDetection).toBeUndefined();
    expect(result.episodicMemory).toBeUndefined();
    expect(result.instructionDetection).toEqual({ enabled: true, llmFallback: false });
    expect(result.extraction).toBeUndefined();
  });

  // --------------------------------------------------------------------------
  // 2. Full config
  // --------------------------------------------------------------------------
  it("full config with all sections", () => {
    const result = memoryNeo4jConfigSchema.parse({
      neo4j: { uri: "neo4j+s://cloud:7687", username: "admin", password: "secret" },
      embedding: {
        provider: "openai",
        apiKey: "sk-test",
        model: "text-embedding-3-large",
        baseUrl: "https://api.openai.com/v1",
      },
      extraction: {
        apiKey: "or-key",
        model: "google/gemini-2.0-flash-001",
        baseUrl: "https://openrouter.ai/api/v1",
      },
      autoCapture: false,
      autoCaptureSkipPattern: "voice|realtime",
      autoRecall: false,
      autoRecallMinScore: 0.5,
      autoRecallSkipPattern: "^test-",
      coreMemory: { enabled: false, refreshAtContextPercent: 75 },
      graphSearchDepth: 3,
      graphSeedCap: 10,
      graphRelTypes: ["WORKS_AT", "KNOWS"],
      graphCausalRelTypes: ["CAUSED_BY", "LED_TO"],
      decayCurves: { core: { halfLifeDays: 60 }, fact: { halfLifeDays: 14 } },
      sleepCycle: { schedule: "0 3 * * *", tz: "America/New_York" },
      conflictDetection: {
        enabled: true,
        model: "gpt-4o",
        similarityThreshold: 0.9,
        maxCandidates: 10,
        sleepScanBatchSize: 100,
      },
      recencyWeight: 0.5,
      decomposition: { enabled: true },
      metrics: { enabled: true, logIntervalMs: 30000 },
      reranker: {
        enabled: true,
        provider: "llm",
        model: "cross-encoder/ms-marco-MiniLM-L-6-v2",
        topK: 20,
        topJ: 10,
        minScore: 0.3,
        extractionMode: "llm-temporal",
      },
      cache: { enabled: true, ttlMs: 60000, maxSize: 500 },
      trustScoring: {
        enabled: true,
        sourceDefaults: { "auto-capture": 0.8, import: 0.6 },
      },
      communityDetection: {
        enabled: true,
        minCommunitySize: 5,
        maxIterations: 20,
        signalWeight: 0.3,
      },
      episodicMemory: { enabled: true, captureAssistant: true, retentionDays: 60 },
      instructionDetection: { enabled: true, llmFallback: true },
    });

    expect(result.neo4j).toEqual({
      uri: "neo4j+s://cloud:7687",
      username: "admin",
      password: "secret",
    });
    expect(result.embedding).toEqual({
      provider: "openai",
      apiKey: "sk-test",
      model: "text-embedding-3-large",
      baseUrl: "https://api.openai.com/v1",
    });
    expect(result.extraction).toEqual({
      apiKey: "or-key",
      model: "google/gemini-2.0-flash-001",
      baseUrl: "https://openrouter.ai/api/v1",
    });
    expect(result.autoCapture).toBe(false);
    expect(result.autoCaptureSkipPattern).toEqual(/voice|realtime/);
    expect(result.autoRecall).toBe(false);
    expect(result.autoRecallMinScore).toBe(0.5);
    expect(result.autoRecallSkipPattern).toEqual(/^test-/);
    expect(result.coreMemory).toEqual({ enabled: false, refreshAtContextPercent: 75 });
    expect(result.graphSearchDepth).toBe(3);
    expect(result.graphSeedCap).toBe(10);
    expect(result.graphRelTypes).toEqual(["WORKS_AT", "KNOWS"]);
    expect(result.graphCausalRelTypes).toEqual(["CAUSED_BY", "LED_TO"]);
    expect(result.decayCurves).toEqual({ core: { halfLifeDays: 60 }, fact: { halfLifeDays: 14 } });
    expect(result.sleepCycle).toEqual({ schedule: "0 3 * * *", tz: "America/New_York" });
    expect(result.conflictDetection).toEqual({
      enabled: true,
      model: "gpt-4o",
      similarityThreshold: 0.9,
      maxCandidates: 10,
      sleepScanBatchSize: 100,
    });
    expect(result.recencyWeight).toBe(0.5);
    expect(result.decomposition).toEqual({ enabled: true });
    expect(result.metrics).toEqual({ enabled: true, logIntervalMs: 30000 });
    expect(result.reranker).toEqual({
      enabled: true,
      provider: "llm",
      model: "cross-encoder/ms-marco-MiniLM-L-6-v2",
      topK: 20,
      topJ: 10,
      minScore: 0.3,
      extractionMode: "llm-temporal",
    });
    expect(result.cache).toEqual({ enabled: true, ttlMs: 60000, maxSize: 500 });
    expect(result.trustScoring).toEqual({
      enabled: true,
      sourceDefaults: { "auto-capture": 0.8, import: 0.6 },
    });
    expect(result.communityDetection).toEqual({
      enabled: true,
      minCommunitySize: 5,
      maxIterations: 20,
      signalWeight: 0.3,
    });
    expect(result.episodicMemory).toEqual({
      enabled: true,
      captureAssistant: true,
      retentionDays: 60,
    });
    expect(result.instructionDetection).toEqual({ enabled: true, llmFallback: true });
  });

  // --------------------------------------------------------------------------
  // 3. Environment variable resolution
  // --------------------------------------------------------------------------
  it("resolves env vars in neo4j uri, password, user, and embedding.apiKey", () => {
    process.env.NEO4J_CONF_URI = "bolt+s://prod:7687";
    process.env.NEO4J_CONF_PASS = "s3cret";
    process.env.NEO4J_CONF_USER = "prod-user";
    process.env.OPENAI_CONF_KEY = "sk-prod";
    const result = memoryNeo4jConfigSchema.parse({
      neo4j: {
        uri: "${NEO4J_CONF_URI}",
        user: "${NEO4J_CONF_USER}",
        password: "${NEO4J_CONF_PASS}",
      },
      embedding: { provider: "openai", apiKey: "${OPENAI_CONF_KEY}" },
    });
    expect(result.neo4j.uri).toBe("bolt+s://prod:7687");
    expect(result.neo4j.username).toBe("prod-user");
    expect(result.neo4j.password).toBe("s3cret");
    expect(result.embedding.apiKey).toBe("sk-prod");
  });

  // --------------------------------------------------------------------------
  // 4. Regex compilation
  // --------------------------------------------------------------------------
  it("compiles autoCaptureSkipPattern and autoRecallSkipPattern to RegExp", () => {
    const result = memoryNeo4jConfigSchema.parse({
      ...MINIMAL,
      autoCaptureSkipPattern: "voice|call",
      autoRecallSkipPattern: "^test-session",
    });
    expect(result.autoCaptureSkipPattern).toBeInstanceOf(RegExp);
    expect(result.autoCaptureSkipPattern!.test("voice-123")).toBe(true);
    expect(result.autoRecallSkipPattern).toBeInstanceOf(RegExp);
    expect(result.autoRecallSkipPattern!.test("test-session-1")).toBe(true);
    expect(result.autoRecallSkipPattern!.test("other")).toBe(false);
  });

  // --------------------------------------------------------------------------
  // 5. Openai provider requires apiKey
  // --------------------------------------------------------------------------
  it("openai provider without apiKey throws", () => {
    expect(() =>
      memoryNeo4jConfigSchema.parse({
        neo4j: MINIMAL_NEO4J,
        embedding: { provider: "openai" },
      }),
    ).toThrow("embedding.apiKey is required for OpenAI provider");
  });

  // --------------------------------------------------------------------------
  // 6. Both 'user' and 'username' accepted for neo4j
  // --------------------------------------------------------------------------
  it("accepts 'user' as alias for 'username'", () => {
    const result = memoryNeo4jConfigSchema.parse({
      neo4j: { uri: "bolt://localhost:7687", user: "custom", password: "" },
      embedding: { provider: "ollama" },
    });
    expect(result.neo4j.username).toBe("custom");
  });

  // --------------------------------------------------------------------------
  // 7. Empty password → empty string
  // --------------------------------------------------------------------------
  it("empty password defaults to empty string", () => {
    const result = memoryNeo4jConfigSchema.parse({
      neo4j: { uri: "bolt://localhost:7687" },
      embedding: { provider: "ollama" },
    });
    expect(result.neo4j.password).toBe("");
  });

  // --------------------------------------------------------------------------
  // 8. graphCausalRelTypes validation
  // --------------------------------------------------------------------------
  it("graphCausalRelTypes with invalid types throws", () => {
    expect(() =>
      memoryNeo4jConfigSchema.parse({
        ...MINIMAL,
        graphCausalRelTypes: ["CAUSED_BY", "not valid!"],
      }),
    ).toThrow("graphCausalRelTypes contains invalid relationship type");
  });

  // --------------------------------------------------------------------------
  // 9. graphRelTypes validation
  // --------------------------------------------------------------------------
  it("graphRelTypes with invalid types throws", () => {
    expect(() =>
      memoryNeo4jConfigSchema.parse({
        ...MINIMAL,
        graphRelTypes: ["WORKS_AT", "invalid type!"],
      }),
    ).toThrow("graphRelTypes contains invalid relationship type");
  });

  // --------------------------------------------------------------------------
  // 10. Unknown top-level key rejection
  // --------------------------------------------------------------------------
  it("rejects unknown top-level keys", () => {
    expect(() =>
      memoryNeo4jConfigSchema.parse({
        ...MINIMAL,
        bogusKey: 42,
      }),
    ).toThrow("unknown keys: bogusKey");
  });

  // --------------------------------------------------------------------------
  // 11. Invalid neo4j URI scheme
  // --------------------------------------------------------------------------
  it("rejects invalid neo4j URI scheme", () => {
    expect(() =>
      memoryNeo4jConfigSchema.parse({
        neo4j: { uri: "http://localhost:7687", password: "" },
        embedding: { provider: "ollama" },
      }),
    ).toThrow("neo4j.uri must start with a valid scheme");
  });

  // --------------------------------------------------------------------------
  // 12. Invalid timezone
  // --------------------------------------------------------------------------
  it("rejects invalid timezone", () => {
    expect(() =>
      memoryNeo4jConfigSchema.parse({
        ...MINIMAL,
        sleepCycle: { schedule: "0 3 * * *", tz: "Invalid/Timezone" },
      }),
    ).toThrow("not a recognized IANA timezone");
  });

  // --------------------------------------------------------------------------
  // 13. Regex pattern too long
  // --------------------------------------------------------------------------
  it("rejects regex pattern > 200 chars", () => {
    const longPattern = "a".repeat(201);
    expect(() =>
      memoryNeo4jConfigSchema.parse({
        ...MINIMAL,
        autoCaptureSkipPattern: longPattern,
      }),
    ).toThrow("autoCaptureSkipPattern too long");
  });

  // --------------------------------------------------------------------------
  // 14. Invalid regex pattern
  // --------------------------------------------------------------------------
  it("rejects invalid regex in autoCaptureSkipPattern", () => {
    expect(() =>
      memoryNeo4jConfigSchema.parse({
        ...MINIMAL,
        autoCaptureSkipPattern: "[invalid",
      }),
    ).toThrow("invalid autoCaptureSkipPattern regex");
  });

  // --------------------------------------------------------------------------
  // 15. autoRecallMinScore out of bounds
  // --------------------------------------------------------------------------
  it("rejects autoRecallMinScore > 1", () => {
    expect(() =>
      memoryNeo4jConfigSchema.parse({
        ...MINIMAL,
        autoRecallMinScore: 1.5,
      }),
    ).toThrow("autoRecallMinScore must be between 0 and 1");
  });

  // --------------------------------------------------------------------------
  // 16. Negative recencyWeight
  // --------------------------------------------------------------------------
  it("rejects negative recencyWeight", () => {
    expect(() =>
      memoryNeo4jConfigSchema.parse({
        ...MINIMAL,
        recencyWeight: -0.1,
      }),
    ).toThrow("recencyWeight must be >= 0");
  });

  // --------------------------------------------------------------------------
  // 17. graphSearchDepth must be a positive integer
  // --------------------------------------------------------------------------
  it("rejects fractional graphSearchDepth", () => {
    expect(() =>
      memoryNeo4jConfigSchema.parse({
        ...MINIMAL,
        graphSearchDepth: 2.5,
      }),
    ).toThrow("graphSearchDepth must be a positive integer");
  });

  it("rejects graphSearchDepth > 3", () => {
    expect(() =>
      memoryNeo4jConfigSchema.parse({
        ...MINIMAL,
        graphSearchDepth: 4,
      }),
    ).toThrow("graphSearchDepth must be <= 3");
  });

  // --------------------------------------------------------------------------
  // 18. graphSeedCap must be a positive integer
  // --------------------------------------------------------------------------
  it("rejects zero graphSeedCap", () => {
    expect(() =>
      memoryNeo4jConfigSchema.parse({
        ...MINIMAL,
        graphSeedCap: 0,
      }),
    ).toThrow("graphSeedCap must be a positive integer");
  });

  // --------------------------------------------------------------------------
  // 19. Non-allowlisted env var blocked
  // --------------------------------------------------------------------------
  it("blocks non-allowlisted env var in resolveEnvVars", () => {
    expect(() =>
      memoryNeo4jConfigSchema.parse({
        neo4j: { uri: "bolt://localhost:7687", password: "${SECRET_TOKEN}" },
        embedding: { provider: "ollama" },
      }),
    ).toThrow("resolveEnvVars blocked non-allowlisted env var: SECRET_TOKEN");
  });

  // --------------------------------------------------------------------------
  // 20. null / undefined / non-object input
  // --------------------------------------------------------------------------
  it("rejects null input", () => {
    expect(() => memoryNeo4jConfigSchema.parse(null)).toThrow("memory-neo4j config required");
  });
  it("rejects array input", () => {
    expect(() => memoryNeo4jConfigSchema.parse([])).toThrow("memory-neo4j config required");
  });

  // --------------------------------------------------------------------------
  // 21. cache section defaults
  // --------------------------------------------------------------------------
  it("cache enabled without ttlMs/maxSize gets defaults", () => {
    const result = memoryNeo4jConfigSchema.parse({
      ...MINIMAL,
      cache: { enabled: true },
    });
    expect(result.cache).toEqual({ enabled: true, ttlMs: 300_000, maxSize: 200 });
  });

  // --------------------------------------------------------------------------
  // 22. communityDetection defaults
  // --------------------------------------------------------------------------
  it("communityDetection enabled without fields gets defaults", () => {
    const result = memoryNeo4jConfigSchema.parse({
      ...MINIMAL,
      communityDetection: { enabled: true },
    });
    expect(result.communityDetection).toEqual({
      enabled: true,
      minCommunitySize: 3,
      maxIterations: 10,
      signalWeight: 0.15,
    });
  });

  // --------------------------------------------------------------------------
  // 23. episodicMemory defaults
  // --------------------------------------------------------------------------
  it("episodicMemory enabled without fields gets defaults", () => {
    const result = memoryNeo4jConfigSchema.parse({
      ...MINIMAL,
      episodicMemory: { enabled: true },
    });
    expect(result.episodicMemory).toEqual({
      enabled: true,
      captureAssistant: false,
      retentionDays: 30,
    });
  });

  // --------------------------------------------------------------------------
  // 24. Deprecated sleepCycle fields (backwards compat)
  // --------------------------------------------------------------------------
  it("deprecated sleepCycle.auto/autoIntervalMs does not throw", () => {
    const result = memoryNeo4jConfigSchema.parse({
      ...MINIMAL,
      sleepCycle: { auto: true, autoIntervalMs: 3600000 },
    });
    expect(result.sleepCycle.schedule).toBeNull();
  });

  // --------------------------------------------------------------------------
  // 25. decayCurves validation
  // --------------------------------------------------------------------------
  it("decayCurves with non-positive halfLifeDays throws", () => {
    expect(() =>
      memoryNeo4jConfigSchema.parse({
        ...MINIMAL,
        decayCurves: { core: { halfLifeDays: 0 } },
      }),
    ).toThrow("decayCurves.core.halfLifeDays must be a positive number");
  });

  // --------------------------------------------------------------------------
  // 26. extraction section env-var resolution
  // --------------------------------------------------------------------------
  it("resolves env vars in extraction.apiKey", () => {
    process.env.OPENAI_EXTRACT_KEY = "ex-key";
    const result = memoryNeo4jConfigSchema.parse({
      ...MINIMAL,
      extraction: { apiKey: "${OPENAI_EXTRACT_KEY}" },
    });
    expect(result.extraction).toBeDefined();
    expect(result.extraction!.apiKey).toBe("ex-key");
  });

  // --------------------------------------------------------------------------
  // 27. reranker extractionMode values
  // --------------------------------------------------------------------------
  it("reranker with extractionMode auto", () => {
    const result = memoryNeo4jConfigSchema.parse({
      ...MINIMAL,
      reranker: { enabled: true, provider: "local", extractionMode: "auto" },
    });
    expect(result.reranker!.extractionMode).toBe("auto");
  });

  // --------------------------------------------------------------------------
  // 28. graphRelTypes non-array throws
  // --------------------------------------------------------------------------
  it("graphRelTypes as non-array throws", () => {
    expect(() =>
      memoryNeo4jConfigSchema.parse({
        ...MINIMAL,
        graphRelTypes: "WORKS_AT",
      }),
    ).toThrow("graphRelTypes must be an array of strings");
  });

  // --------------------------------------------------------------------------
  // 29. neo4j URI with all valid schemes
  // --------------------------------------------------------------------------
  for (const scheme of [
    "bolt://",
    "bolt+s://",
    "bolt+ssc://",
    "neo4j://",
    "neo4j+s://",
    "neo4j+ssc://",
  ]) {
    it(`accepts neo4j URI scheme ${scheme}`, () => {
      const result = memoryNeo4jConfigSchema.parse({
        neo4j: { uri: `${scheme}localhost:7687`, password: "" },
        embedding: { provider: "ollama" },
      });
      expect(result.neo4j.uri).toBe(`${scheme}localhost:7687`);
    });
  }

  // --------------------------------------------------------------------------
  // 30. coreMemory.refreshAtContextPercent > 100 throws
  // --------------------------------------------------------------------------
  it("coreMemory.refreshAtContextPercent > 100 throws", () => {
    expect(() =>
      memoryNeo4jConfigSchema.parse({
        ...MINIMAL,
        coreMemory: { refreshAtContextPercent: 150 },
      }),
    ).toThrow("coreMemory.refreshAtContextPercent must be between 1 and 100");
  });
});
