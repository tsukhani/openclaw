/**
 * Tests for OP-82 bi-temporal memory features:
 * supersedeMemory, migrateTemporalFields, detectConflicts
 *
 * Tests for OP-122 temporal validity on entity-to-entity relationships:
 * batchEntityOperations (validFrom/validUntil), expireOrphanedEntityRelationships, graphSearch
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Neo4jMemoryClient } from "./neo4j-client.js";

// ============================================================================
// Mocks
// ============================================================================

vi.mock("./llm-client.js", () => ({
  callLlm: vi.fn(),
  callLlmStream: vi.fn(),
}));

import { callLlm } from "./llm-client.js";

// ============================================================================
// Test Helpers
// ============================================================================

function createMockSession() {
  const session = {
    run: vi.fn().mockResolvedValue({ records: [] }),
    close: vi.fn().mockResolvedValue(undefined),
    executeWrite: vi.fn(),
    executeRead: null as unknown as ReturnType<typeof vi.fn>,
  };
  session.executeRead = vi.fn().mockImplementation((fn) => fn({ run: session.run }));
  return session;
}

function createMockDriver(session: ReturnType<typeof createMockSession>) {
  return {
    session: vi.fn().mockReturnValue(session),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function makeClient() {
  const logger = createMockLogger();
  const session = createMockSession();
  const driver = createMockDriver(session);
  const client = new Neo4jMemoryClient("bolt://localhost:7687", "neo4j", "password", 1024, logger);
  (client as any).driver = driver;
  (client as any).indexesReady = true;
  return { client, driver, session, logger };
}

// ============================================================================
// Helpers shared by OP-122 tests
// ============================================================================

function createMockExecuteWrite() {
  return vi.fn().mockImplementation(async (fn: (tx: any) => Promise<void>) => {
    const tx = { run: vi.fn().mockResolvedValue({ records: [] }) };
    await fn(tx);
    return tx;
  });
}

// ============================================================================
// supersedeMemory
// ============================================================================

describe("supersedeMemory", () => {
  it("sets validUntil and supersededBy on the old memory", async () => {
    const { client, session } = makeClient();

    await client.supersedeMemory("old-id", "new-id");

    expect(session.run).toHaveBeenCalledWith(
      expect.stringContaining("SET m.validUntil = $now, m.supersededBy = $newId"),
      expect.objectContaining({ oldId: "old-id", newId: "new-id" }),
    );
    expect(session.close).toHaveBeenCalled();
  });
});

// ============================================================================
// migrateTemporalFields
// ============================================================================

describe("migrateTemporalFields", () => {
  it("returns the count of updated memories", async () => {
    const { client, session } = makeClient();

    session.run.mockResolvedValueOnce({
      records: [{ get: vi.fn().mockReturnValue(5) }],
    });

    const count = await client.migrateTemporalFields();

    expect(count).toBe(5);
    expect(session.run).toHaveBeenCalledWith(expect.stringContaining("WHERE m.validFrom IS NULL"));
  });

  it("returns 0 when no memories need migration", async () => {
    const { client, session } = makeClient();

    session.run.mockResolvedValueOnce({
      records: [{ get: vi.fn().mockReturnValue(0) }],
    });

    const count = await client.migrateTemporalFields();

    expect(count).toBe(0);
  });

  it("returns 0 when result has no records", async () => {
    const { client, session } = makeClient();

    session.run.mockResolvedValueOnce({ records: [] });

    const count = await client.migrateTemporalFields();

    expect(count).toBe(0);
  });
});

// ============================================================================
// detectConflicts
// ============================================================================

describe("detectConflicts", () => {
  const enabledConfig = {
    enabled: true,
    apiKey: "test-key",
    model: "test-model",
    baseUrl: "https://openrouter.ai/api/v1",
    temperature: 0,
    maxRetries: 2,
  };

  const disabledConfig = { ...enabledConfig, enabled: false };

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns 0 immediately when config.enabled=false", async () => {
    const { client } = makeClient();

    const result = await client.detectConflicts(
      "new-id",
      "new memory text",
      [0.1, 0.2],
      "agent-1",
      disabledConfig,
    );

    expect(result).toBe(0);
    expect(callLlm).not.toHaveBeenCalled();
  });

  it("returns 0 when no candidates found", async () => {
    const { client } = makeClient();

    vi.spyOn(client, "findSimilar" as any).mockResolvedValue([]);

    const result = await client.detectConflicts(
      "new-id",
      "new memory text",
      [0.1, 0.2],
      "agent-1",
      enabledConfig,
    );

    expect(result).toBe(0);
    expect(callLlm).not.toHaveBeenCalled();
  });

  it("supersedes candidate when LLM returns SUPERSEDES", async () => {
    const { client } = makeClient();

    vi.spyOn(client, "findSimilar" as any).mockResolvedValue([
      { id: "old-id", text: "old memory text", score: 0.9 },
    ]);

    (callLlm as ReturnType<typeof vi.fn>).mockResolvedValue(
      JSON.stringify({ classification: "SUPERSEDES" }),
    );

    const supersedeSpy = vi.spyOn(client, "supersedeMemory").mockResolvedValue(undefined);

    const result = await client.detectConflicts(
      "new-id",
      "new memory text",
      [0.1, 0.2],
      "agent-1",
      enabledConfig,
    );

    expect(result).toBe(1);
    expect(supersedeSpy).toHaveBeenCalledWith("old-id", "new-id");
  });

  it("does not supersede when LLM returns COMPLEMENTS", async () => {
    const { client } = makeClient();

    vi.spyOn(client, "findSimilar" as any).mockResolvedValue([
      { id: "old-id", text: "old memory text", score: 0.9 },
    ]);

    (callLlm as ReturnType<typeof vi.fn>).mockResolvedValue(
      JSON.stringify({ classification: "COMPLEMENTS" }),
    );

    const supersedeSpy = vi.spyOn(client, "supersedeMemory").mockResolvedValue(undefined);

    const result = await client.detectConflicts(
      "new-id",
      "new memory text",
      [0.1, 0.2],
      "agent-1",
      enabledConfig,
    );

    expect(result).toBe(0);
    expect(supersedeSpy).not.toHaveBeenCalled();
  });

  it("excludes new memory itself from candidates", async () => {
    const { client } = makeClient();

    // findSimilar returns new memory itself + one real candidate
    vi.spyOn(client, "findSimilar" as any).mockResolvedValue([
      { id: "new-id", text: "new memory text", score: 1.0 },
      { id: "other-id", text: "other memory", score: 0.85 },
    ]);

    (callLlm as ReturnType<typeof vi.fn>).mockResolvedValue(
      JSON.stringify({ classification: "SUPERSEDES" }),
    );

    const supersedeSpy = vi.spyOn(client, "supersedeMemory").mockResolvedValue(undefined);

    await client.detectConflicts("new-id", "new memory text", [0.1, 0.2], "agent-1", enabledConfig);

    // Should only call supersedeMemory for "other-id", not "new-id"
    expect(supersedeSpy).toHaveBeenCalledWith("other-id", "new-id");
    expect(supersedeSpy).not.toHaveBeenCalledWith("new-id", expect.anything());
  });
});

// ============================================================================
// OP-122: closeEntityRelationship
// ============================================================================

describe("closeEntityRelationship (OP-122)", () => {
  it("sets validUntil and updatedAt on the matching active relationship", async () => {
    const { client, session } = makeClient();
    session.run.mockResolvedValueOnce({
      records: [{ get: vi.fn().mockReturnValue(1) }],
    });

    const result = await client.closeEntityRelationship("alice", "acme corp", "WORKS_AT");

    expect(result).toBe(true);
    const [[query, params]] = session.run.mock.calls as [[string, Record<string, unknown>]];
    expect(query).toContain("WORKS_AT");
    expect(query).toContain("WHERE rel.validUntil IS NULL");
    expect(query).toContain("SET rel.validUntil = $now");
    expect(query).toContain("rel.updatedAt = $now");
    expect(params).toMatchObject({ nameA: "alice", nameB: "acme corp" });
    expect(typeof params.now).toBe("string");
  });

  it("accepts a custom closedAt timestamp", async () => {
    const { client, session } = makeClient();
    session.run.mockResolvedValueOnce({
      records: [{ get: vi.fn().mockReturnValue(1) }],
    });
    const ts = "2025-01-15T10:00:00.000Z";

    await client.closeEntityRelationship("alice", "acme", "WORKS_AT", ts);

    const [[, params]] = session.run.mock.calls as [[string, Record<string, unknown>]];
    expect(params.now).toBe(ts);
  });

  it("returns false when no active relationship found", async () => {
    const { client, session } = makeClient();
    session.run.mockResolvedValueOnce({
      records: [{ get: vi.fn().mockReturnValue(0) }],
    });

    const result = await client.closeEntityRelationship("alice", "acme", "WORKS_AT");

    expect(result).toBe(false);
  });

  it("throws on invalid relationship type", async () => {
    const { client } = makeClient();

    await expect(client.closeEntityRelationship("alice", "acme", "INVALID_TYPE")).rejects.toThrow(
      "Invalid relationship type",
    );
  });

  it("lowercases and trims entity names before querying", async () => {
    const { client, session } = makeClient();
    session.run.mockResolvedValueOnce({
      records: [{ get: vi.fn().mockReturnValue(1) }],
    });

    await client.closeEntityRelationship("  Alice  ", "  ACME Corp  ", "KNOWS");

    const [[, params]] = session.run.mock.calls as [[string, Record<string, unknown>]];
    expect(params.nameA).toBe("alice");
    expect(params.nameB).toBe("acme corp");
  });
});

// ============================================================================
// OP-122: batchEntityOperations — validFrom/validUntil on new relationships
// ============================================================================

describe("batchEntityOperations (OP-122 temporal fields)", () => {
  it("sets validFrom and validUntil=null ON CREATE for inter-entity relationships", async () => {
    const { client, session } = makeClient();

    // executeWrite needs to delegate to a tx
    const txRun = vi.fn().mockResolvedValue({ records: [] });
    session.executeWrite = vi
      .fn()
      .mockImplementation(async (fn: (tx: any) => Promise<void>) => fn({ run: txRun }));

    await client.batchEntityOperations(
      "mem-1",
      [
        { id: "e1", name: "Alice", type: "person" },
        { id: "e2", name: "Acme", type: "organization" },
      ],
      [{ source: "alice", target: "acme", type: "WORKS_AT", confidence: 0.9 }],
      [],
    );

    // Find the MERGE call for WORKS_AT
    const mergeCall = txRun.mock.calls.find(
      (args: any[]) => typeof args[0] === "string" && args[0].includes("MERGE (e1)-[rel:WORKS_AT]"),
    );
    expect(mergeCall).toBeDefined();
    const [query] = mergeCall!;
    expect(query).toContain("rel.validFrom = $now");
    expect(query).toContain("rel.validUntil = null");
    // ON MATCH must NOT touch validFrom/validUntil
    const onMatchPart = query.slice(query.indexOf("ON MATCH"));
    expect(onMatchPart).not.toContain("validFrom");
    expect(onMatchPart).not.toContain("validUntil");
  });

  it("sets updatedAt on ON MATCH for existing inter-entity relationships", async () => {
    const { client, session } = makeClient();

    const txRun = vi.fn().mockResolvedValue({ records: [] });
    session.executeWrite = vi
      .fn()
      .mockImplementation(async (fn: (tx: any) => Promise<void>) => fn({ run: txRun }));

    await client.batchEntityOperations(
      "mem-2",
      [
        { id: "e1", name: "Alice", type: "person" },
        { id: "e2", name: "Acme", type: "organization" },
      ],
      [{ source: "alice", target: "acme", type: "WORKS_AT", confidence: 0.9 }],
      [],
    );

    const mergeCall = txRun.mock.calls.find(
      (args: any[]) => typeof args[0] === "string" && args[0].includes("MERGE (e1)-[rel:WORKS_AT]"),
    );
    expect(mergeCall).toBeDefined();
    const [query] = mergeCall!;
    // ON MATCH must set updatedAt
    const onMatchPart = query.slice(query.indexOf("ON MATCH"));
    expect(onMatchPart).toContain("updatedAt");
  });
});

// ============================================================================
// OP-122: expireOrphanedEntityRelationships
// ============================================================================

describe("expireOrphanedEntityRelationships (OP-122)", () => {
  it("sets validUntil on relationships whose memories are all superseded", async () => {
    const { client, session } = makeClient();

    // Each relType triggers one session.run; return count=1 for the first, 0 for the rest
    session.run
      .mockResolvedValueOnce({ records: [{ get: vi.fn().mockReturnValue(1) }] })
      .mockResolvedValue({ records: [{ get: vi.fn().mockReturnValue(0) }] });

    const expired = await client.expireOrphanedEntityRelationships("agent-1");

    expect(expired).toBeGreaterThan(0);
    const firstCall = session.run.mock.calls[0];
    const [query, params] = firstCall as [string, Record<string, unknown>];
    expect(query).toContain("rel.validUntil IS NULL");
    expect(query).toContain("NOT EXISTS");
    expect(query).toContain("SET rel.validUntil = $now");
    expect(params).toMatchObject({ agentId: "agent-1" });
    expect(typeof params.now).toBe("string");
    expect(session.close).toHaveBeenCalled();
  });

  it("returns 0 when no relationships are orphaned", async () => {
    const { client, session } = makeClient();
    session.run.mockResolvedValue({ records: [{ get: vi.fn().mockReturnValue(0) }] });

    const expired = await client.expireOrphanedEntityRelationships("agent-1");
    expect(expired).toBe(0);
  });
});

// ============================================================================
// OP-122: graphSearch — validity filter on N-hop rels
// ============================================================================

describe("graphSearch validity filter (OP-122)", () => {
  it("includes validUntil filter in N-hop traversal when includeExpired is false", async () => {
    const { client, session } = makeClient();
    session.run.mockResolvedValue({ records: [] });

    await client.graphSearch("alice", 10, 0.3, "agent-1", 1, false);

    const [[query]] = session.run.mock.calls as [[string, Record<string, unknown>]];
    expect(query).toContain("r.validUntil IS NULL OR r.validUntil >= $now");
  });

  it("omits validUntil filter in N-hop traversal when includeExpired is true", async () => {
    const { client, session } = makeClient();
    session.run.mockResolvedValue({ records: [] });

    await client.graphSearch("alice", 10, 0.3, "agent-1", 1, true);

    const [[query]] = session.run.mock.calls as [[string, Record<string, unknown>]];
    // Should not contain the rel validUntil guard (memory filters already absent)
    expect(query).not.toContain("r.validUntil IS NULL OR r.validUntil >= $now");
  });
});
