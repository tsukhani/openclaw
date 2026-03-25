/**
 * Tests for neo4j-client-episode.ts — Episodic Memory Operations.
 *
 * Tests mergeEpisode, linkMemoryToEpisode, queryEpisodes, and
 * deleteExpiredEpisodes using mocked Neo4j sessions.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  mergeEpisode,
  linkMemoryToEpisode,
  queryEpisodes,
  deleteExpiredEpisodes,
} from "./neo4j-client-episode.js";
import { episodeEnrich } from "./neo4j-client-search.js";
import type { EpisodeNode } from "./schema.js";

// ============================================================================
// Test Helpers
// ============================================================================

function mockRecord(data: Record<string, unknown>) {
  return {
    get: (key: string) => data[key],
  };
}

function createMockSession() {
  const txRun = vi.fn().mockResolvedValue({ records: [] });

  const session = {
    run: vi.fn().mockResolvedValue({ records: [] }),
    close: vi.fn().mockResolvedValue(undefined),
    executeWrite: vi.fn(async (work: (tx: { run: typeof txRun }) => Promise<unknown>) => {
      const mockTx = { run: txRun };
      return work(mockTx);
    }),
    executeRead: vi.fn(async (work: (tx: { run: typeof txRun }) => Promise<unknown>) => {
      const mockTx = { run: txRun };
      return work(mockTx);
    }),
    /** Direct access to the inner transaction run mock for assertions. */
    _txRun: txRun,
  };
  return session;
}

function sampleEpisode(overrides: Partial<EpisodeNode> = {}): EpisodeNode {
  return {
    id: "ep-001",
    text: "Hello, how can I help you?",
    role: "assistant",
    timestamp: "2026-03-16T10:00:00Z",
    sessionKey: "session-abc",
    agentId: "agent-42",
    ...overrides,
  };
}

// ============================================================================
// mergeEpisode
// ============================================================================

describe("mergeEpisode", () => {
  let session: ReturnType<typeof createMockSession>;

  beforeEach(() => {
    session = createMockSession();
  });

  it("creates an Episode node with correct Cypher and properties", async () => {
    const episode = sampleEpisode();

    session._txRun.mockResolvedValueOnce({
      records: [mockRecord({ id: "ep-001" })],
    });

    const id = await mergeEpisode(session as any, episode);

    expect(id).toBe("ep-001");
    expect(session.executeWrite).toHaveBeenCalledOnce();

    // Verify the Cypher query passed to tx.run
    const [cypher, params] = session._txRun.mock.calls[0];
    expect(cypher).toContain("MERGE (e:Episode {id: $id})");
    expect(cypher).toContain("ON CREATE SET");
    expect(cypher).toContain("e.text = $text");
    expect(cypher).toContain("e.role = $role");
    expect(cypher).toContain("e.timestamp = $timestamp");
    expect(cypher).toContain("e.sessionKey = $sessionKey");
    expect(cypher).toContain("e.agentId = $agentId");
    expect(params).toEqual({
      id: "ep-001",
      text: "Hello, how can I help you?",
      role: "assistant",
      timestamp: "2026-03-16T10:00:00Z",
      sessionKey: "session-abc",
      agentId: "agent-42",
    });
  });

  it("is idempotent — uses MERGE not CREATE for duplicate IDs", async () => {
    const episode = sampleEpisode();

    session._txRun.mockResolvedValue({
      records: [mockRecord({ id: "ep-001" })],
    });

    await mergeEpisode(session as any, episode);
    await mergeEpisode(session as any, episode);

    expect(session.executeWrite).toHaveBeenCalledTimes(2);

    // Both calls should use MERGE, not CREATE
    for (const call of session._txRun.mock.calls) {
      const cypher = call[0] as string;
      expect(cypher).toContain("MERGE");
      expect(cypher).not.toMatch(/^\s*CREATE\s/m);
    }
  });

  it("falls back to episode.id when no record is returned", async () => {
    const episode = sampleEpisode({ id: "ep-fallback" });

    session._txRun.mockResolvedValueOnce({ records: [] });

    const id = await mergeEpisode(session as any, episode);
    expect(id).toBe("ep-fallback");
  });
});

// ============================================================================
// linkMemoryToEpisode
// ============================================================================

describe("linkMemoryToEpisode", () => {
  let session: ReturnType<typeof createMockSession>;

  beforeEach(() => {
    session = createMockSession();
  });

  it("creates EPISODE_SOURCE relationship with correct Cypher", async () => {
    session._txRun.mockResolvedValueOnce({ records: [] });

    await linkMemoryToEpisode(session as any, "mem-100", "ep-001");

    expect(session.executeWrite).toHaveBeenCalledOnce();

    const [cypher, params] = session._txRun.mock.calls[0];
    expect(cypher).toContain("MATCH (m:Memory {id: $memoryId})");
    expect(cypher).toContain("(e:Episode {id: $episodeId})");
    expect(cypher).toContain("MERGE (m)-[:EPISODE_SOURCE]->(e)");
    expect(params).toEqual({ memoryId: "mem-100", episodeId: "ep-001" });
  });
});

// ============================================================================
// queryEpisodes
// ============================================================================

describe("queryEpisodes", () => {
  let session: ReturnType<typeof createMockSession>;

  beforeEach(() => {
    session = createMockSession();
  });

  function episodeRecords(episodes: EpisodeNode[]) {
    return episodes.map((ep) =>
      mockRecord({
        id: ep.id,
        text: ep.text,
        role: ep.role,
        timestamp: ep.timestamp,
        sessionKey: ep.sessionKey,
        agentId: ep.agentId,
      }),
    );
  }

  it("filters by sessionKey", async () => {
    const episodes = [
      sampleEpisode({ id: "ep-1", sessionKey: "abc" }),
      sampleEpisode({ id: "ep-2", sessionKey: "abc" }),
      sampleEpisode({ id: "ep-3", sessionKey: "abc" }),
    ];

    session._txRun.mockResolvedValueOnce({
      records: episodeRecords(episodes),
    });

    const result = await queryEpisodes(session as any, "agent-42", {
      sessionKey: "abc",
    });

    expect(result).toHaveLength(3);

    const [cypher, params] = session._txRun.mock.calls[0];
    expect(cypher).toContain("e.sessionKey = $sessionKey");
    expect(params.sessionKey).toBe("abc");
    expect(params.agentId).toBe("agent-42");
  });

  it("filters by time range (from/to)", async () => {
    session._txRun.mockResolvedValueOnce({ records: [] });

    await queryEpisodes(session as any, "agent-42", {
      from: "2026-03-15T00:00:00Z",
      to: "2026-03-16T23:59:59Z",
    });

    const [cypher, params] = session._txRun.mock.calls[0];
    expect(cypher).toContain("e.timestamp >= $from");
    expect(cypher).toContain("e.timestamp <= $to");
    expect(params.from).toBe("2026-03-15T00:00:00Z");
    expect(params.to).toBe("2026-03-16T23:59:59Z");
  });

  it("filters by both sessionKey and time range", async () => {
    session._txRun.mockResolvedValueOnce({ records: [] });

    await queryEpisodes(session as any, "agent-42", {
      sessionKey: "sess-xyz",
      from: "2026-03-15T00:00:00Z",
      to: "2026-03-16T23:59:59Z",
    });

    const [cypher, params] = session._txRun.mock.calls[0];
    expect(cypher).toContain("e.agentId = $agentId");
    expect(cypher).toContain("e.sessionKey = $sessionKey");
    expect(cypher).toContain("e.timestamp >= $from");
    expect(cypher).toContain("e.timestamp <= $to");
    expect(params).toMatchObject({
      agentId: "agent-42",
      sessionKey: "sess-xyz",
      from: "2026-03-15T00:00:00Z",
      to: "2026-03-16T23:59:59Z",
    });
  });

  it("respects limit parameter", async () => {
    session._txRun.mockResolvedValueOnce({ records: [] });

    await queryEpisodes(session as any, "agent-42", { limit: 2 });

    const [cypher, params] = session._txRun.mock.calls[0];
    expect(cypher).toContain("LIMIT $limit");
    // neo4j.int(2) wraps the number; check the underlying value
    expect(params.limit.toNumber()).toBe(2);
  });

  it("defaults limit to 100 when not specified", async () => {
    session._txRun.mockResolvedValueOnce({ records: [] });

    await queryEpisodes(session as any, "agent-42");

    const [, params] = session._txRun.mock.calls[0];
    expect(params.limit.toNumber()).toBe(100);
  });

  it("returns results in chronological order (ORDER BY timestamp ASC)", async () => {
    const ep1 = sampleEpisode({ id: "ep-early", timestamp: "2026-03-16T08:00:00Z" });
    const ep2 = sampleEpisode({ id: "ep-late", timestamp: "2026-03-16T18:00:00Z" });

    session._txRun.mockResolvedValueOnce({
      records: episodeRecords([ep1, ep2]),
    });

    const result = await queryEpisodes(session as any, "agent-42");

    const [cypher] = session._txRun.mock.calls[0];
    expect(cypher).toContain("ORDER BY e.timestamp ASC");

    // Result order matches the mock (which should already be chronological)
    expect(result[0].id).toBe("ep-early");
    expect(result[1].id).toBe("ep-late");
  });

  it("uses executeRead for queries (read-only transaction)", async () => {
    session._txRun.mockResolvedValueOnce({ records: [] });

    await queryEpisodes(session as any, "agent-42");

    expect(session.executeRead).toHaveBeenCalledOnce();
    expect(session.executeWrite).not.toHaveBeenCalled();
  });

  it("maps returned records to EpisodeNode objects", async () => {
    const episode = sampleEpisode({
      id: "ep-mapped",
      text: "Mapped text",
      role: "user",
      timestamp: "2026-03-16T12:00:00Z",
      sessionKey: "sess-map",
      agentId: "agent-99",
    });

    session._txRun.mockResolvedValueOnce({
      records: episodeRecords([episode]),
    });

    const result = await queryEpisodes(session as any, "agent-99");

    expect(result).toEqual([
      {
        id: "ep-mapped",
        text: "Mapped text",
        role: "user",
        timestamp: "2026-03-16T12:00:00Z",
        sessionKey: "sess-map",
        agentId: "agent-99",
      },
    ]);
  });
});

// ============================================================================
// deleteExpiredEpisodes
// ============================================================================

describe("deleteExpiredEpisodes", () => {
  let session: ReturnType<typeof createMockSession>;

  beforeEach(() => {
    session = createMockSession();
  });

  it("removes episodes older than cutoff date", async () => {
    // H2: deleteExpiredEpisodes now uses count-then-delete pattern (two queries)
    // H3: Batched deletion — single query returns count of deleted episodes
    session._txRun.mockResolvedValueOnce({ records: [mockRecord({ deleted: 5 })] }); // batch 1 (< BATCH_SIZE → last page)

    const count = await deleteExpiredEpisodes(session as any, "2026-03-01T00:00:00Z");

    expect(count).toBe(5);

    const [cypher, params] = session._txRun.mock.calls[0];
    expect(cypher).toContain("e.timestamp < $cutoffDate");
    expect(cypher).toContain("DETACH DELETE e");
    expect(cypher).toContain("count(*) AS deleted");
    expect(params.cutoffDate).toBe("2026-03-01T00:00:00Z");
  });

  it("scopes to agentId when provided", async () => {
    // H3: Batched deletion with agent filter
    session._txRun.mockResolvedValueOnce({ records: [mockRecord({ deleted: 3 })] });

    const count = await deleteExpiredEpisodes(session as any, "2026-03-01T00:00:00Z", "agent-42");

    expect(count).toBe(3);

    const [cypher, params] = session._txRun.mock.calls[0];
    expect(cypher).toContain("e.agentId = $agentId");
    expect(params.agentId).toBe("agent-42");
    expect(params.cutoffDate).toBe("2026-03-01T00:00:00Z");
  });

  it("does not include agentId filter when agentId is omitted", async () => {
    session._txRun.mockResolvedValueOnce({
      records: [mockRecord({ deleted: 0 })],
    });

    await deleteExpiredEpisodes(session as any, "2026-03-01T00:00:00Z");

    const [cypher, params] = session._txRun.mock.calls[0];
    expect(cypher).not.toContain("e.agentId");
    // H3: agentId is not passed in params when omitted
  });

  it("returns 0 when no records are returned", async () => {
    session._txRun.mockResolvedValueOnce({ records: [mockRecord({ deleted: 0 })] });

    const count = await deleteExpiredEpisodes(session as any, "2026-03-01T00:00:00Z");
    expect(count).toBe(0);
  });
});

// ============================================================================
// episodeEnrich (OP-178)
// ============================================================================

describe("episodeEnrich", () => {
  let session: ReturnType<typeof createMockSession>;

  beforeEach(() => {
    session = createMockSession();
  });

  it("returns episode metadata for memories with EPISODE_SOURCE links", async () => {
    session._txRun.mockResolvedValueOnce({
      records: [
        mockRecord({
          memoryId: "mem-1",
          episodeId: "ep-001",
          episodeDate: "2026-03-16T10:00:00Z",
          episodeSessionKey: "session-abc",
        }),
        mockRecord({
          memoryId: "mem-2",
          episodeId: "ep-002",
          episodeDate: "2026-03-16T11:00:00Z",
          episodeSessionKey: "session-abc",
        }),
      ],
    });

    const result = await episodeEnrich(session as any, ["mem-1", "mem-2", "mem-3"]);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      memoryId: "mem-1",
      episodeId: "ep-001",
      episodeDate: "2026-03-16T10:00:00Z",
      episodeSessionKey: "session-abc",
    });
    expect(result[1]).toEqual({
      memoryId: "mem-2",
      episodeId: "ep-002",
      episodeDate: "2026-03-16T11:00:00Z",
      episodeSessionKey: "session-abc",
    });

    // Verify Cypher uses OPTIONAL MATCH and filters out nulls
    const [cypher, params] = session._txRun.mock.calls[0];
    expect(cypher).toContain("OPTIONAL MATCH (m)-[:EPISODE_SOURCE]->(ep:Episode)");
    expect(cypher).toContain("WHERE ep IS NOT NULL");
    expect(params.memoryIds).toEqual(["mem-1", "mem-2", "mem-3"]);
  });

  it("returns empty array when no memories have episodes", async () => {
    session._txRun.mockResolvedValueOnce({ records: [] });

    const result = await episodeEnrich(session as any, ["mem-1"]);
    expect(result).toHaveLength(0);
  });

  it("returns empty array for empty input", async () => {
    const result = await episodeEnrich(session as any, []);
    expect(result).toHaveLength(0);
    expect(session.executeRead).not.toHaveBeenCalled();
  });

  it("uses executeRead for queries (read-only transaction)", async () => {
    session._txRun.mockResolvedValueOnce({ records: [] });

    await episodeEnrich(session as any, ["mem-1"]);

    expect(session.executeRead).toHaveBeenCalledOnce();
    expect(session.executeWrite).not.toHaveBeenCalled();
  });
});
