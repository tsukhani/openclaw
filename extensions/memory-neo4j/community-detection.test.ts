/**
 * Tests for community detection: label propagation, CRUD, community search,
 * and RRF fusion integration.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  runLabelPropagation,
  mergeCommunity,
  cleanStaleCommunityLinks,
  getCommunities,
} from "./neo4j-client-community.js";
import { communitySearch } from "./neo4j-client-search.js";
import type { CommunityNode, SearchSignalResult } from "./schema.js";
import { fuseWithConfidenceRRF } from "./search.js";

// ============================================================================
// Test Helpers
// ============================================================================

/** Create a mock Neo4j record whose .get() returns fields by name. */
function mockRecord(fields: Record<string, unknown>) {
  return { get: (key: string) => fields[key] };
}

/** Create a mock Neo4j session with configurable executeRead/executeWrite. */
function createMockSession() {
  const session = {
    run: vi.fn().mockResolvedValue({ records: [] }),
    close: vi.fn().mockResolvedValue(undefined),
    executeWrite: vi.fn(
      async (work: (tx: { run: ReturnType<typeof vi.fn> }) => Promise<unknown>) => {
        const mockTx = { run: vi.fn().mockResolvedValue({ records: [] }) };
        return work(mockTx);
      },
    ),
    executeRead: null as unknown as ReturnType<typeof vi.fn>,
  };
  session.executeRead = vi.fn().mockImplementation((fn) => fn({ run: session.run }));
  return session;
}

function makeSignalResult(id: string, score: number, trustScore?: number): SearchSignalResult {
  return {
    id,
    text: `Memory ${id}`,
    category: "fact",
    importance: 0.8,
    createdAt: "2026-01-01T00:00:00Z",
    score,
    trustScore,
  };
}

// ============================================================================
// Label Propagation
// ============================================================================

describe("runLabelPropagation", () => {
  let session: ReturnType<typeof createMockSession>;

  beforeEach(() => {
    session = createMockSession();
  });

  it("connected entities form clusters", async () => {
    // Group A: a1-a2-a3 connected; Group B: b1-b2-b3 connected; c1 isolated
    session.run.mockResolvedValue({
      records: [
        mockRecord({ entityId: "a1", neighborIds: ["a2", "a3"] }),
        mockRecord({ entityId: "a2", neighborIds: ["a1", "a3"] }),
        mockRecord({ entityId: "a3", neighborIds: ["a1", "a2"] }),
        mockRecord({ entityId: "b1", neighborIds: ["b2", "b3"] }),
        mockRecord({ entityId: "b2", neighborIds: ["b1", "b3"] }),
        mockRecord({ entityId: "b3", neighborIds: ["b1", "b2"] }),
        mockRecord({ entityId: "c1", neighborIds: [] }),
      ],
    });

    const clusters = await runLabelPropagation(session as any, "agent-1", {
      minCommunitySize: 3,
    });

    expect(clusters.length).toBe(2);

    // Both clusters should have exactly 3 members
    const sizes = clusters.map((c) => c.length).toSorted();
    expect(sizes).toEqual([3, 3]);

    // Verify group membership: each cluster should contain all members of one group
    const clusterSets = clusters.map((c) => new Set(c));
    const groupA = new Set(["a1", "a2", "a3"]);
    const groupB = new Set(["b1", "b2", "b3"]);

    const matchesA = clusterSets.some(
      (s) => s.size === groupA.size && [...groupA].every((id) => s.has(id)),
    );
    const matchesB = clusterSets.some(
      (s) => s.size === groupB.size && [...groupB].every((id) => s.has(id)),
    );

    expect(matchesA).toBe(true);
    expect(matchesB).toBe(true);
  });

  it("respects minCommunitySize — filters out small clusters", async () => {
    // Three entities connected — but minCommunitySize=4 excludes them
    session.run.mockResolvedValue({
      records: [
        mockRecord({ entityId: "a1", neighborIds: ["a2", "a3"] }),
        mockRecord({ entityId: "a2", neighborIds: ["a1", "a3"] }),
        mockRecord({ entityId: "a3", neighborIds: ["a1", "a2"] }),
      ],
    });

    const clusters = await runLabelPropagation(session as any, "agent-1", {
      minCommunitySize: 4,
    });

    expect(clusters).toEqual([]);
  });

  it("converges early when no labels change", async () => {
    // All entities already share the same neighbor — should converge in 1 iteration
    // Star topology: center connected to all, spokes only to center
    session.run.mockResolvedValue({
      records: [
        mockRecord({ entityId: "center", neighborIds: ["s1", "s2", "s3"] }),
        mockRecord({ entityId: "s1", neighborIds: ["center"] }),
        mockRecord({ entityId: "s2", neighborIds: ["center"] }),
        mockRecord({ entityId: "s3", neighborIds: ["center"] }),
      ],
    });

    // maxIterations=100 but should stop early
    const clusters = await runLabelPropagation(session as any, "agent-1", {
      maxIterations: 100,
      minCommunitySize: 3,
    });

    // All entities should converge into one cluster
    expect(clusters.length).toBe(1);
    expect(clusters[0].length).toBe(4);
  });

  it("returns empty array for empty graph", async () => {
    session.run.mockResolvedValue({ records: [] });

    const clusters = await runLabelPropagation(session as any, "agent-1");

    expect(clusters).toEqual([]);
  });

  it("returns empty array for single entity (below minCommunitySize)", async () => {
    session.run.mockResolvedValue({
      records: [mockRecord({ entityId: "solo", neighborIds: [] })],
    });

    const clusters = await runLabelPropagation(session as any, "agent-1", {
      minCommunitySize: 3,
    });

    expect(clusters).toEqual([]);
  });
});

// ============================================================================
// Community CRUD
// ============================================================================

describe("mergeCommunity", () => {
  it("creates community node with BELONGS_TO relationships", async () => {
    const session = createMockSession();
    let capturedQuery = "";
    let capturedParams: Record<string, unknown> = {};

    session.executeWrite.mockImplementation(
      async (work: (tx: { run: ReturnType<typeof vi.fn> }) => Promise<unknown>) => {
        const mockTx = {
          run: vi.fn().mockImplementation((query: string, params: Record<string, unknown>) => {
            capturedQuery = query;
            capturedParams = params;
            return { records: [] };
          }),
        };
        return work(mockTx);
      },
    );

    const community: CommunityNode = {
      id: "comm-1",
      name: "Test Community",
      summary: "A test community",
      entityCount: 3,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };

    await mergeCommunity(session as any, community, ["e1", "e2", "e3"]);

    expect(session.executeWrite).toHaveBeenCalledOnce();
    expect(capturedQuery).toContain("MERGE (c:Community {id: $id})");
    expect(capturedQuery).toContain("MERGE (e)-[:BELONGS_TO]->(c)");
    expect(capturedParams.id).toBe("comm-1");
    expect(capturedParams.name).toBe("Test Community");
    expect(capturedParams.summary).toBe("A test community");
    expect(capturedParams.memberIds).toEqual(["e1", "e2", "e3"]);
    expect(capturedParams.createdAt).toBe("2026-01-01T00:00:00Z");
  });
});

describe("cleanStaleCommunityLinks", () => {
  it("removes orphaned communities and returns count", async () => {
    const session = createMockSession();
    session.executeWrite.mockImplementation(
      async (work: (tx: { run: ReturnType<typeof vi.fn> }) => Promise<unknown>) => {
        const mockTx = {
          run: vi.fn().mockResolvedValue({
            records: [mockRecord({ removed: 5 })],
          }),
        };
        return work(mockTx);
      },
    );

    const removed = await cleanStaleCommunityLinks(session as any, ["active-1", "active-2"]);

    expect(removed).toBe(5);
    expect(session.executeWrite).toHaveBeenCalledOnce();
  });
});

describe("getCommunities", () => {
  it("returns community nodes for an agent", async () => {
    const session = createMockSession();
    session.run.mockResolvedValue({
      records: [
        mockRecord({
          id: "comm-1",
          name: "Community Alpha",
          summary: "First cluster",
          entityCount: 5,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-02T00:00:00Z",
        }),
        mockRecord({
          id: "comm-2",
          name: "Community Beta",
          summary: "Second cluster",
          entityCount: 3,
          createdAt: "2026-01-03T00:00:00Z",
          updatedAt: "2026-01-04T00:00:00Z",
        }),
      ],
    });

    const communities = await getCommunities(session as any, "agent-1");

    expect(communities).toHaveLength(2);
    expect(communities[0]).toEqual({
      id: "comm-1",
      name: "Community Alpha",
      summary: "First cluster",
      entityCount: 5,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
    });
    expect(communities[1].id).toBe("comm-2");
  });
});

// ============================================================================
// Community Search Signal
// ============================================================================

describe("communitySearch", () => {
  let session: ReturnType<typeof createMockSession>;

  beforeEach(() => {
    session = createMockSession();
  });

  it("returns memories linked through communities", async () => {
    session.run.mockResolvedValue({
      records: [
        mockRecord({
          id: "mem-1",
          text: "Memory about project X",
          category: "fact",
          importance: 0.8,
          createdAt: "2026-01-01T00:00:00Z",
          validFrom: null,
          trustScore: 0.95,
          score: 2.5,
        }),
        mockRecord({
          id: "mem-2",
          text: "Related to project X",
          category: "observation",
          importance: 0.6,
          createdAt: "2026-01-02T00:00:00Z",
          validFrom: "2026-01-02T00:00:00Z",
          trustScore: 1.0,
          score: 1.8,
        }),
      ],
    });

    const results = await communitySearch(session as any, "project X", 10, "agent-1");

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      id: "mem-1",
      text: "Memory about project X",
      category: "fact",
      importance: 0.8,
      createdAt: "2026-01-01T00:00:00Z",
      validFrom: undefined,
      score: 2.5,
      trustScore: 0.95,
    });
    expect(results[1].id).toBe("mem-2");
    expect(results[1].validFrom).toBe("2026-01-02T00:00:00Z");
  });

  it("returns empty for empty query", async () => {
    const results = await communitySearch(session as any, "", 10, "agent-1");
    expect(results).toEqual([]);
  });

  it("returns empty for whitespace-only query", async () => {
    const results = await communitySearch(session as any, "   ", 10, "agent-1");
    expect(results).toEqual([]);
  });
});

// ============================================================================
// RRF Fusion Integration
// ============================================================================

describe("RRF fusion with community signal", () => {
  it("community signal contributes to fused score", () => {
    const communityResult = makeSignalResult("community-mem", 0.85, 1.0);

    // 5 signals: [vector, bm25, graph, causal, community]
    const fused = fuseWithConfidenceRRF([[], [], [], [], [communityResult]], 60, [1, 1, 1, 1, 1]);

    expect(fused).toHaveLength(1);
    expect(fused[0].id).toBe("community-mem");
    expect(fused[0].rrfScore).toBeGreaterThan(0);
  });

  it("community signal boosts memory already found by other signals", () => {
    // Same memory found by vector (signal 0) and community (signal 4)
    const vectorResult = makeSignalResult("shared-mem", 0.9, 1.0);
    const communityResult = makeSignalResult("shared-mem", 0.8, 1.0);

    // Only vector
    const vectorOnly = fuseWithConfidenceRRF([[vectorResult], [], [], [], []], 60, [1, 1, 1, 1, 1]);

    // Vector + community
    const combined = fuseWithConfidenceRRF(
      [[vectorResult], [], [], [], [communityResult]],
      60,
      [1, 1, 1, 1, 1],
    );

    expect(combined[0].rrfScore).toBeGreaterThan(vectorOnly[0].rrfScore);
  });
});
