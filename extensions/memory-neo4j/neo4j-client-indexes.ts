/**
 * Index/schema setup and reindex operations for the Neo4j memory client.
 */

import type { Driver, Session } from "neo4j-driver";
import type { Logger } from "./schema.js";

/** Run a DDL statement safely — logs but does not throw on error. */
async function runSafe(session: Session, query: string, logger: Logger): Promise<void> {
  try {
    await session.run(query);
  } catch (err) {
    logger.debug?.(`memory-neo4j: index/constraint statement skipped: ${String(err)}`);
  }
}

/** Open a dedicated session, run a DDL statement safely, then close the session. */
async function runSafeOwn(driver: Driver, query: string, logger: Logger): Promise<void> {
  const session = driver.session();
  try {
    await runSafe(session, query, logger);
  } finally {
    await session.close();
  }
}

/**
 * Create all Neo4j constraints and indexes required by the memory client.
 * Each DDL runs in its own session so they can be issued in parallel (OP-109).
 */
export async function ensureIndexes(
  driver: Driver,
  dimensions: number,
  logger: Logger,
): Promise<void> {
  await Promise.all([
    // Uniqueness constraints (also create indexes implicitly)
    runSafeOwn(
      driver,
      "CREATE CONSTRAINT memory_id_unique IF NOT EXISTS FOR (m:Memory) REQUIRE m.id IS UNIQUE",
      logger,
    ),
    runSafeOwn(
      driver,
      "CREATE CONSTRAINT entity_id_unique IF NOT EXISTS FOR (e:Entity) REQUIRE e.id IS UNIQUE",
      logger,
    ),
    runSafeOwn(
      driver,
      "CREATE CONSTRAINT tag_name_unique IF NOT EXISTS FOR (t:Tag) REQUIRE t.name IS UNIQUE",
      logger,
    ),

    // Vector indexes
    runSafeOwn(
      driver,
      `CREATE VECTOR INDEX memory_embedding_index IF NOT EXISTS
      FOR (m:Memory) ON m.embedding
      OPTIONS {indexConfig: {
        \`vector.dimensions\`: ${dimensions},
        \`vector.similarity_function\`: 'cosine'
      }}`,
      logger,
    ),

    // Full-text indexes (Lucene BM25)
    runSafeOwn(
      driver,
      "CREATE FULLTEXT INDEX memory_fulltext_index IF NOT EXISTS FOR (m:Memory) ON EACH [m.text]",
      logger,
    ),
    runSafeOwn(
      driver,
      "CREATE FULLTEXT INDEX entity_fulltext_index IF NOT EXISTS FOR (e:Entity) ON EACH [e.name]",
      logger,
    ),

    // Property indexes for filtering
    runSafeOwn(
      driver,
      "CREATE INDEX memory_agent_index IF NOT EXISTS FOR (m:Memory) ON (m.agentId)",
      logger,
    ),
    runSafeOwn(
      driver,
      "CREATE INDEX memory_category_index IF NOT EXISTS FOR (m:Memory) ON (m.category)",
      logger,
    ),
    runSafeOwn(
      driver,
      "CREATE INDEX memory_created_index IF NOT EXISTS FOR (m:Memory) ON (m.createdAt)",
      logger,
    ),
    runSafeOwn(
      driver,
      "CREATE INDEX memory_retrieved_index IF NOT EXISTS FOR (m:Memory) ON (m.lastRetrievedAt)",
      logger,
    ),
    runSafeOwn(
      driver,
      "CREATE INDEX entity_type_index IF NOT EXISTS FOR (e:Entity) ON (e.type)",
      logger,
    ),
    runSafeOwn(
      driver,
      "CREATE INDEX entity_name_index IF NOT EXISTS FOR (e:Entity) ON (e.name)",
      logger,
    ),

    // Composite index for queries that filter by both agentId and category
    // (e.g. listByCategory)
    runSafeOwn(
      driver,
      "CREATE INDEX memory_agent_category_index IF NOT EXISTS FOR (m:Memory) ON (m.agentId, m.category)",
      logger,
    ),

    // Extraction status index for listPendingExtractions (sleep cycle)
    runSafeOwn(
      driver,
      "CREATE INDEX memory_extraction_status_index IF NOT EXISTS FOR (m:Memory) ON (m.extractionStatus)",
      logger,
    ),

    // Temporal index for efficient filtering of active vs. expired memories
    runSafeOwn(
      driver,
      "CREATE INDEX memory_temporal IF NOT EXISTS FOR (m:Memory) ON (m.validUntil, m.validFrom)",
      logger,
    ),

    // Index for task-scoped memory lookups (OP-108)
    runSafeOwn(
      driver,
      "CREATE INDEX memory_task_id_index IF NOT EXISTS FOR (m:Memory) ON (m.taskId)",
      logger,
    ),

    // Composite index for conflict/importance queries (OP-108/Perf-5)
    runSafeOwn(
      driver,
      "CREATE INDEX memory_agent_category_importance IF NOT EXISTS FOR (m:Memory) ON (m.agentId, m.category, m.importance)",
      logger,
    ),
  ]);

  logger.info("memory-neo4j: indexes ensured");
}

/**
 * Re-embed all Memory nodes with a new embedding model.
 *
 * Steps:
 * 1. Drop old vector index (dimensions may have changed)
 * 2. Fetch all Memory nodes and re-embed their text
 * 3. Recreate vector index with current dimensions
 *
 * Entities and tags are not affected — they use fulltext search
 * and graph traversal, not vector embeddings.
 *
 * Used after changing the embedding model/provider in config.
 */
export async function reindex(
  driver: Driver,
  dimensions: number,
  logger: Logger,
  embedFn: (texts: string[]) => Promise<number[][]>,
  options?: {
    batchSize?: number;
    onProgress?: (phase: string, done: number, total: number) => void;
    agentId?: string;
  },
): Promise<{ memories: number }> {
  const batchSize = options?.batchSize ?? 50;
  const progress = options?.onProgress ?? (() => {});
  const agentId = options?.agentId;

  // Step 1: Drop old vector index
  progress("drop-indexes", 0, 1);
  const dropSession = driver.session();
  try {
    await runSafe(dropSession, "DROP INDEX memory_embedding_index IF EXISTS", logger);
  } finally {
    await dropSession.close();
  }
  progress("drop-indexes", 1, 1);

  // Step 2: Fetch and re-embed memories
  const fetchSession = driver.session();
  let memories: Array<{ id: string; text: string }>;
  try {
    const result = await fetchSession.run(
      `MATCH (m:Memory)
       WHERE ($agentId IS NULL OR m.agentId = $agentId)
       RETURN m.id AS id, m.text AS text ORDER BY m.createdAt ASC`,
      { agentId: agentId ?? null },
    );
    memories = result.records.map((r) => ({
      id: r.get("id") as string,
      text: r.get("text") as string,
    }));
  } finally {
    await fetchSession.close();
  }
  progress("memories", 0, memories.length);

  for (let i = 0; i < memories.length; i += batchSize) {
    const batch = memories.slice(i, i + batchSize);
    const vectors = await embedFn(batch.map((m) => m.text));

    // Build items array for batch UNWIND update
    const items: Array<{ id: string; embedding: number[] }> = [];
    for (let j = 0; j < batch.length; j++) {
      if (vectors[j] && vectors[j].length > 0) {
        items.push({ id: batch[j].id, embedding: vectors[j] });
      }
    }
    if (items.length > 0) {
      const session = driver.session();
      try {
        await session.run(
          `UNWIND $items AS item
           MATCH (m:Memory {id: item.id})
           SET m.embedding = item.embedding`,
          { items },
        );
      } finally {
        await session.close();
      }
    }
    progress("memories", Math.min(i + batchSize, memories.length), memories.length);
  }

  // Step 3: Recreate vector index with current dimensions
  progress("create-indexes", 0, 1);
  const indexSession = driver.session();
  try {
    await runSafe(
      indexSession,
      `CREATE VECTOR INDEX memory_embedding_index IF NOT EXISTS
       FOR (m:Memory) ON m.embedding
       OPTIONS {indexConfig: {
         \`vector.dimensions\`: ${dimensions},
         \`vector.similarity_function\`: 'cosine'
       }}`,
      logger,
    );
  } finally {
    await indexSession.close();
  }
  progress("create-indexes", 1, 1);

  return { memories: memories.length };
}
