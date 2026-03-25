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
    executeWrite: null as unknown as ReturnType<typeof vi.fn>,
    executeRead: null as unknown as ReturnType<typeof vi.fn>,
  };
  session.executeWrite = vi.fn().mockImplementation((fn) => fn({ run: session.run }));
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

    timeout: 30_000,
    concurrency: 8,
    localNerEnabled: false,
    maxTokens: 4096,
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

  it("throws on relationship type with unsafe characters", async () => {
    const { client } = makeClient();

    await expect(
      client.closeEntityRelationship("alice", "acme", "WORKS_AT]->(n) DELETE n//"),
    ).rejects.toThrow("Unsafe Cypher relationship type");
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
// Batched entity property writes (UNWIND n += row.props)
// ============================================================================

describe("batchEntityOperations (batched property writes)", () => {
  it("writes properties for multiple entities in a single UNWIND query", async () => {
    const { client, session } = makeClient();

    const txRun = vi.fn().mockResolvedValue({ records: [] });
    session.executeWrite = vi
      .fn()
      .mockImplementation(async (fn: (tx: any) => Promise<void>) => fn({ run: txRun }));

    await client.batchEntityOperations(
      "mem-1",
      [
        {
          id: "e1",
          name: "Alice",
          type: "person",
          properties: { phone: "555-1234", email: "a@b.com" },
        },
        { id: "e2", name: "Bob", type: "person", properties: { birthday: "1990-01-01" } },
      ],
      [],
      [],
    );

    // Find the UNWIND property-write call (contains n += row.props)
    const propCall = txRun.mock.calls.find(
      (args: any[]) => typeof args[0] === "string" && args[0].includes("n += row.props"),
    );
    expect(propCall).toBeDefined();
    // Verify both entities are in the batch
    const rows = propCall![1].rows as Array<{ name: string; props: Record<string, unknown> }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].name).toBe("alice");
    expect(rows[0].props).toEqual({ phone: "555-1234", email: "a@b.com" });
    expect(rows[1].name).toBe("bob");
    expect(rows[1].props).toEqual({ birthday: "1990-01-01" });
  });

  it("skips entities without properties", async () => {
    const { client, session } = makeClient();

    const txRun = vi.fn().mockResolvedValue({ records: [] });
    session.executeWrite = vi
      .fn()
      .mockImplementation(async (fn: (tx: any) => Promise<void>) => fn({ run: txRun }));

    await client.batchEntityOperations(
      "mem-1",
      [
        { id: "e1", name: "Alice", type: "person" },
        { id: "e2", name: "Bob", type: "person", properties: { email: "b@c.com" } },
      ],
      [],
      [],
    );

    const propCall = txRun.mock.calls.find(
      (args: any[]) => typeof args[0] === "string" && args[0].includes("n += row.props"),
    );
    expect(propCall).toBeDefined();
    const rows = propCall![1].rows as Array<{ name: string; props: Record<string, unknown> }>;
    // Only Bob has properties
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("bob");
  });

  it("filters out invalid property keys", async () => {
    const { client, session } = makeClient();

    const txRun = vi.fn().mockResolvedValue({ records: [] });
    session.executeWrite = vi
      .fn()
      .mockImplementation(async (fn: (tx: any) => Promise<void>) => fn({ run: txRun }));

    await client.batchEntityOperations(
      "mem-1",
      [
        {
          id: "e1",
          name: "Alice",
          type: "person",
          properties: { email: "a@b.com", "INVALID-KEY": "bad", "123start": "bad" },
        },
      ],
      [],
      [],
    );

    const propCall = txRun.mock.calls.find(
      (args: any[]) => typeof args[0] === "string" && args[0].includes("n += row.props"),
    );
    expect(propCall).toBeDefined();
    const rows = propCall![1].rows as Array<{ name: string; props: Record<string, unknown> }>;
    // Only "email" passes the /^[a-z_][a-z0-9_]*$/ check
    expect(rows[0].props).toEqual({ email: "a@b.com" });
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

describe("expireOrphanedEntityRelationships (OP-142)", () => {
  it("expires relationships where at least one endpoint is orphaned", async () => {
    const { client, session } = makeClient();

    // OP-142: Single query checks for orphaned endpoints (no MENTIONS AND no other entity-entity rels)
    session.run.mockResolvedValueOnce({ records: [{ get: vi.fn().mockReturnValue(2) }] });

    const expired = await client.expireOrphanedEntityRelationships("agent-1");

    expect(expired).toBe(2);
    const [query] = session.run.mock.calls[0] as [string];
    expect(query).toContain("rel.validUntil IS NULL");
    // OP-142: No longer checks MENTIONS-based co-mention — checks for orphaned endpoints
    expect(query).toContain("NOT EXISTS");
    // Uses `other <> rel` pattern to check for orphaned endpoints
    expect(query).toContain("other <> rel");
    expect(session.close).toHaveBeenCalled();
  });

  it("returns 0 when no endpoints are orphaned", async () => {
    const { client, session } = makeClient();
    session.run.mockResolvedValue({ records: [{ get: vi.fn().mockReturnValue(0) }] });

    const expired = await client.expireOrphanedEntityRelationships("agent-1");
    expect(expired).toBe(0);
  });

  it("preserves relationships where both endpoints have other entity-entity rels", async () => {
    const { client, session } = makeClient();
    // Both endpoints have other relationships — nothing to expire
    session.run.mockResolvedValueOnce({ records: [{ get: vi.fn().mockReturnValue(0) }] });

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
    // OP-143: structuredGraphSearch runs multiple session.run calls:
    // 1. Fulltext seed query — must return at least one seed for traversal to proceed
    // 2. Main traversal query — this is where the validity filter lives
    session.run
      .mockResolvedValueOnce({
        // Fulltext seed: return one entity element ID so traversal proceeds
        records: [{ get: (k: string) => (k === "eid" ? "elem-alice" : 0.9) }],
      })
      .mockResolvedValue({ records: [] }); // Main traversal (and any subsequent calls)

    await client.graphSearch("alice", 10, 0.3, "agent-1", 1, false);

    // The main traversal is the last call after seed queries
    const calls = session.run.mock.calls as [string, Record<string, unknown>][];
    const traversalQuery = calls[calls.length - 1][0];
    // OP-122: filter expressed as: none(r IN rels WHERE r.validUntil IS NOT NULL AND r.validUntil < $now)
    expect(traversalQuery).toContain("r.validUntil IS NOT NULL AND r.validUntil < $now");
  });

  it("omits validUntil filter in N-hop traversal when includeExpired is true", async () => {
    const { client, session } = makeClient();
    session.run
      .mockResolvedValueOnce({
        // Fulltext seed: return one entity element ID so traversal proceeds
        records: [{ get: (k: string) => (k === "eid" ? "elem-alice" : 0.9) }],
      })
      .mockResolvedValue({ records: [] });

    await client.graphSearch("alice", 10, 0.3, "agent-1", 1, true);

    // The main traversal is the last call after seed queries
    const calls = session.run.mock.calls as [string, Record<string, unknown>][];
    const traversalQuery = calls[calls.length - 1][0];
    // Should not contain the rel validUntil guard when includeExpired=true
    expect(traversalQuery).not.toContain("r.validUntil IS NOT NULL AND r.validUntil < $now");
  });
});

// ============================================================================
// OP-177: lastSeen on ON MATCH for entity relationships
// ============================================================================

describe("batchEntityOperations (OP-177 lastSeen)", () => {
  it("sets lastSeen on ON MATCH for existing inter-entity relationships", async () => {
    const { client, session } = makeClient();

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

    const mergeCall = txRun.mock.calls.find(
      (args: any[]) => typeof args[0] === "string" && args[0].includes("MERGE (e1)-[rel:WORKS_AT]"),
    );
    expect(mergeCall).toBeDefined();
    const [query] = mergeCall!;
    const onMatchPart = query.slice(query.indexOf("ON MATCH"));
    expect(onMatchPart).toContain("rel.lastSeen = $now");
  });
});

// ============================================================================
// OP-177: supersedeRelationship
// ============================================================================

describe("supersedeRelationship (OP-177)", () => {
  it("closes active relationships of the same type to other targets", async () => {
    const { client, session } = makeClient();
    session.run.mockResolvedValueOnce({
      records: [{ get: vi.fn().mockReturnValue(1) }],
    });

    const count = await client.supersedeRelationship("tarun", "LIVES_IN", "capsquare", "agent-1");

    expect(count).toBe(1);
    const [[query, params]] = session.run.mock.calls as [[string, Record<string, unknown>]];
    expect(query).toContain("LIVES_IN");
    expect(query).toContain("rel.validUntil IS NULL");
    expect(query).toContain("tgt.name <> $tgtName");
    expect(query).toContain("SET rel.validUntil = $now");
    expect(params).toMatchObject({
      srcName: "tarun",
      tgtName: "capsquare",
      agentId: "agent-1",
    });
  });

  it("returns 0 when no active relationships exist", async () => {
    const { client, session } = makeClient();
    session.run.mockResolvedValueOnce({
      records: [{ get: vi.fn().mockReturnValue(0) }],
    });

    const count = await client.supersedeRelationship("tarun", "LIVES_IN", "capsquare", "agent-1");

    expect(count).toBe(0);
  });

  it("accepts a custom closedAt timestamp", async () => {
    const { client, session } = makeClient();
    session.run.mockResolvedValueOnce({
      records: [{ get: vi.fn().mockReturnValue(1) }],
    });
    const ts = "2025-06-01T00:00:00.000Z";

    await client.supersedeRelationship("tarun", "LIVES_IN", "capsquare", "agent-1", ts);

    const [[, params]] = session.run.mock.calls as [[string, Record<string, unknown>]];
    expect(params.now).toBe(ts);
  });

  it("lowercases and trims entity names", async () => {
    const { client, session } = makeClient();
    session.run.mockResolvedValueOnce({
      records: [{ get: vi.fn().mockReturnValue(1) }],
    });

    await client.supersedeRelationship("  Tarun  ", "LIVES_IN", "  Capsquare  ", "agent-1");

    const [[, params]] = session.run.mock.calls as [[string, Record<string, unknown>]];
    expect(params.srcName).toBe("tarun");
    expect(params.tgtName).toBe("capsquare");
  });

  it("throws on unsafe relationship type", async () => {
    const { client } = makeClient();

    await expect(
      client.supersedeRelationship("tarun", "LIVES_IN]->(n) DELETE n//", "capsquare", "agent-1"),
    ).rejects.toThrow("Unsafe Cypher relationship type");
  });
});
