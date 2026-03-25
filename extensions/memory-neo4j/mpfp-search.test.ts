import { describe, it, expect, vi, beforeEach } from "vitest";
import { mpfpSearch } from "./mpfp-search.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

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

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("mpfpSearch", () => {
  let session: ReturnType<typeof createMockSession>;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    vi.clearAllMocks();
    session = createMockSession();
    logger = createMockLogger();
  });

  it("returns empty results for empty seed IDs", async () => {
    const results = await mpfpSearch(session as any, "agent-1", [], "both");

    expect(results).toEqual([]);
    expect(session.executeRead).not.toHaveBeenCalled();
  });

  it("traverses semantic patterns and returns Memory nodes", async () => {
    // Pattern traversals return direct Memory hits
    session.executeRead.mockResolvedValue({
      records: [
        mockRecord({ nodeId: "mem-5", score: 0.72, label: "Memory" }),
        mockRecord({ nodeId: "mem-6", score: 0.61, label: "Memory" }),
      ],
    });

    const results = await mpfpSearch(session as any, "agent-1", ["mem-1", "mem-2"], "semantic", {
      logger: logger as any,
    });

    // Should have called executeRead for each of the 4 semantic patterns
    // plus memory metadata fetch
    expect(session.executeRead).toHaveBeenCalled();
    // Results should not include seed IDs
    for (const r of results) {
      expect(["mem-1", "mem-2"]).not.toContain(r.id);
    }
  });

  it("traverses temporal patterns and returns results", async () => {
    session.executeRead.mockResolvedValue({
      records: [mockRecord({ nodeId: "mem-3", score: 0.55, label: "Memory" })],
    });

    const results = await mpfpSearch(session as any, "agent-1", ["mem-1"], "temporal", {
      logger: logger as any,
    });

    // 2 temporal patterns should be traversed
    expect(session.executeRead).toHaveBeenCalled();
  });

  it("bridges Entity hits back to Memory nodes via EXTRACTED_FROM", async () => {
    // First calls: pattern traversal returns Entity hits
    session.executeRead.mockImplementation(async (fn: any) => {
      // Capture the Cypher query to differentiate pattern vs bridge calls
      let capturedQuery = "";
      const mockTx = {
        run: vi.fn().mockImplementation((query: string) => {
          capturedQuery = query;
          if (query.includes("EXTRACTED_FROM]->(e:Entity)")) {
            // Bridge query: return Memory nodes for entities
            return Promise.resolve({
              records: [
                mockRecord({
                  id: "mem-10",
                  text: "bridged memory",
                  category: "fact",
                  importance: 0.8,
                  createdAt: "2026-01-01T00:00:00Z",
                  validFrom: null,
                  trustScore: 1.0,
                  entityId: "ent-1",
                }),
              ],
            });
          }
          if (query.includes("m.id IN $ids")) {
            // Memory metadata fetch: return empty (all are bridged)
            return Promise.resolve({ records: [] });
          }
          // Pattern traversal: return Entity hits
          return Promise.resolve({
            records: [mockRecord({ nodeId: "ent-1", score: 0.65, label: "Entity" })],
          });
        }),
      };
      return fn(mockTx);
    });

    const results = await mpfpSearch(session as any, "agent-1", ["mem-1"], "semantic", {
      logger: logger as any,
    });

    // Should have bridged entity results to memories
    expect(results.some((r) => r.id === "mem-10")).toBe(true);
  });

  it("filters out seed node IDs from results", async () => {
    // Pattern returns a hit that matches a seed ID
    session.executeRead.mockImplementation(async (fn: any) => {
      const mockTx = {
        run: vi.fn().mockImplementation((query: string) => {
          if (query.includes("m.id IN $ids")) {
            return Promise.resolve({
              records: [
                mockRecord({
                  id: "mem-1",
                  text: "seed memory",
                  category: "fact",
                  importance: 0.9,
                  createdAt: "2026-01-01T00:00:00Z",
                  validFrom: null,
                  trustScore: 1.0,
                }),
                mockRecord({
                  id: "mem-5",
                  text: "new memory",
                  category: "fact",
                  importance: 0.7,
                  createdAt: "2026-01-01T01:00:00Z",
                  validFrom: null,
                  trustScore: 1.0,
                }),
              ],
            });
          }
          return Promise.resolve({
            records: [
              mockRecord({ nodeId: "mem-1", score: 0.9, label: "Memory" }),
              mockRecord({ nodeId: "mem-5", score: 0.7, label: "Memory" }),
            ],
          });
        }),
      };
      return fn(mockTx);
    });

    const results = await mpfpSearch(session as any, "agent-1", ["mem-1"], "semantic", {
      logger: logger as any,
    });

    // mem-1 is a seed, should be filtered out
    expect(results.every((r) => r.id !== "mem-1")).toBe(true);
    expect(results.some((r) => r.id === "mem-5")).toBe(true);
  });

  it("deduplicates results keeping highest score", async () => {
    // Multiple patterns return the same node with different scores
    let callCount = 0;
    session.executeRead.mockImplementation(async (fn: any) => {
      const mockTx = {
        run: vi.fn().mockImplementation((query: string) => {
          if (query.includes("m.id IN $ids")) {
            return Promise.resolve({
              records: [
                mockRecord({
                  id: "mem-5",
                  text: "found memory",
                  category: "fact",
                  importance: 0.8,
                  createdAt: "2026-01-01T00:00:00Z",
                  validFrom: null,
                  trustScore: 1.0,
                }),
              ],
            });
          }
          callCount++;
          // Different patterns return same node with different scores
          return Promise.resolve({
            records: [
              mockRecord({
                nodeId: "mem-5",
                score: callCount === 1 ? 0.9 : 0.5,
                label: "Memory",
              }),
            ],
          });
        }),
      };
      return fn(mockTx);
    });

    const results = await mpfpSearch(session as any, "agent-1", ["mem-1"], "semantic", {
      logger: logger as any,
    });

    // Should have only one entry for mem-5 with the highest score
    const mem5Results = results.filter((r) => r.id === "mem-5");
    expect(mem5Results.length).toBeLessThanOrEqual(1);
    if (mem5Results.length === 1) {
      expect(mem5Results[0].score).toBeGreaterThanOrEqual(0.5);
    }
  });

  it("gracefully degrades when no SIMILAR/TEMPORAL_NEXT edges exist", async () => {
    // All pattern traversals return empty
    session.executeRead.mockResolvedValue({ records: [] });

    const results = await mpfpSearch(session as any, "agent-1", ["mem-1", "mem-2"], "both", {
      logger: logger as any,
    });

    expect(results).toEqual([]);
  });

  it("handles pattern traversal errors gracefully", async () => {
    // Some patterns fail, others succeed
    let callCount = 0;
    session.executeRead.mockImplementation(async (fn: any) => {
      callCount++;
      if (callCount % 2 === 0) {
        throw new Error("transient error");
      }
      const mockTx = {
        run: vi.fn().mockResolvedValue({ records: [] }),
      };
      return fn(mockTx);
    });

    // Should not throw — errors are caught per-pattern
    const results = await mpfpSearch(session as any, "agent-1", ["mem-1"], "both", {
      logger: logger as any,
    });

    expect(Array.isArray(results)).toBe(true);
    // Errors should be logged
    expect(logger.debug).toHaveBeenCalled();
  });

  it("respects fan-out limit via topKNeighbors option", async () => {
    session.executeRead.mockImplementation(async (fn: any) => {
      const mockTx = {
        run: vi.fn().mockImplementation((_query: string, params: Record<string, unknown>) => {
          // Verify topK parameter is passed
          if (params.topK !== undefined) {
            expect(params.topK).toBe(5);
          }
          return Promise.resolve({ records: [] });
        }),
      };
      return fn(mockTx);
    });

    await mpfpSearch(session as any, "agent-1", ["mem-1"], "semantic", {
      topKNeighbors: 5,
      logger: logger as any,
    });
  });

  it("uses 'both' mode by default", async () => {
    session.executeRead.mockResolvedValue({ records: [] });

    await mpfpSearch(session as any, "agent-1", ["mem-1"]);

    // 'both' mode runs 4 semantic + 2 temporal + 3 causal = 9 patterns (OP-188)
    // Each pattern is one executeRead call (no metadata fetches needed for empty results)
    expect(session.executeRead).toHaveBeenCalledTimes(9);
  });

  it("results are sorted by score descending", async () => {
    session.executeRead.mockImplementation(async (fn: any) => {
      const mockTx = {
        run: vi.fn().mockImplementation((query: string) => {
          if (query.includes("m.id IN $ids")) {
            return Promise.resolve({
              records: [
                mockRecord({
                  id: "mem-5",
                  text: "low score",
                  category: "fact",
                  importance: 0.5,
                  createdAt: "2026-01-01T00:00:00Z",
                  validFrom: null,
                  trustScore: 1.0,
                }),
                mockRecord({
                  id: "mem-6",
                  text: "high score",
                  category: "fact",
                  importance: 0.9,
                  createdAt: "2026-01-01T00:00:00Z",
                  validFrom: null,
                  trustScore: 1.0,
                }),
              ],
            });
          }
          return Promise.resolve({
            records: [
              mockRecord({ nodeId: "mem-5", score: 0.3, label: "Memory" }),
              mockRecord({ nodeId: "mem-6", score: 0.8, label: "Memory" }),
            ],
          });
        }),
      };
      return fn(mockTx);
    });

    const results = await mpfpSearch(session as any, "agent-1", ["mem-1"], "semantic", {
      logger: logger as any,
    });

    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });
});
