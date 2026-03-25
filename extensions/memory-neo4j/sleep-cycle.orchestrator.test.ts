/**
 * Tests for the runSleepCycle orchestrator.
 *
 * Covers: abort short-circuit, onPhaseStart callback, result shape.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExtractionConfig } from "./config.js";
import type { Embeddings } from "./embeddings.js";
import type { Neo4jMemoryClient } from "./neo4j-client.js";
import type { Logger } from "./schema.js";
import { runSleepCycle } from "./sleep-cycle.js";

// --------------------------------------------------------------------------
// Mock heavy dependencies so the orchestrator doesn't make real I/O calls
// --------------------------------------------------------------------------

vi.mock("./llm-client.js", () => ({
  callLlm: vi.fn(),
  callLlmStream: vi.fn(),
  callOpenRouter: vi.fn(),
  callOpenRouterStream: vi.fn(),
  isTransientError: vi.fn(() => false),
}));

vi.mock("./extractor.js", () => ({
  classifyTemporalStaleness: vi.fn(),
  extractTagsOnly: vi.fn(),
  isSemanticDuplicate: vi.fn(),
  resolveConflict: vi.fn(),
  runBackgroundExtraction: vi.fn(),
  stripCodeFences: vi.fn((s: string) => s),
}));

vi.mock("node:fs/promises", () => ({
  default: {
    readdir: vi.fn().mockResolvedValue([]),
    stat: vi.fn().mockResolvedValue({ mtimeMs: Date.now() }),
    readFile: vi.fn().mockResolvedValue(""),
  },
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
  } as unknown as Logger;
}

function createMockDb(): Neo4jMemoryClient {
  return {
    findDuplicateClusters: vi.fn().mockResolvedValue([]),
    mergeMemoryCluster: vi.fn().mockResolvedValue({ deletedCount: 0 }),
    findConflictingMemories: vi.fn().mockResolvedValue([]),
    invalidateMemory: vi.fn().mockResolvedValue(undefined),
    reconcileEntityRelationshipCounts: vi.fn().mockResolvedValue(0),
    findDuplicateEntityPairs: vi.fn().mockResolvedValue([]),
    mergeEntityPair: vi.fn().mockResolvedValue(false),
    batchMergeEntityPairs: vi.fn().mockResolvedValue(0),
    countByExtractionStatus: vi
      .fn()
      .mockResolvedValue({ pending: 0, complete: 0, failed: 0, skipped: 0 }),
    listPendingExtractions: vi.fn().mockResolvedValue([]),
    batchEntityOperations: vi.fn().mockResolvedValue(undefined),
    incrementTaggingRetries: vi.fn().mockResolvedValue(undefined),
    listUntaggedMemories: vi.fn().mockResolvedValue([]),
    findDecayedMemories: vi.fn().mockResolvedValue([]),
    pruneMemories: vi.fn().mockResolvedValue(0),
    fetchMemoriesForTemporalCheck: vi.fn().mockResolvedValue([]),
    fetchMemoriesForRetroactiveConflictScan: vi.fn().mockResolvedValue([]),
    detectConflicts: vi.fn().mockResolvedValue(0),
    findOrphanEntities: vi.fn().mockResolvedValue([]),
    deleteOrphanEntities: vi.fn().mockResolvedValue(0),
    findOrphanTags: vi.fn().mockResolvedValue([]),
    deleteOrphanTags: vi.fn().mockResolvedValue(0),
    getTopTagNames: vi.fn().mockResolvedValue([]),
    findSingleUseTags: vi.fn().mockResolvedValue([]),
    deleteMemoriesByPattern: vi.fn().mockResolvedValue(0),
    fetchMemoriesForCredentialScan: vi.fn().mockResolvedValue([]),
    deleteMemoriesByIds: vi.fn().mockResolvedValue(0),
    searchMemoriesByKeywords: vi.fn().mockResolvedValue([]),
    findSimilar: vi.fn().mockResolvedValue([]),
    storeMemory: vi.fn().mockResolvedValue("mem-id"),
    storeManyMemories: vi.fn().mockResolvedValue(0),
    createSession: vi.fn().mockResolvedValue({
      executeRead: vi.fn().mockResolvedValue({ records: [] }),
      executeWrite: vi.fn().mockResolvedValue({ records: [] }),
      close: vi.fn().mockResolvedValue(undefined),
    }),
  } as unknown as Neo4jMemoryClient;
}

function createMockEmbeddings(): Embeddings {
  return {
    embed: vi.fn().mockResolvedValue([0.1, 0.2]),
    embedBatch: vi.fn().mockResolvedValue([[0.1, 0.2]]),
  } as unknown as Embeddings;
}

const baseConfig: ExtractionConfig = {
  enabled: false, // disable LLM-dependent phases
  apiKey: "test-key",
  model: "test-model",
  baseUrl: "http://localhost:8080",
  temperature: 0,
  maxRetries: 0,
  timeout: 30_000,
  concurrency: 8,
  localNerEnabled: false,
  maxTokens: 4096,
};

// Options that skip all LLM-dependent phases for fast, deterministic tests
const fastOptions = {
  skipSemanticDedup: true,
  skipTemporalStaleness: true,
  skipRetroactiveConflictScan: true,
  skipRetroactiveTagging: true,
  skipTaskMemoryCleanup: true,
  skipTipGeneration: true,
};

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe("runSleepCycle orchestrator", () => {
  let db: Neo4jMemoryClient;
  let embeddings: Embeddings;
  let logger: Logger;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    embeddings = createMockEmbeddings();
    logger = createMockLogger();
  });

  it("returns aborted:true immediately when signal is pre-aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await runSleepCycle(db, embeddings, baseConfig, logger, {
      abortSignal: controller.signal,
    });

    expect(result.aborted).toBe(true);
    // No db methods should have been called since the signal was already aborted
    expect(db.findDuplicateClusters).not.toHaveBeenCalled();
  });

  it("invokes onPhaseStart callback with 'dedup' phase", async () => {
    const onPhaseStart = vi.fn();

    await runSleepCycle(db, embeddings, baseConfig, logger, {
      ...fastOptions,
      onPhaseStart,
    });

    expect(onPhaseStart).toHaveBeenCalledWith("dedup");
  });

  it("invokes onPhaseStart for multiple phases in order", async () => {
    const phases: string[] = [];
    const onPhaseStart = vi.fn((phase: string) => phases.push(phase));

    await runSleepCycle(db, embeddings, baseConfig, logger, {
      ...fastOptions,
      onPhaseStart,
    });

    // dedup and entityDedup always run; cleanup, noiseCleanup, credentialScan also run
    expect(phases).toContain("dedup");
    expect(phases).toContain("entityDedup");
    expect(phases).toContain("cleanup");
  });

  it("returns result with expected shape and zero counts when no work to do", async () => {
    const result = await runSleepCycle(db, embeddings, baseConfig, logger, {
      ...fastOptions,
    });

    expect(result.aborted).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    // Verify shape of all top-level result keys
    expect(result.dedup).toMatchObject({ clustersFound: 0, memoriesMerged: 0 });
    expect(result.conflict).toMatchObject({ pairsFound: 0, resolved: 0, invalidated: 0 });
    expect(result.semanticDedup).toMatchObject({ pairsChecked: 0, duplicatesMerged: 0 });
    expect(result.entityDedup).toMatchObject({ pairsFound: 0, merged: 0 });
    expect(result.extraction).toMatchObject({ total: 0, processed: 0, succeeded: 0, failed: 0 });
    expect(result.decay).toMatchObject({ memoriesPruned: 0 });
    expect(result.temporalStaleness).toMatchObject({ memoriesChecked: 0, memoriesRemoved: 0 });
    expect(result.cleanup).toMatchObject({ entitiesRemoved: 0, tagsRemoved: 0 });
    expect(result.credentialScan).toMatchObject({
      memoriesScanned: 0,
      credentialsFound: 0,
      memoriesRemoved: 0,
    });
  });

  it("queries db.findDuplicateClusters during the dedup phase", async () => {
    await runSleepCycle(db, embeddings, baseConfig, logger, {
      ...fastOptions,
    });

    expect(db.findDuplicateClusters).toHaveBeenCalledWith(0.75, undefined, true);
  });

  // --------------------------------------------------------------------------
  // OP-106: Entity dedup uses batchMergeEntityPairs with UNWIND
  // --------------------------------------------------------------------------

  it("OP-106: calls batchMergeEntityPairs (not mergeEntityPair) when pairs are found", async () => {
    const pairs = [
      {
        keepId: "keep-1",
        keepName: "tarun",
        removeId: "remove-1",
        removeName: "tarun sukhani",
        removeRelationships: 3,
      },
    ];
    (db.findDuplicateEntityPairs as ReturnType<typeof vi.fn>).mockResolvedValueOnce(pairs);
    (db.batchMergeEntityPairs as ReturnType<typeof vi.fn>).mockResolvedValueOnce(1);

    const result = await runSleepCycle(db, embeddings, baseConfig, logger, { ...fastOptions });

    expect(db.batchMergeEntityPairs).toHaveBeenCalledTimes(1);
    expect(db.batchMergeEntityPairs).toHaveBeenCalledWith([
      { keepId: "keep-1", removeId: "remove-1" },
    ]);
    expect(db.mergeEntityPair).not.toHaveBeenCalled();
    expect(result.entityDedup.merged).toBe(1);
  });

  it("OP-106: skips cascading pairs (removeId already removed by earlier merge)", async () => {
    // Pair A→B and B→C: after A→B, B is removed so B→C should be skipped
    const pairs = [
      {
        keepId: "keep-A",
        keepName: "A",
        removeId: "remove-B",
        removeName: "B",
        removeRelationships: 1,
      },
      {
        keepId: "remove-B",
        keepName: "B",
        removeId: "remove-C",
        removeName: "C",
        removeRelationships: 1,
      },
    ];
    (db.findDuplicateEntityPairs as ReturnType<typeof vi.fn>).mockResolvedValueOnce(pairs);
    (db.batchMergeEntityPairs as ReturnType<typeof vi.fn>).mockResolvedValueOnce(1);

    await runSleepCycle(db, embeddings, baseConfig, logger, { ...fastOptions });

    // Only the first (non-cascading) pair should be passed to batch
    const batchArg = (db.batchMergeEntityPairs as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as Array<{ keepId: string; removeId: string }>;
    expect(batchArg).toHaveLength(1);
    expect(batchArg[0]).toEqual({ keepId: "keep-A", removeId: "remove-B" });
  });

  it("OP-106: skips batch call when no eligible pairs after cascade filter", async () => {
    (db.findDuplicateEntityPairs as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

    await runSleepCycle(db, embeddings, baseConfig, logger, { ...fastOptions });

    expect(db.batchMergeEntityPairs).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // OP-142: Orphan cleanup must preserve entities with entity-entity relationships
  // --------------------------------------------------------------------------

  it("OP-142: does not delete entities that have entity-entity relationships but no MENTIONS", async () => {
    // Entity with entity-entity rels (e.g. WORKS_AT) but zero MENTIONS from Memory nodes.
    // Under legacy orphan logic this would be deleted; OP-142 graph-first must preserve it.
    (db.findOrphanEntities as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

    const result = await runSleepCycle(db, embeddings, baseConfig, logger, { ...fastOptions });

    // findOrphanEntities is called, returns [] (neo4j query now excludes entities with rels)
    expect(db.findOrphanEntities).toHaveBeenCalled();
    // deleteOrphanEntities should not be called when no orphans found
    expect(db.deleteOrphanEntities).not.toHaveBeenCalled();
    expect(result.cleanup.entitiesRemoved).toBe(0);
  });

  it("OP-142: deletes truly orphaned entities (no MENTIONS and no entity-entity rels)", async () => {
    const orphans = [
      { id: "orphan-1", name: "Stale Entity", type: "PERSON" },
      { id: "orphan-2", name: "Dead Node", type: "ORG" },
    ];
    (db.findOrphanEntities as ReturnType<typeof vi.fn>).mockResolvedValueOnce(orphans);
    (db.deleteOrphanEntities as ReturnType<typeof vi.fn>).mockResolvedValueOnce(2);

    const result = await runSleepCycle(db, embeddings, baseConfig, logger, { ...fastOptions });

    expect(db.deleteOrphanEntities).toHaveBeenCalledWith(["orphan-1", "orphan-2"]);
    expect(result.cleanup.entitiesRemoved).toBe(2);
  });

  // --------------------------------------------------------------------------
  // OP-107: Phase 8 tip generation uses embedBatch + storeManyMemories
  // --------------------------------------------------------------------------

  // --------------------------------------------------------------------------
  // CR-009: Phase 2b circuit-breaker — break on stalled batches
  // --------------------------------------------------------------------------

  it("CR-009: Phase 2b breaks after 3 consecutive stalled batches (same first memory ID)", async () => {
    const enabledConfig = { ...baseConfig, enabled: true };
    const stuckMemory = { id: "stuck-mem-id", text: "some memory that never gets tagged" };

    // Always return the same single memory (batchSize=1 so hasMore stays true)
    (db.listUntaggedMemories as ReturnType<typeof vi.fn>).mockResolvedValue([stuckMemory]);

    // incrementTaggingRetries fails — retry count never increments in DB
    (db.incrementTaggingRetries as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("DB connection lost"),
    );

    const { extractTagsOnly } = await import("./extractor.js");
    // Return empty tags → falls into the else branch → calls incrementTaggingRetries
    (extractTagsOnly as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    await runSleepCycle(db, embeddings, enabledConfig, logger, {
      ...fastOptions,
      skipRetroactiveTagging: false,
      retroactiveTagBatchSize: 1,
      extractionDelayMs: 0,
    });

    // Circuit-breaker fires after 4 listUntaggedMemories calls:
    // call 1 → sets lastBatchFirstId, stalledCount=0
    // call 2 → same ID, stalledCount=1
    // call 3 → same ID, stalledCount=2
    // call 4 → same ID, stalledCount=3 → break
    expect(db.listUntaggedMemories).toHaveBeenCalledTimes(4);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Phase 2b stalled"));
  });

  // --------------------------------------------------------------------------
  // Stage 2 parallelization — independent phase groups run concurrently
  // --------------------------------------------------------------------------

  it("runs Stage 2 phase groups concurrently (decay, cleanup, tasks, tips overlap in time)", async () => {
    // Track the start and end timestamps of phases to verify overlap.
    // If phases run sequentially, no two groups can overlap. If parallel,
    // groups from different pipelines will have overlapping [start, end] intervals.
    const timeline: Array<{ group: string; event: "start" | "end"; time: number }> = [];

    // Inject artificial delays into one phase per group so we can measure overlap.
    // Group A (decay): findDecayedMemories takes 30ms
    (db.findDecayedMemories as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      timeline.push({ group: "A-decay", event: "start", time: performance.now() });
      await new Promise((r) => setTimeout(r, 30));
      timeline.push({ group: "A-decay", event: "end", time: performance.now() });
      return [];
    });

    // Group B (cleanup): deleteMemoriesByPattern takes 30ms
    (db.deleteMemoriesByPattern as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      timeline.push({ group: "B-cleanup", event: "start", time: performance.now() });
      await new Promise((r) => setTimeout(r, 30));
      timeline.push({ group: "B-cleanup", event: "end", time: performance.now() });
      return 0;
    });

    // Group B (credential scan): return empty immediately so it doesn't add noise
    (db.fetchMemoriesForCredentialScan as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    await runSleepCycle(db, embeddings, baseConfig, logger, {
      ...fastOptions,
    });

    // Both groups must have started — the mocks were called
    const aStart = timeline.find((e) => e.group === "A-decay" && e.event === "start");
    const aEnd = timeline.find((e) => e.group === "A-decay" && e.event === "end");
    const bStart = timeline.find((e) => e.group === "B-cleanup" && e.event === "start");
    const bEnd = timeline.find((e) => e.group === "B-cleanup" && e.event === "end");

    expect(aStart).toBeDefined();
    expect(aEnd).toBeDefined();
    expect(bStart).toBeDefined();
    expect(bEnd).toBeDefined();

    // Verify overlap: Group B must have started before Group A finished (parallel)
    // In a sequential execution, B would start AFTER A ends.
    expect(bStart!.time).toBeLessThan(aEnd!.time);
  });

  it("aggregates results from parallel Stage 2 groups into a single SleepCycleResult", async () => {
    // Group A: decay finds and prunes memories
    (db.findDecayedMemories as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: "d1", text: "old", importance: 0.1, ageDays: 100, decayScore: 0.05 },
    ]);
    (db.pruneMemories as ReturnType<typeof vi.fn>).mockResolvedValueOnce(1);

    // Group B: credential scan finds a credential (ghp_ pattern matches GitHub token)
    (db.fetchMemoriesForCredentialScan as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([
        {
          id: "c1",
          text: "my token is ghp_abcdefghij1234567890abcdefghij1234",
          createdAt: "2025-01-01",
        },
      ])
      .mockResolvedValueOnce([]); // second call returns empty (end of scan)
    (db.deleteMemoriesByIds as ReturnType<typeof vi.fn>).mockResolvedValueOnce(1);

    const result = await runSleepCycle(db, embeddings, baseConfig, logger, {
      ...fastOptions,
    });

    // Results from both parallel groups must be present
    expect(result.decay.memoriesPruned).toBe(1);
    expect(result.credentialScan.memoriesScanned).toBe(1);
    expect(result.credentialScan.memoriesRemoved).toBe(1);
    expect(result.aborted).toBe(false);
  });

  it("orphan cleanup (Stage 3) runs after all Stage 2 groups complete", async () => {
    const callOrder: string[] = [];

    // Track decay (Stage 2, Group A)
    (db.findDecayedMemories as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callOrder.push("decay");
      return [];
    });

    // Track orphan cleanup (Stage 3)
    (db.findOrphanEntities as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callOrder.push("orphanCleanup");
      return [];
    });

    await runSleepCycle(db, embeddings, baseConfig, logger, {
      ...fastOptions,
    });

    // orphanCleanup must appear AFTER decay in the call order
    const decayIdx = callOrder.indexOf("decay");
    const orphanIdx = callOrder.indexOf("orphanCleanup");
    expect(decayIdx).toBeGreaterThanOrEqual(0);
    expect(orphanIdx).toBeGreaterThan(decayIdx);
  });

  it("OP-107: calls embedBatch once for all tips and storeManyMemories once", async () => {
    const fs = await import("node:fs/promises");
    const mockFs = fs.default as unknown as {
      readdir: ReturnType<typeof vi.fn>;
      stat: ReturnType<typeof vi.fn>;
      readFile: ReturnType<typeof vi.fn>;
    };

    // Provide one fake session file with a failure+correction pattern
    const sessionJsonl = [
      JSON.stringify({
        type: "message",
        message: {
          role: "toolResult",
          toolName: "Bash",
          content: [{ type: "text", text: "Error: command not found" }],
          details: { exitCode: 1 },
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "I will fix the path and retry." }],
        },
      }),
    ].join("\n");

    mockFs.readdir.mockResolvedValueOnce(["session-001.jsonl"]);
    mockFs.stat.mockResolvedValueOnce({ mtimeMs: Date.now() });
    mockFs.readFile.mockResolvedValueOnce(sessionJsonl);

    const { callLlm } = await import("./llm-client.js");
    const mockCallOpenRouter = callLlm as ReturnType<typeof vi.fn>;

    const tipsJson = JSON.stringify({
      tips: [
        {
          text: "Always verify your assumptions before committing code changes to main branch",
          importance: 0.9,
        },
        {
          text: "Use cursor-based pagination instead of SKIP for large dataset queries",
          importance: 0.85,
        },
      ],
    });
    mockCallOpenRouter.mockResolvedValueOnce(tipsJson);

    (embeddings.embedBatch as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6],
    ]);
    (db.storeManyMemories as ReturnType<typeof vi.fn>).mockResolvedValueOnce(2);

    const enabledConfig = { ...baseConfig, enabled: true };

    await runSleepCycle(db, embeddings, enabledConfig, logger, {
      ...fastOptions,
      skipTipGeneration: false,
    });

    // embedBatch should be called once for all tips (not once per tip)
    expect(embeddings.embedBatch).toHaveBeenCalledTimes(1);
    // storeManyMemories should be called once with all tips
    expect(db.storeManyMemories).toHaveBeenCalledTimes(1);
    // storeMemory (single-tip path) should NOT be called
    expect(db.storeMemory).not.toHaveBeenCalled();
  });
});
