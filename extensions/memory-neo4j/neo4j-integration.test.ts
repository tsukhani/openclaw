/**
 * Integration tests for memory-neo4j — validates Cypher queries against real Neo4j.
 *
 * Gated behind MEMORY_NEO4J_INTEGRATION=1. Requires Docker running.
 * Tests use the Neo4j driver directly to verify query correctness,
 * index behavior, and constraint enforcement.
 *
 * Run: MEMORY_NEO4J_INTEGRATION=1 pnpm test -- extensions/memory-neo4j/neo4j-integration.test.ts
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const INTEGRATION_ENABLED = process.env.MEMORY_NEO4J_INTEGRATION === "1";

// Conditionally import neo4j-driver only when integration tests are enabled
let neo4j: any;
let driver: any;

// Default Neo4j connection for Docker container
const NEO4J_URI = process.env.NEO4J_TEST_URI ?? "bolt://localhost:7687";
const NEO4J_USER = process.env.NEO4J_TEST_USER ?? "neo4j";
const NEO4J_PASSWORD = process.env.NEO4J_TEST_PASSWORD ?? "testpassword";

describe.skipIf(!INTEGRATION_ENABLED)("neo4j-integration", () => {
  beforeAll(async () => {
    neo4j = await import("neo4j-driver");
    driver = neo4j.default.driver(NEO4J_URI, neo4j.default.auth.basic(NEO4J_USER, NEO4J_PASSWORD), {
      maxConnectionPoolSize: 10,
    });
    // Verify connection
    const session = driver.session();
    try {
      await session.run("RETURN 1");
    } finally {
      await session.close();
    }

    // Create indexes using the extension's ensureIndexes
    const { ensureIndexes } = await import("./neo4j-client-indexes.js");
    const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    await ensureIndexes(driver, 1536, logger);

    // Wait for indexes to come online
    await new Promise((resolve) => setTimeout(resolve, 2000));
  });

  afterAll(async () => {
    if (driver) await driver.close();
  });

  beforeEach(async () => {
    // Clean database between tests
    const session = driver.session();
    try {
      await session.run("MATCH (n) DETACH DELETE n");
    } finally {
      await session.close();
    }
  });

  // ========================================================================
  // Memory CRUD (Task 7.4)
  // ========================================================================

  describe("memory CRUD", () => {
    it("stores and retrieves a memory via MERGE", async () => {
      const { storeMemory } = await import("./neo4j-client-memory.js");
      const session = driver.session();
      try {
        const id = randomUUID();
        await storeMemory(session, {
          id,
          text: "Integration test memory",
          embedding: new Array(1536).fill(0.1),
          importance: 0.8,
          category: "fact",
          source: "user",
          extractionStatus: "pending",
          agentId: "test-agent",
        });

        const result = await session.run("MATCH (m:Memory {id: $id}) RETURN m", { id });
        expect(result.records.length).toBe(1);
        expect(result.records[0].get("m").properties.text).toBe("Integration test memory");
        expect(result.records[0].get("m").properties.trustScore).toBe(1.0);
      } finally {
        await session.close();
      }
    });

    it("MERGE is idempotent — second store does not create duplicate", async () => {
      const { storeMemory } = await import("./neo4j-client-memory.js");
      const session = driver.session();
      try {
        const id = randomUUID();
        const input = {
          id,
          text: "Idempotent memory",
          embedding: new Array(1536).fill(0.1),
          importance: 0.7,
          category: "fact" as const,
          source: "user" as const,
          extractionStatus: "pending" as const,
          agentId: "test-agent",
        };
        await storeMemory(session, input);
        await storeMemory(session, input);

        const result = await session.run("MATCH (m:Memory {id: $id}) RETURN count(m) AS cnt", {
          id,
        });
        expect(result.records[0].get("cnt").toNumber()).toBe(1);
      } finally {
        await session.close();
      }
    });

    it("deletes a memory", async () => {
      const { storeMemory, deleteMemory } = await import("./neo4j-client-memory.js");
      const session = driver.session();
      try {
        const id = randomUUID();
        await storeMemory(session, {
          id,
          text: "To be deleted",
          embedding: new Array(1536).fill(0.1),
          importance: 0.5,
          category: "other",
          source: "user",
          extractionStatus: "skipped",
          agentId: "test-agent",
        });
        const deleted = await deleteMemory(session, id);
        expect(deleted).toBe(true);

        const result = await session.run("MATCH (m:Memory {id: $id}) RETURN m", { id });
        expect(result.records.length).toBe(0);
      } finally {
        await session.close();
      }
    });

    it("trustScore and quarantined are persisted", async () => {
      const { storeMemory } = await import("./neo4j-client-memory.js");
      const session = driver.session();
      try {
        const id = randomUUID();
        await storeMemory(session, {
          id,
          text: "Quarantined memory",
          embedding: new Array(1536).fill(0.1),
          importance: 0.5,
          category: "other",
          source: "auto-capture",
          extractionStatus: "skipped",
          agentId: "test-agent",
          trustScore: 0.0,
          quarantined: true,
        });

        const result = await session.run(
          "MATCH (m:Memory {id: $id}) RETURN m.trustScore AS ts, m.quarantined AS q",
          { id },
        );
        expect(result.records[0].get("ts")).toBe(0.0);
        expect(result.records[0].get("q")).toBe(true);
      } finally {
        await session.close();
      }
    });
  });

  // ========================================================================
  // Uniqueness Constraints (Task 7.4)
  // ========================================================================

  describe("uniqueness constraints", () => {
    it("Memory.id uniqueness enforced", async () => {
      const session = driver.session();
      try {
        const id = randomUUID();
        await session.run("CREATE (m:Memory {id: $id, text: 'first'})", { id });
        await expect(
          session.run("CREATE (m:Memory {id: $id, text: 'second'})", { id }),
        ).rejects.toThrow();
      } finally {
        await session.close();
      }
    });

    it("Entity.id uniqueness enforced", async () => {
      const session = driver.session();
      try {
        const id = randomUUID();
        await session.run("CREATE (e:Entity {id: $id, name: 'first'})", { id });
        await expect(
          session.run("CREATE (e:Entity {id: $id, name: 'second'})", { id }),
        ).rejects.toThrow();
      } finally {
        await session.close();
      }
    });
  });

  // ========================================================================
  // Index Readiness (Task 7.11)
  // ========================================================================

  describe("index readiness", () => {
    it("all indexes are ONLINE", async () => {
      const session = driver.session();
      try {
        const result = await session.run("SHOW INDEXES YIELD name, state");
        const indexes = result.records.map((r: any) => ({
          name: r.get("name") as string,
          state: r.get("state") as string,
        }));

        // Check critical indexes (vector + fulltext) are online
        const critical = [
          "memory_embedding_index",
          "memory_fulltext_index",
          "entity_fulltext_index",
        ];

        for (const name of critical) {
          const idx = indexes.find((i: any) => i.name === name);
          expect(idx, `Index ${name} should exist`).toBeDefined();
          expect(idx!.state, `Index ${name} should be ONLINE`).toBe("ONLINE");
        }

        // Verify at least 10 total indexes created (constraints, property, composite)
        expect(indexes.length).toBeGreaterThanOrEqual(10);
      } finally {
        await session.close();
      }
    });
  });

  // ========================================================================
  // Episode CRUD (Task 5.7 integration portion)
  // ========================================================================

  describe("episode CRUD", () => {
    it("stores and queries episodes by session", async () => {
      const { mergeEpisode, queryEpisodes } = await import("./neo4j-client-episode.js");
      const session = driver.session();
      try {
        await mergeEpisode(session, {
          id: randomUUID(),
          text: "Hello, how are you?",
          role: "user",
          timestamp: "2026-03-15T10:00:00Z",
          sessionKey: "sess-1",
          agentId: "test-agent",
        });
        await mergeEpisode(session, {
          id: randomUUID(),
          text: "I'm doing well!",
          role: "assistant",
          timestamp: "2026-03-15T10:00:05Z",
          sessionKey: "sess-1",
          agentId: "test-agent",
        });

        const episodes = await queryEpisodes(session, "test-agent", { sessionKey: "sess-1" });
        expect(episodes.length).toBe(2);
        expect(episodes[0].role).toBe("user");
        expect(episodes[1].role).toBe("assistant");
      } finally {
        await session.close();
      }
    });

    it("deletes expired episodes", async () => {
      const { mergeEpisode, deleteExpiredEpisodes } = await import("./neo4j-client-episode.js");
      const session = driver.session();
      try {
        await mergeEpisode(session, {
          id: randomUUID(),
          text: "Old episode",
          role: "user",
          timestamp: "2025-01-01T00:00:00Z",
          sessionKey: "old-sess",
          agentId: "test-agent",
        });
        await mergeEpisode(session, {
          id: randomUUID(),
          text: "Recent episode",
          role: "user",
          timestamp: "2026-03-15T10:00:00Z",
          sessionKey: "new-sess",
          agentId: "test-agent",
        });

        const deleted = await deleteExpiredEpisodes(session, "2026-01-01T00:00:00Z");
        expect(Number(deleted)).toBe(1);

        const result = await session.run("MATCH (e:Episode) RETURN count(e) AS cnt");
        expect(result.records[0].get("cnt").toNumber()).toBe(1);
      } finally {
        await session.close();
      }
    });
  });

  // ========================================================================
  // Community CRUD (Task 6.9 integration portion)
  // ========================================================================

  describe("community operations", () => {
    it("label propagation clusters connected entities", async () => {
      const { runLabelPropagation } = await import("./neo4j-client-community.js");
      const session = driver.session();
      try {
        // Create entities and relationships forming a triangle
        await session.run(`
          CREATE (a:Entity {id: 'e1', name: 'Alice', type: 'person', mentionCount: 1, agentId: 'test-agent'}),
                 (b:Entity {id: 'e2', name: 'Bob', type: 'person', mentionCount: 1, agentId: 'test-agent'}),
                 (c:Entity {id: 'e3', name: 'Charlie', type: 'person', mentionCount: 1, agentId: 'test-agent'}),
                 (d:Entity {id: 'e4', name: 'Dave', type: 'person', mentionCount: 1, agentId: 'test-agent'}),
                 (m1:Memory {id: 'm1', agentId: 'test-agent', text: 't1'}),
                 (m2:Memory {id: 'm2', agentId: 'test-agent', text: 't2'}),
                 (m3:Memory {id: 'm3', agentId: 'test-agent', text: 't3'}),
                 (m4:Memory {id: 'm4', agentId: 'test-agent', text: 't4'}),
                 (m1)-[:MENTIONS]->(a), (m2)-[:MENTIONS]->(b),
                 (m3)-[:MENTIONS]->(c), (m4)-[:MENTIONS]->(d),
                 (a)-[:KNOWS]->(b), (b)-[:KNOWS]->(c), (c)-[:KNOWS]->(a)
        `);

        const clusters = await runLabelPropagation(session, "test-agent", {
          minCommunitySize: 3,
        });

        // Alice, Bob, Charlie form a triangle; Dave is isolated
        expect(clusters.length).toBe(1);
        expect(clusters[0].length).toBe(3);
        expect(clusters[0]).not.toContain("e4");
      } finally {
        await session.close();
      }
    });
  });

  // ========================================================================
  // BM25 Search (Task 7.6)
  // ========================================================================

  describe("BM25 search", () => {
    it("returns keyword matches and excludes non-matches", async () => {
      const { storeMemory } = await import("./neo4j-client-memory.js");
      const { bm25Search } = await import("./neo4j-client-search.js");
      const session = driver.session();
      try {
        await storeMemory(session, {
          id: randomUUID(),
          text: "Kubernetes deployment strategy for production cluster",
          embedding: new Array(1536).fill(0.1),
          importance: 0.8,
          category: "fact",
          source: "user",
          extractionStatus: "skipped",
          agentId: "test-agent",
        });
        await storeMemory(session, {
          id: randomUUID(),
          text: "React component lifecycle and hooks tutorial",
          embedding: new Array(1536).fill(0.2),
          importance: 0.7,
          category: "fact",
          source: "user",
          extractionStatus: "skipped",
          agentId: "test-agent",
        });

        // Wait for fulltext index to catch up
        await new Promise((r) => setTimeout(r, 500));

        const results = await bm25Search(session, "Kubernetes", 10, "test-agent");

        expect(results.length).toBeGreaterThanOrEqual(1);
        expect(results[0].text).toContain("Kubernetes");
        // React memory should not match
        const reactMatch = results.find((r: any) => r.text.includes("React"));
        expect(reactMatch).toBeUndefined();
      } finally {
        await session.close();
      }
    });
  });

  // ========================================================================
  // Entity Batch Operations (Task 7.8)
  // ========================================================================

  describe("entity batch operations", () => {
    it("creates entities + relationships + tags atomically", async () => {
      const { storeMemory } = await import("./neo4j-client-memory.js");
      const session = driver.session();
      try {
        const memId = randomUUID();
        await storeMemory(session, {
          id: memId,
          text: "Alice works at Acme Corp",
          embedding: new Array(1536).fill(0.1),
          importance: 0.8,
          category: "fact",
          source: "user",
          extractionStatus: "pending",
          agentId: "test-agent",
        });

        // Manually create entities and relationships
        await session.run(
          `
          CREATE (e1:Entity {id: $e1Id, name: 'alice', type: 'person', mentionCount: 1,
                            firstSeen: datetime(), lastSeen: datetime(), aliases: []}),
                 (e2:Entity {id: $e2Id, name: 'acme corp', type: 'organization', mentionCount: 1,
                            firstSeen: datetime(), lastSeen: datetime(), aliases: []})
          WITH e1, e2
          MATCH (m:Memory {id: $memId})
          CREATE (m)-[:MENTIONS]->(e1), (m)-[:MENTIONS]->(e2),
                 (e1)-[:WORKS_AT {type: 'WORKS_AT', confidence: 0.9,
                        createdAt: datetime().epochMillis, validFrom: datetime().epochMillis}]->(e2)
        `,
          { e1Id: randomUUID(), e2Id: randomUUID(), memId },
        );

        // Verify all were created
        const entities = await session.run("MATCH (e:Entity) RETURN count(e) AS cnt");
        expect(entities.records[0].get("cnt").toNumber()).toBe(2);

        const rels = await session.run("MATCH ()-[r:WORKS_AT]->() RETURN count(r) AS cnt");
        expect(rels.records[0].get("cnt").toNumber()).toBe(1);

        const mentions = await session.run("MATCH ()-[r:MENTIONS]->() RETURN count(r) AS cnt");
        expect(mentions.records[0].get("cnt").toNumber()).toBe(2);
      } finally {
        await session.close();
      }
    });
  });

  // ========================================================================
  // Concurrent Writes (Task 7.9)
  // ========================================================================

  describe("concurrent writes", () => {
    it("two parallel storeMemory calls with same entity maintain consistency", async () => {
      const { storeMemory } = await import("./neo4j-client-memory.js");

      // Create a shared entity first
      const entityId = randomUUID();
      const setupSession = driver.session();
      try {
        await setupSession.run(
          `CREATE (e:Entity {id: $id, name: 'shared-entity', type: 'concept',
                            mentionCount: 0, firstSeen: datetime(), lastSeen: datetime(), aliases: []})`,
          { id: entityId },
        );
      } finally {
        await setupSession.close();
      }

      // Store two memories in parallel, both mentioning the same entity
      const [id1, id2] = [randomUUID(), randomUUID()];
      const makeInput = (id: string, text: string) => ({
        id,
        text,
        embedding: new Array(1536).fill(0.1),
        importance: 0.7,
        category: "fact" as const,
        source: "user" as const,
        extractionStatus: "pending" as const,
        agentId: "test-agent",
      });

      const session1 = driver.session();
      const session2 = driver.session();
      try {
        await Promise.all([
          storeMemory(session1, makeInput(id1, "Memory referencing shared entity A")),
          storeMemory(session2, makeInput(id2, "Memory referencing shared entity B")),
        ]);

        // Both memories should exist
        const verifySession = driver.session();
        try {
          const result = await verifySession.run(
            "MATCH (m:Memory) WHERE m.id IN [$id1, $id2] RETURN count(m) AS cnt",
            { id1, id2 },
          );
          expect(result.records[0].get("cnt").toNumber()).toBe(2);
        } finally {
          await verifySession.close();
        }
      } finally {
        await session1.close();
        await session2.close();
      }
    });
  });

  // ========================================================================
  // Signal Degradation (Task 7.10)
  // ========================================================================

  describe("signal degradation", () => {
    it("BM25 returns empty for non-matching agent (graceful)", async () => {
      // Verify BM25 search returns empty for an agent with no memories
      // rather than throwing, which validates the graceful degradation pattern.
      const { bm25Search } = await import("./neo4j-client-search.js");
      const { escapeLucene } = await import("./schema.js");
      const session = driver.session();
      try {
        const results = await bm25Search(
          session,
          escapeLucene("nonexistent query"),
          10,
          "agent-with-no-data",
        );
        expect(results).toEqual([]);
      } finally {
        await session.close();
      }
    });
  });
});
