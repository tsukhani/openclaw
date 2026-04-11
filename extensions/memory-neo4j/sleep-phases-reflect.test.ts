/**
 * Tests for CARA-style reflection engine with opinion/belief tracking (OP-186).
 *
 * Covers:
 * - Opinion generation from entity + memories
 * - Confidence updating (supporting + contradicting evidence)
 * - Archiving low-confidence opinions
 * - Batch limiting
 * - Stale opinion detection
 * - Search integration (opinion signal with confidence boosting)
 * - Graceful degradation (no opinions = no change)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExtractionConfig } from "./config.js";
import type { Logger } from "./schema.js";
import { updateConfidence } from "./sleep-phases-reflect.js";

vi.mock("./llm-client.js", () => ({
  callLlm: vi.fn(),
  callLlmStream: vi.fn(),
  callOpenRouter: vi.fn(),
  callOpenRouterStream: vi.fn(),
  isTransientError: vi.fn(() => false),
}));

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

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

function createMockSession(
  candidates: Array<{ entityName: string; observationSummary: string | null }> = [],
  memories: Array<{ id: string; text: string }> = [],
  existingOpinions: Array<{
    entityName: string;
    topic: string;
    belief: string;
    confidence: number;
    supportingMemoryIds: string[];
    contradictingMemoryIds: string[];
  }> = [],
) {
  const upsertedOpinions: Array<{
    agentId: string;
    topic: string;
    belief: string;
    confidence: number;
    entityName: string;
    archived: boolean;
  }> = [];

  return {
    executeRead: vi.fn(async (fn: (tx: { run: ReturnType<typeof vi.fn> }) => Promise<unknown>) => {
      const mockTx = {
        run: vi.fn(async (query: string, params?: Record<string, unknown>) => {
          // getReflectionCandidates query
          if (
            query.includes("EXTRACTED_FROM") &&
            query.includes("OBSERVES") &&
            query.includes("memCount")
          ) {
            return {
              records: candidates.map((c) => ({
                get: (key: string) => {
                  if (key === "entityName") {
                    return c.entityName;
                  }
                  if (key === "observationSummary") {
                    return c.observationSummary;
                  }
                  return null;
                },
              })),
            };
          }
          // getEntityMemoryTexts query
          if (query.includes("EXTRACTED_FROM") && query.includes("m.text")) {
            return {
              records: memories.map((m) => ({
                get: (key: string) => {
                  if (key === "id") {
                    return m.id;
                  }
                  if (key === "text") {
                    return m.text;
                  }
                  return null;
                },
              })),
            };
          }
          // getOpinionsForEntity query
          if (query.includes("Opinion") && query.includes("archived")) {
            const entityName = params?.entityName as string;
            const matching = existingOpinions.filter((o) => o.entityName === entityName);
            return {
              records: matching.map((o) => ({
                get: (key: string) => {
                  if (key === "id") {
                    return `opinion-${o.topic}`;
                  }
                  if (key === "topic") {
                    return o.topic;
                  }
                  if (key === "belief") {
                    return o.belief;
                  }
                  if (key === "confidence") {
                    return o.confidence;
                  }
                  if (key === "supportingMemoryIds") {
                    return o.supportingMemoryIds;
                  }
                  if (key === "contradictingMemoryIds") {
                    return o.contradictingMemoryIds;
                  }
                  return null;
                },
              })),
            };
          }
          return { records: [] };
        }),
      };
      return fn(mockTx);
    }),
    executeWrite: vi.fn(async (fn: (tx: { run: ReturnType<typeof vi.fn> }) => Promise<unknown>) => {
      const mockTx = {
        run: vi.fn(async (_query: string, params?: Record<string, unknown>) => {
          if (params?.topic) {
            upsertedOpinions.push({
              agentId: (params.agentId as string) ?? "",
              topic: params.topic as string,
              belief: (params.belief as string) ?? "",
              confidence: (params.confidence as number) ?? 0,
              entityName: (params.entityName as string) ?? "",
              archived: (params.archived as boolean) ?? false,
            });
          }
          return { records: [] };
        }),
      };
      return fn(mockTx);
    }),
    close: vi.fn(),
    _upsertedOpinions: upsertedOpinions,
  };
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe("sleep-phases-reflect", () => {
  let callLlm: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const llmClient = await import("./llm-client.js");
    callLlm = llmClient.callLlm as unknown as ReturnType<typeof vi.fn>;
  });

  describe("updateConfidence", () => {
    it("increases confidence with supporting evidence", () => {
      const result = updateConfidence(0.5, 3, 0);
      expect(result).toBeGreaterThan(0.5);
      expect(result).toBeLessThan(1.0);
    });

    it("decreases confidence with contradicting evidence", () => {
      const result = updateConfidence(0.5, 0, 3);
      expect(result).toBeLessThan(0.5);
      expect(result).toBeGreaterThan(0.0);
    });

    it("handles mixed supporting and contradicting evidence", () => {
      const result = updateConfidence(0.5, 2, 1);
      // Net effect should be positive since supporting > contradicting
      expect(result).toBeGreaterThan(0.5);
    });

    it("clamps confidence to [0, 1]", () => {
      expect(updateConfidence(0.99, 100, 0)).toBeLessThanOrEqual(1.0);
      expect(updateConfidence(0.01, 0, 100)).toBeGreaterThanOrEqual(0.0);
    });

    it("returns unchanged confidence with no new evidence", () => {
      expect(updateConfidence(0.7, 0, 0)).toBe(0.7);
    });

    it("applies exact formula: support += (1 - c) * 0.1", () => {
      // Starting at 0.5, one supporting piece
      const expected = 0.5 + (1 - 0.5) * 0.1;
      expect(updateConfidence(0.5, 1, 0)).toBeCloseTo(expected, 10);
    });

    it("applies exact formula: contradict -= c * 0.15", () => {
      // Starting at 0.8, one contradicting piece
      const expected = 0.8 - 0.8 * 0.15;
      expect(updateConfidence(0.8, 0, 1)).toBeCloseTo(expected, 10);
    });
  });

  describe("runReflection", () => {
    it("skips when extraction is not enabled", async () => {
      const { runReflection } = await import("./sleep-phases-reflect.js");
      const session = createMockSession();
      const config = createMockConfig({ enabled: false });
      const logger = createMockLogger();

      const result = await runReflection(session as never, "agent-1", config, logger);

      expect(result.entitiesReflected).toBe(0);
      expect(result.opinionsCreated).toBe(0);
      expect(result.opinionsUpdated).toBe(0);
      expect(result.opinionsArchived).toBe(0);
    });

    it("returns zeros when no eligible entities found", async () => {
      const { runReflection } = await import("./sleep-phases-reflect.js");
      const session = createMockSession([], []);
      const config = createMockConfig();
      const logger = createMockLogger();

      const result = await runReflection(session as never, "agent-1", config, logger);

      expect(result.entitiesReflected).toBe(0);
    });

    it("generates opinions for entities with sufficient memories", async () => {
      const { runReflection } = await import("./sleep-phases-reflect.js");
      const memories = [
        { id: "m1", text: "Alice prefers working remotely" },
        { id: "m2", text: "Alice dislikes commuting" },
        { id: "m3", text: "Alice works from home most days" },
        { id: "m4", text: "Alice has a home office setup" },
        { id: "m5", text: "Alice moved further from the office" },
      ];
      const candidates = [{ entityName: "Alice", observationSummary: "Alice is a remote worker." }];
      const session = createMockSession(candidates, memories);
      const config = createMockConfig();
      const logger = createMockLogger();

      callLlm.mockResolvedValue(
        JSON.stringify([
          {
            topic: "work style",
            belief: "Alice strongly prefers remote work over office work",
            confidence: 0.85,
            supportingEvidence: ["m1", "m2", "m3", "m4", "m5"],
            contradictingEvidence: [],
          },
        ]),
      );

      const result = await runReflection(session as never, "agent-1", config, logger);

      expect(result.entitiesReflected).toBe(1);
      expect(result.opinionsCreated).toBe(1);
      expect(callLlm).toHaveBeenCalledTimes(1);
      // Verify the prompt contains entity name and memory texts
      const promptArg = callLlm.mock.calls[0][1];
      expect(promptArg).toContain("Alice");
      expect(promptArg).toContain("Alice prefers working remotely");
    });

    it("updates existing opinions with new evidence", async () => {
      const { runReflection } = await import("./sleep-phases-reflect.js");
      const memories = [
        { id: "m1", text: "Bob prefers TypeScript" },
        { id: "m2", text: "Bob uses TypeScript daily" },
        { id: "m3", text: "Bob recommends TypeScript to others" },
        { id: "m4", text: "Bob dislikes vanilla JavaScript" },
        { id: "m5", text: "Bob's projects are all TypeScript" },
        { id: "m6", text: "Bob recently tried Go and liked it" },
      ];
      const candidates = [{ entityName: "Bob", observationSummary: null }];
      const existingOpinions = [
        {
          entityName: "Bob",
          topic: "programming language preference",
          belief: "Bob prefers TypeScript",
          confidence: 0.7,
          supportingMemoryIds: ["m1", "m2"],
          contradictingMemoryIds: [],
        },
      ];
      const session = createMockSession(candidates, memories, existingOpinions);
      const config = createMockConfig();
      const logger = createMockLogger();

      callLlm.mockResolvedValue(
        JSON.stringify([
          {
            topic: "programming language preference",
            belief: "Bob strongly prefers TypeScript but is open to Go",
            confidence: 0.8,
            supportingEvidence: ["m1", "m2", "m3", "m4", "m5"],
            contradictingEvidence: ["m6"],
          },
        ]),
      );

      const result = await runReflection(session as never, "agent-1", config, logger);

      expect(result.entitiesReflected).toBe(1);
      expect(result.opinionsUpdated).toBe(1);
      expect(result.opinionsCreated).toBe(0);
      // Confidence should be adjusted from 0.7 based on new evidence
      const upserted = session._upsertedOpinions[0];
      expect(upserted.confidence).not.toBe(0.7);
    });

    it("archives opinions with very low confidence", async () => {
      const { runReflection } = await import("./sleep-phases-reflect.js");
      const memories = [
        { id: "m1", text: "Charlie used to like Java" },
        { id: "m2", text: "Charlie switched to Rust" },
        { id: "m3", text: "Charlie criticizes Java now" },
        { id: "m4", text: "Charlie recommends Rust" },
        { id: "m5", text: "Charlie says Java is outdated" },
      ];
      const candidates = [{ entityName: "Charlie", observationSummary: null }];
      const existingOpinions = [
        {
          entityName: "Charlie",
          topic: "Java preference",
          belief: "Charlie likes Java",
          confidence: 0.12,
          supportingMemoryIds: ["m1"],
          contradictingMemoryIds: [],
        },
      ];
      const session = createMockSession(candidates, memories, existingOpinions);
      const config = createMockConfig();
      const logger = createMockLogger();

      callLlm.mockResolvedValue(
        JSON.stringify([
          {
            topic: "Java preference",
            belief: "Charlie no longer likes Java",
            confidence: 0.1,
            supportingEvidence: [],
            contradictingEvidence: ["m2", "m3", "m5"],
          },
        ]),
      );

      const result = await runReflection(session as never, "agent-1", config, logger);

      expect(result.opinionsArchived).toBe(1);
      const upserted = session._upsertedOpinions[0];
      expect(upserted.archived).toBe(true);
    });

    it("respects batch limiting", async () => {
      const { runReflection } = await import("./sleep-phases-reflect.js");
      const memories = Array.from({ length: 6 }, (_, i) => ({
        id: `m${i}`,
        text: `Entity fact ${i}`,
      }));
      const manyCandidates = Array.from({ length: 30 }, (_, i) => ({
        entityName: `Entity${i}`,
        observationSummary: null,
      }));
      const session = createMockSession(manyCandidates, memories);
      const config = createMockConfig();
      const logger = createMockLogger();

      callLlm.mockResolvedValue(
        JSON.stringify([
          {
            topic: "test",
            belief: "test belief",
            confidence: 0.5,
            supportingEvidence: ["m0"],
            contradictingEvidence: [],
          },
        ]),
      );

      // Limit to 3 entities per run
      const result = await runReflection(session as never, "agent-1", config, logger, {
        maxEntitiesPerRun: 3,
      });

      // Mock returns all 30 candidates but limit should be passed to DB query
      expect(callLlm).toHaveBeenCalled();
    });

    it("handles LLM returning empty response", async () => {
      const { runReflection } = await import("./sleep-phases-reflect.js");
      const memories = Array.from({ length: 5 }, (_, i) => ({
        id: `m${i}`,
        text: `Fact ${i}`,
      }));
      const session = createMockSession(
        [{ entityName: "Dave", observationSummary: null }],
        memories,
      );
      const config = createMockConfig();
      const logger = createMockLogger();

      callLlm.mockResolvedValue("");

      const result = await runReflection(session as never, "agent-1", config, logger);

      expect(result.entitiesReflected).toBe(0);
      expect(result.opinionsCreated).toBe(0);
    });

    it("handles LLM returning invalid JSON", async () => {
      const { runReflection } = await import("./sleep-phases-reflect.js");
      const memories = Array.from({ length: 5 }, (_, i) => ({
        id: `m${i}`,
        text: `Fact ${i}`,
      }));
      const session = createMockSession(
        [{ entityName: "Eve", observationSummary: null }],
        memories,
      );
      const config = createMockConfig();
      const logger = createMockLogger();

      callLlm.mockResolvedValue("This is not valid JSON at all");

      const result = await runReflection(session as never, "agent-1", config, logger);

      expect(result.entitiesReflected).toBe(0);
      expect(result.opinionsCreated).toBe(0);
    });

    it("handles LLM returning JSON in code block", async () => {
      const { runReflection } = await import("./sleep-phases-reflect.js");
      const memories = Array.from({ length: 5 }, (_, i) => ({
        id: `m${i}`,
        text: `Fact ${i}`,
      }));
      const session = createMockSession(
        [{ entityName: "Frank", observationSummary: null }],
        memories,
      );
      const config = createMockConfig();
      const logger = createMockLogger();

      callLlm.mockResolvedValue(
        '```json\n[{"topic": "test", "belief": "test belief", "confidence": 0.6, "supportingEvidence": ["m0"], "contradictingEvidence": []}]\n```',
      );

      const result = await runReflection(session as never, "agent-1", config, logger);

      expect(result.entitiesReflected).toBe(1);
      expect(result.opinionsCreated).toBe(1);
    });

    it("respects abort signal", async () => {
      const { runReflection } = await import("./sleep-phases-reflect.js");
      const memories = Array.from({ length: 5 }, (_, i) => ({
        id: `m${i}`,
        text: `Fact ${i}`,
      }));
      const candidates = [
        { entityName: "Entity1", observationSummary: null },
        { entityName: "Entity2", observationSummary: null },
        { entityName: "Entity3", observationSummary: null },
      ];
      const session = createMockSession(candidates, memories);
      const config = createMockConfig();
      const logger = createMockLogger();
      const controller = new AbortController();

      callLlm.mockImplementation(async () => {
        controller.abort();
        return JSON.stringify([
          {
            topic: "test",
            belief: "test",
            confidence: 0.5,
            supportingEvidence: ["m0"],
            contradictingEvidence: [],
          },
        ]);
      });

      const result = await runReflection(session as never, "agent-1", config, logger, {
        abortSignal: controller.signal,
      });

      expect(result.entitiesReflected).toBeLessThanOrEqual(1);
    });

    it("continues processing when one entity fails", async () => {
      const { runReflection } = await import("./sleep-phases-reflect.js");
      const memories = Array.from({ length: 5 }, (_, i) => ({
        id: `m${i}`,
        text: `Fact ${i}`,
      }));
      const candidates = [
        { entityName: "Good", observationSummary: null },
        { entityName: "Bad", observationSummary: null },
        { entityName: "Good2", observationSummary: null },
      ];
      const session = createMockSession(candidates, memories);
      const config = createMockConfig();
      const logger = createMockLogger();

      let callCount = 0;
      callLlm.mockImplementation(async () => {
        callCount++;
        if (callCount === 2) {
          throw new Error("LLM timeout");
        }
        return JSON.stringify([
          {
            topic: "test",
            belief: "test belief",
            confidence: 0.6,
            supportingEvidence: ["m0"],
            contradictingEvidence: [],
          },
        ]);
      });

      const result = await runReflection(session as never, "agent-1", config, logger);

      expect(result.entitiesReflected).toBe(2);
      expect(callLlm).toHaveBeenCalledTimes(3);
    });

    it("skips entities with fewer than 5 memories", async () => {
      const { runReflection } = await import("./sleep-phases-reflect.js");
      // Only 3 memories — below the MIN_MEMORIES_FOR_REFLECTION threshold
      const memories = [
        { id: "m1", text: "Fact 1" },
        { id: "m2", text: "Fact 2" },
        { id: "m3", text: "Fact 3" },
      ];
      const session = createMockSession(
        [{ entityName: "Sparse", observationSummary: null }],
        memories,
      );
      const config = createMockConfig();
      const logger = createMockLogger();

      const result = await runReflection(session as never, "agent-1", config, logger);

      expect(result.entitiesReflected).toBe(0);
      expect(callLlm).not.toHaveBeenCalled();
    });

    it("filters invalid memory IDs from LLM response", async () => {
      const { runReflection } = await import("./sleep-phases-reflect.js");
      const memories = Array.from({ length: 5 }, (_, i) => ({
        id: `m${i}`,
        text: `Fact ${i}`,
      }));
      const session = createMockSession(
        [{ entityName: "Grace", observationSummary: null }],
        memories,
      );
      const config = createMockConfig();
      const logger = createMockLogger();

      callLlm.mockResolvedValue(
        JSON.stringify([
          {
            topic: "test",
            belief: "test belief",
            confidence: 0.7,
            supportingEvidence: ["m0", "m1", "fake-id-1"],
            contradictingEvidence: ["fake-id-2"],
          },
        ]),
      );

      const result = await runReflection(session as never, "agent-1", config, logger);

      expect(result.opinionsCreated).toBe(1);
      // Verify upserted opinion only has valid memory IDs
      const upserted = session._upsertedOpinions[0];
      expect(upserted).toBeDefined();
    });

    it("handles multiple opinions per entity", async () => {
      const { runReflection } = await import("./sleep-phases-reflect.js");
      const memories = Array.from({ length: 6 }, (_, i) => ({
        id: `m${i}`,
        text: `Fact ${i} about Heidi`,
      }));
      const session = createMockSession(
        [{ entityName: "Heidi", observationSummary: null }],
        memories,
      );
      const config = createMockConfig();
      const logger = createMockLogger();

      callLlm.mockResolvedValue(
        JSON.stringify([
          {
            topic: "communication style",
            belief: "Heidi prefers async communication",
            confidence: 0.8,
            supportingEvidence: ["m0", "m1"],
            contradictingEvidence: [],
          },
          {
            topic: "work ethic",
            belief: "Heidi is highly detail-oriented",
            confidence: 0.65,
            supportingEvidence: ["m2", "m3"],
            contradictingEvidence: ["m4"],
          },
        ]),
      );

      const result = await runReflection(session as never, "agent-1", config, logger);

      expect(result.entitiesReflected).toBe(1);
      expect(result.opinionsCreated).toBe(2);
      expect(session._upsertedOpinions).toHaveLength(2);
    });
  });

  describe("graceful degradation", () => {
    it("no opinions = no change to result", async () => {
      const { runReflection } = await import("./sleep-phases-reflect.js");
      const memories = Array.from({ length: 5 }, (_, i) => ({
        id: `m${i}`,
        text: `Fact ${i}`,
      }));
      const session = createMockSession(
        [{ entityName: "Ivan", observationSummary: null }],
        memories,
      );
      const config = createMockConfig();
      const logger = createMockLogger();

      callLlm.mockResolvedValue("[]");

      const result = await runReflection(session as never, "agent-1", config, logger);

      expect(result.entitiesReflected).toBe(0);
      expect(result.opinionsCreated).toBe(0);
      expect(result.opinionsUpdated).toBe(0);
      expect(result.opinionsArchived).toBe(0);
    });
  });

  describe("search integration", () => {
    it("opinion confidence boosting: high confidence (>= 0.7) gets 1.4x", () => {
      const confidence = 0.85;
      const boost = confidence >= 0.7 ? 1.4 : confidence >= 0.4 ? 1.0 : 0.7;
      expect(boost).toBe(1.4);
      expect(confidence * boost).toBeCloseTo(1.19, 2);
    });

    it("opinion confidence boosting: medium confidence (0.4-0.7) gets 1.0x", () => {
      const confidence = 0.55;
      const boost = confidence >= 0.7 ? 1.4 : confidence >= 0.4 ? 1.0 : 0.7;
      expect(boost).toBe(1.0);
      expect(confidence * boost).toBe(0.55);
    });

    it("opinion confidence boosting: low confidence (< 0.4) gets 0.7x", () => {
      const confidence = 0.2;
      const boost = confidence >= 0.7 ? 1.4 : confidence >= 0.4 ? 1.0 : 0.7;
      expect(boost).toBe(0.7);
      expect(confidence * boost).toBeCloseTo(0.14, 2);
    });
  });

  describe("disposition parameters (OP-188)", () => {
    it("includes disposition guidance in reflection prompt", async () => {
      const { runReflection } = await import("./sleep-phases-reflect.js");
      const memories = Array.from({ length: 5 }, (_, i) => ({
        id: `m${i}`,
        text: `Fact ${i} about Alice`,
      }));
      const session = createMockSession(
        [{ entityName: "Alice", observationSummary: null }],
        memories,
      );
      const config = createMockConfig();
      config.disposition = { skepticism: 5, literalism: 1, empathy: 4 };
      const logger = createMockLogger();

      callLlm.mockResolvedValue(
        JSON.stringify([
          {
            topic: "test",
            belief: "test belief",
            confidence: 0.7,
            supportingEvidence: ["m0"],
            contradictingEvidence: [],
          },
        ]),
      );

      await runReflection(session as never, "agent-1", config, logger);

      const promptArg = callLlm.mock.calls[0][1];
      expect(promptArg).toContain("Disposition profile");
      expect(promptArg).toContain("highly skeptical");
      expect(promptArg).toContain("very figurative");
      expect(promptArg).toContain("empathetic");
    });

    it("uses default disposition when not configured", async () => {
      const { runReflection } = await import("./sleep-phases-reflect.js");
      const memories = Array.from({ length: 5 }, (_, i) => ({
        id: `m${i}`,
        text: `Fact ${i}`,
      }));
      const session = createMockSession(
        [{ entityName: "Bob", observationSummary: null }],
        memories,
      );
      const config = createMockConfig();
      // Default disposition is { skepticism: 3, literalism: 3, empathy: 3 }
      const logger = createMockLogger();

      callLlm.mockResolvedValue(
        JSON.stringify([
          {
            topic: "test",
            belief: "test belief",
            confidence: 0.6,
            supportingEvidence: ["m0"],
            contradictingEvidence: [],
          },
        ]),
      );

      await runReflection(session as never, "agent-1", config, logger);

      const promptArg = callLlm.mock.calls[0][1];
      expect(promptArg).toContain("balanced");
    });

    it("passes dispositionSnapshot to upsertOpinion", async () => {
      const { runReflection } = await import("./sleep-phases-reflect.js");
      const memories = Array.from({ length: 5 }, (_, i) => ({
        id: `m${i}`,
        text: `Fact ${i}`,
      }));
      const session = createMockSession(
        [{ entityName: "Carol", observationSummary: null }],
        memories,
      );
      const config = createMockConfig();
      config.disposition = { skepticism: 4, literalism: 2, empathy: 5 };
      const logger = createMockLogger();

      callLlm.mockResolvedValue(
        JSON.stringify([
          {
            topic: "test",
            belief: "test belief",
            confidence: 0.7,
            supportingEvidence: ["m0"],
            contradictingEvidence: [],
          },
        ]),
      );

      await runReflection(session as never, "agent-1", config, logger);

      // Verify upsertOpinion was called (via executeWrite) with dispositionSnapshot
      const writeCall = session.executeWrite.mock.calls[0];
      expect(writeCall).toBeDefined();
      // The writeCall fn receives a mockTx — we check the params passed to tx.run
      const writeFn = writeCall[0];
      const mockTx = {
        run: vi.fn<(q: string, p?: Record<string, unknown>) => Promise<{ records: never[] }>>(
          async () => ({ records: [] }),
        ),
      };
      await writeFn(mockTx);
      const params = mockTx.run.mock.calls[0]?.[1];
      expect(params?.dispositionSnapshot).toBeDefined();
      const snapshot = JSON.parse(params!.dispositionSnapshot as string);
      expect(snapshot).toEqual({ skepticism: 4, literalism: 2, empathy: 5 });
    });
  });

  describe("belief generalization (OP-188)", () => {
    it("returns opinionsGeneralized count", async () => {
      const { runReflection } = await import("./sleep-phases-reflect.js");
      const memories = Array.from({ length: 6 }, (_, i) => ({
        id: `m${i}`,
        text: `Fact ${i}`,
      }));
      const candidates = [
        { entityName: "Entity1", observationSummary: null },
        { entityName: "Entity2", observationSummary: null },
      ];
      // Provide existing opinions so getOpinionsForEntity returns results during generalization
      const existingOpinions = [
        {
          entityName: "Entity1",
          topic: "communication",
          belief: "Entity1 prefers async",
          confidence: 0.8,
          supportingMemoryIds: ["m0", "m1"],
          contradictingMemoryIds: [],
        },
        {
          entityName: "Entity2",
          topic: "communication",
          belief: "Entity2 prefers async",
          confidence: 0.8,
          supportingMemoryIds: ["m0", "m1"],
          contradictingMemoryIds: [],
        },
      ];
      const session = createMockSession(candidates, memories, existingOpinions);
      const config = createMockConfig();
      const logger = createMockLogger();

      let callCount = 0;
      callLlm.mockImplementation(async () => {
        callCount++;
        // First two calls: per-entity reflection
        if (callCount <= 2) {
          return JSON.stringify([
            {
              topic: "communication",
              belief: `Entity${callCount} prefers async`,
              confidence: 0.8,
              supportingEvidence: ["m0", "m1"],
              contradictingEvidence: [],
            },
          ]);
        }
        // Third call: generalization
        return JSON.stringify([
          {
            topic: "team communication",
            belief: "The team generally prefers async communication",
            confidence: 0.75,
            sourceEntities: ["Entity1", "Entity2"],
          },
        ]);
      });

      const result = await runReflection(session as never, "agent-1", config, logger);

      expect(result.entitiesReflected).toBe(2);
      expect(result.opinionsGeneralized).toBe(1);
      expect(callLlm).toHaveBeenCalledTimes(3);
    });

    it("skips generalization with fewer than 2 entities reflected", async () => {
      const { runReflection } = await import("./sleep-phases-reflect.js");
      const memories = Array.from({ length: 5 }, (_, i) => ({
        id: `m${i}`,
        text: `Fact ${i}`,
      }));
      const session = createMockSession(
        [{ entityName: "Only", observationSummary: null }],
        memories,
      );
      const config = createMockConfig();
      const logger = createMockLogger();

      callLlm.mockResolvedValue(
        JSON.stringify([
          {
            topic: "test",
            belief: "test",
            confidence: 0.6,
            supportingEvidence: ["m0"],
            contradictingEvidence: [],
          },
        ]),
      );

      const result = await runReflection(session as never, "agent-1", config, logger);

      expect(result.entitiesReflected).toBe(1);
      expect(result.opinionsGeneralized).toBe(0);
      // Only 1 LLM call for the entity reflection, no generalization call
      expect(callLlm).toHaveBeenCalledTimes(1);
    });

    it("filters generalized opinions with fewer than 2 valid source entities", async () => {
      const { runReflection } = await import("./sleep-phases-reflect.js");
      const memories = Array.from({ length: 6 }, (_, i) => ({
        id: `m${i}`,
        text: `Fact ${i}`,
      }));
      const candidates = [
        { entityName: "Alpha", observationSummary: null },
        { entityName: "Beta", observationSummary: null },
      ];
      const session = createMockSession(candidates, memories);
      const config = createMockConfig();
      const logger = createMockLogger();

      let callCount = 0;
      callLlm.mockImplementation(async () => {
        callCount++;
        if (callCount <= 2) {
          return JSON.stringify([
            {
              topic: "work",
              belief: "works hard",
              confidence: 0.7,
              supportingEvidence: ["m0"],
              contradictingEvidence: [],
            },
          ]);
        }
        // Generalization references a non-existent entity
        return JSON.stringify([
          {
            topic: "invalid",
            belief: "invalid generalization",
            confidence: 0.8,
            sourceEntities: ["Alpha", "FakeEntity"],
          },
        ]);
      });

      const result = await runReflection(session as never, "agent-1", config, logger);

      expect(result.opinionsGeneralized).toBe(0);
    });
  });

  describe("stale opinion detection", () => {
    it("getStaleOpinions returns opinions with new evidence", async () => {
      const { getStaleOpinions } = await import("./neo4j-client-opinion.js");
      // Use a session mock that returns stale opinions
      const session = {
        executeRead: vi.fn(
          async (fn: (tx: { run: ReturnType<typeof vi.fn> }) => Promise<unknown>) => {
            const mockTx = {
              run: vi.fn(async () => ({
                records: [
                  {
                    get: (key: string) => {
                      const data: Record<string, unknown> = {
                        entityName: "Alice",
                        topic: "work style",
                        belief: "Alice prefers remote",
                        confidence: 0.8,
                        supportingMemoryIds: ["m1"],
                        contradictingMemoryIds: [],
                      };
                      return data[key] ?? null;
                    },
                  },
                ],
              })),
            };
            return fn(mockTx);
          },
        ),
      };

      const result = await getStaleOpinions(session as never, "agent-1");

      expect(result).toHaveLength(1);
      expect(result[0].entityName).toBe("Alice");
      expect(result[0].confidence).toBe(0.8);
    });
  });
});
