/**
 * Tests for entity deduplication in neo4j-client.ts.
 *
 * Tests findDuplicateEntityPairs() and mergeEntityPair() using mocked Neo4j driver.
 * Verifies substring-matching logic, relationship-count based decisions, and merge behavior.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Neo4jMemoryClient } from "./neo4j-client.js";

// ============================================================================
// Test Helpers
// ============================================================================

function createMockSession() {
  const session = {
    run: vi.fn().mockResolvedValue({ records: [] }),
    close: vi.fn().mockResolvedValue(undefined),
    executeWrite: vi.fn(
      async (work: (tx: { run: ReturnType<typeof vi.fn> }) => Promise<unknown>) => {
        return work({ run: session.run });
      },
    ),
    executeRead: null as unknown as ReturnType<typeof vi.fn>,
  };
  session.executeRead = vi.fn().mockImplementation((fn) => fn({ run: session.run }));
  return session;
}

function createMockDriver() {
  return {
    session: vi.fn().mockReturnValue(createMockSession()),
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

function mockRecord(data: Record<string, unknown>) {
  return {
    get: (key: string) => data[key],
  };
}

// ============================================================================
// Entity Deduplication Tests
// ============================================================================

describe("Entity Deduplication", () => {
  let client: Neo4jMemoryClient;
  let mockDriver: ReturnType<typeof createMockDriver>;
  let mockSession: ReturnType<typeof createMockSession>;
  let mockLogger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    mockLogger = createMockLogger();
    mockDriver = createMockDriver();
    mockSession = createMockSession();
    mockDriver.session.mockReturnValue(mockSession);

    client = new Neo4jMemoryClient("bolt://localhost:7687", "neo4j", "password", 1024, mockLogger);
    (client as any).driver = mockDriver;
    (client as any).indexesReady = true;
  });

  // --------------------------------------------------------------------------
  // findDuplicateEntityPairs()
  // --------------------------------------------------------------------------

  describe("findDuplicateEntityPairs", () => {
    it("finds substring matches: 'tarun' + 'tarun sukhani' (same type)", async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [
          mockRecord({
            id1: "e1",
            name1: "tarun",
            rc1: 5,
            id2: "e2",
            name2: "tarun sukhani",
            rc2: 3,
          }),
        ],
      });

      const pairs = await client.findDuplicateEntityPairs();

      expect(pairs).toHaveLength(1);
      // "tarun" has more relationships (5 > 3), so it should be kept
      expect(pairs[0].keepId).toBe("e1");
      expect(pairs[0].keepName).toBe("tarun");
      expect(pairs[0].removeId).toBe("e2");
      expect(pairs[0].removeName).toBe("tarun sukhani");
    });

    it("keeps entity with more relationships regardless of name length", async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [
          mockRecord({
            id1: "e1",
            name1: "fish speech",
            rc1: 2,
            id2: "e2",
            name2: "fish speech s1 mini",
            rc2: 10,
          }),
        ],
      });

      const pairs = await client.findDuplicateEntityPairs();

      expect(pairs).toHaveLength(1);
      // "fish speech s1 mini" has more relationships (10 > 2), so it should be kept
      expect(pairs[0].keepId).toBe("e2");
      expect(pairs[0].keepName).toBe("fish speech s1 mini");
      expect(pairs[0].removeId).toBe("e1");
      expect(pairs[0].removeName).toBe("fish speech");
    });

    it("keeps shorter name when relationship counts are equal", async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [
          mockRecord({
            id1: "e1",
            name1: "aaditya",
            rc1: 5,
            id2: "e2",
            name2: "aaditya sukhani",
            rc2: 5,
          }),
        ],
      });

      const pairs = await client.findDuplicateEntityPairs();

      expect(pairs).toHaveLength(1);
      // Equal relationship counts, so keep the shorter name ("aaditya")
      expect(pairs[0].keepId).toBe("e1");
      expect(pairs[0].keepName).toBe("aaditya");
      expect(pairs[0].removeId).toBe("e2");
      expect(pairs[0].removeName).toBe("aaditya sukhani");
    });

    it("returns empty array when no duplicates exist", async () => {
      mockSession.run.mockResolvedValueOnce({ records: [] });

      const pairs = await client.findDuplicateEntityPairs();

      expect(pairs).toHaveLength(0);
    });

    it("handles multiple duplicate pairs", async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [
          mockRecord({
            id1: "e1",
            name1: "tarun",
            rc1: 5,
            id2: "e2",
            name2: "tarun sukhani",
            rc2: 3,
          }),
          mockRecord({
            id1: "e3",
            name1: "fish speech",
            rc1: 2,
            id2: "e4",
            name2: "fish speech s1 mini",
            rc2: 8,
          }),
        ],
      });

      const pairs = await client.findDuplicateEntityPairs();

      expect(pairs).toHaveLength(2);
    });

    it("handles NULL relationship counts (treats as 0)", async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [
          mockRecord({
            id1: "e1",
            name1: "neo4j",
            rc1: null,
            id2: "e2",
            name2: "neo4j database",
            rc2: null,
          }),
        ],
      });

      const pairs = await client.findDuplicateEntityPairs();

      expect(pairs).toHaveLength(1);
      // Both NULL (treated as 0), so keep the shorter name
      expect(pairs[0].keepId).toBe("e1");
      expect(pairs[0].keepName).toBe("neo4j");
    });

    it("passes the Cypher query with substring matching and type constraint", async () => {
      mockSession.run.mockResolvedValueOnce({ records: [] });

      await client.findDuplicateEntityPairs();

      const query = mockSession.run.mock.calls[0][0] as string;
      // Verify the query checks same type
      expect(query).toContain("e1.type = e2.type");
      // Verify the query checks CONTAINS in both directions
      expect(query).toContain("e1.name CONTAINS e2.name");
      expect(query).toContain("e2.name CONTAINS e1.name");
      // Verify minimum name length filter
      expect(query).toContain("size(e1.name) > 2");
    });

    it("uses fulltext index pre-filter instead of Cartesian product", async () => {
      mockSession.run.mockResolvedValueOnce({ records: [] });

      await client.findDuplicateEntityPairs();

      const query = mockSession.run.mock.calls[0][0] as string;
      // Verify the query uses the fulltext index (not a bare MATCH (e1), (e2) Cartesian)
      expect(query).toContain("db.index.fulltext.queryNodes");
      expect(query).toContain("entity_fulltext_index");
      // Verify self-pairs are excluded
      expect(query).toContain("e2.id <> e1.id");
    });
  });

  // --------------------------------------------------------------------------
  // mergeEntityPair()
  // --------------------------------------------------------------------------

  describe("mergeEntityPair", () => {
    it("transfers relationships and deletes source entity (H7)", async () => {
      // H7: mergeEntityPair discovers rel types, re-points them to the keep entity,
      // updates relationshipCount, then DETACH DELETEs the removed entity.
      const mockTx = {
        run: vi.fn().mockImplementation((query: string) => {
          // Discover relationship types
          if (query.includes("DISTINCT type(r)")) {
            return { records: [] }; // no relationships to transfer
          }
          return { records: [] };
        }),
      };

      mockSession.executeWrite.mockImplementationOnce(async (work: any) => work(mockTx));

      const result = await client.mergeEntityPair("keep-id", "remove-id");

      expect(result).toBe(true);

      const queries = mockTx.run.mock.calls.map((call) => call[0] as string);
      // Should discover rel types
      expect(queries.some((q) => q.includes("DISTINCT type(r)"))).toBe(true);
      // Should update relationshipCount on the kept entity
      expect(queries.some((q) => q.includes("relationshipCount"))).toBe(true);
      // Should DETACH DELETE the removed entity
      expect(queries.some((q) => q.includes("DETACH DELETE e"))).toBe(true);
    });

    it("returns false on error", async () => {
      mockSession.executeWrite.mockRejectedValueOnce(new Error("Neo4j connection lost"));

      const result = await client.mergeEntityPair("keep-id", "remove-id");

      expect(result).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // batchMergeEntityPairs() — OP-106
  // --------------------------------------------------------------------------

  describe("batchMergeEntityPairs", () => {
    it("returns 0 for empty pairs array without touching the DB", async () => {
      const result = await client.batchMergeEntityPairs([]);
      expect(result).toBe(0);
      expect(mockSession.executeWrite).not.toHaveBeenCalled();
    });

    it("re-points entity-entity relationships and updates relationshipCount", async () => {
      // OP-142: No MENTIONS transfer. batchMergeEntityPairs discovers entity-entity
      // rel types, re-points them per type, updates relationshipCount, then deletes.
      const mockTx = {
        run: vi.fn().mockImplementation((query: string) => {
          // Return no discovered relationship types (simplest happy path)
          if (query.includes("DISTINCT type(r)")) {
            return { records: [] };
          }
          return { records: [] };
        }),
      };
      mockSession.executeWrite.mockImplementationOnce(async (work: any) => work(mockTx));

      const pairs = [
        { keepId: "keep-1", removeId: "remove-1" },
        { keepId: "keep-2", removeId: "remove-2" },
      ];
      const result = await client.batchMergeEntityPairs(pairs);

      expect(result).toBe(2);

      const queries = mockTx.run.mock.calls.map((call) => call[0] as string);

      // Should discover rel types
      expect(queries.some((q) => q.includes("DISTINCT type(r)"))).toBe(true);

      // Should update relationshipCount
      expect(queries.some((q) => q.includes("relationshipCount"))).toBe(true);

      // Should delete removed entities
      expect(queries.some((q) => q.includes("DETACH DELETE e"))).toBe(true);
    });

    it("discovers and re-points inter-entity relationships dynamically via UNWIND", async () => {
      const mockTx = {
        run: vi.fn().mockImplementation((query: string) => {
          // Return discovered relationship types when queried
          if (query.includes("DISTINCT type(r)")) {
            return {
              records: [{ get: () => "WORKS_AT" }, { get: () => "KNOWS" }],
            };
          }
          return { records: [] };
        }),
      };
      mockSession.executeWrite.mockImplementationOnce(async (work: any) => work(mockTx));

      await client.batchMergeEntityPairs([{ keepId: "keep-1", removeId: "remove-1" }]);

      // Collect all query strings
      const queries = mockTx.run.mock.calls.map((call) => call[0] as string);

      // Should have queried for relationship types
      expect(queries.some((q) => q.includes("DISTINCT type(r)"))).toBe(true);

      // Re-point queries should use UNWIND
      const relTypeQueries = queries.filter((q) => q.includes("WORKS_AT") || q.includes("KNOWS"));
      for (const q of relTypeQueries) {
        expect(q).toContain("UNWIND $pairs AS pair");
      }
    });

    it("deletes all removed entities with a single UNWIND query", async () => {
      const mockTx = { run: vi.fn().mockResolvedValue({ records: [] }) };
      mockSession.executeWrite.mockImplementationOnce(async (work: any) => work(mockTx));

      await client.batchMergeEntityPairs([
        { keepId: "keep-1", removeId: "remove-1" },
        { keepId: "keep-2", removeId: "remove-2" },
      ]);

      const queries = mockTx.run.mock.calls.map((call) => call[0] as string);
      const deleteQuery = queries.find((q) => q.includes("DETACH DELETE e"));
      expect(deleteQuery).toBeDefined();
      expect(deleteQuery).toContain("UNWIND $pairs AS pair");
    });

    it("returns 0 on error", async () => {
      mockSession.executeWrite.mockRejectedValueOnce(new Error("Neo4j connection lost"));

      const result = await client.batchMergeEntityPairs([
        { keepId: "keep-1", removeId: "remove-1" },
      ]);

      expect(result).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // reconcileEntityRelationshipCounts()
  // --------------------------------------------------------------------------

  describe("reconcileEntityRelationshipCounts", () => {
    it("updates entities with stale or NULL relationshipCount", async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [mockRecord({ updated: 42 })],
      });

      const updated = await client.reconcileEntityRelationshipCounts();

      expect(updated).toBe(42);
      const query = mockSession.run.mock.calls[0][0] as string;
      expect(query).toContain("relationshipCount IS NULL");
      expect(query).toContain("SET e.relationshipCount = actual");
    });

    it("returns 0 when all entities have correct relationshipCount", async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [mockRecord({ updated: 0 })],
      });

      const updated = await client.reconcileEntityRelationshipCounts();

      expect(updated).toBe(0);
    });
  });
});
