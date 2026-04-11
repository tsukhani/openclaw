/**
 * Index/schema setup and reindex operations for the Neo4j memory client.
 */

import type { Driver, Session } from "neo4j-driver";
import type { Logger } from "./schema.js";

/** Run a DDL statement safely — logs but does not throw on expected errors (already exists, not found). */
async function runSafe(session: Session, query: string, logger: Logger): Promise<void> {
  try {
    await session.run(query);
  } catch (err) {
    const msg = String(err);
    // H6: Only suppress expected DDL errors (index/constraint already exists or doesn't exist).
    // Log unexpected errors (disk full, auth, OOM) at warn level so they're visible.
    const isExpected =
      msg.includes("already exists") ||
      msg.includes("EquivalentSchemaRuleAlreadyExists") ||
      msg.includes("No such index") ||
      msg.includes("Unable to drop index") ||
      msg.includes("IndexNotFound");
    if (isExpected) {
      logger.debug?.(`memory-neo4j: index/constraint statement skipped: ${msg}`);
    } else {
      logger.warn?.(`memory-neo4j: unexpected DDL error (query: ${query.slice(0, 80)}...): ${msg}`);
    }
  }
}

/**
 * Create all Neo4j constraints and indexes required by the memory client.
 * DDL statements run sequentially on a single session — Neo4j serializes schema
 * operations internally, and parallel sessions cause connection-closed errors
 * under default Docker resource limits.
 */
export async function ensureIndexes(
  driver: Driver,
  dimensions: number,
  logger: Logger,
): Promise<void> {
  // H6: Validate dimensions before interpolating into DDL to prevent invalid index creation
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 65536) {
    throw new Error(
      `memory-neo4j: invalid embedding dimensions: ${dimensions} (must be integer 1-65536)`,
    );
  }

  const ddl = [
    // Uniqueness constraints (also create indexes implicitly)
    "CREATE CONSTRAINT memory_id_unique IF NOT EXISTS FOR (m:Memory) REQUIRE m.id IS UNIQUE",
    "CREATE CONSTRAINT entity_id_unique IF NOT EXISTS FOR (e:Entity) REQUIRE e.id IS UNIQUE",
    "CREATE CONSTRAINT tag_name_unique IF NOT EXISTS FOR (t:Tag) REQUIRE t.name IS UNIQUE",

    // Vector indexes
    `CREATE VECTOR INDEX memory_embedding_index IF NOT EXISTS
      FOR (m:Memory) ON m.embedding
      OPTIONS {indexConfig: {
        \`vector.dimensions\`: ${dimensions},
        \`vector.similarity_function\`: 'cosine'
      }}`,

    // H5: Entity embedding vector index for dual-seed graph search (OP-143)
    `CREATE VECTOR INDEX entity_embedding_index IF NOT EXISTS
      FOR (e:Entity) ON e.embedding
      OPTIONS {indexConfig: {
        \`vector.dimensions\`: ${dimensions},
        \`vector.similarity_function\`: 'cosine'
      }}`,

    // Full-text indexes (Lucene BM25)
    "CREATE FULLTEXT INDEX memory_fulltext_index IF NOT EXISTS FOR (m:Memory) ON EACH [m.text]",
    // Migration: entity_fulltext_index v1 (name only) → v2 (name + aliases).
    // Drop the old index to allow creation with the expanded property set.
    // Aliases are string arrays — Neo4j fulltext indexes each element separately,
    // so searching for an alias term finds the entity without extra queries.
    "DROP INDEX entity_fulltext_index IF EXISTS",
    "CREATE FULLTEXT INDEX entity_fulltext_index IF NOT EXISTS FOR (e:Entity) ON EACH [e.name, e.aliases]",
    // Drop legacy typed-label fulltext index (OP-142)
    "DROP INDEX structured_entity_fulltext_index IF EXISTS",

    // Property indexes for filtering
    "CREATE INDEX memory_agent_index IF NOT EXISTS FOR (m:Memory) ON (m.agentId)",
    "CREATE INDEX memory_category_index IF NOT EXISTS FOR (m:Memory) ON (m.category)",
    "CREATE INDEX memory_created_index IF NOT EXISTS FOR (m:Memory) ON (m.createdAt)",
    "CREATE INDEX entity_type_index IF NOT EXISTS FOR (e:Entity) ON (e.type)",
    // OP-142: Agent scoping on Entity nodes
    "CREATE INDEX entity_agent_index IF NOT EXISTS FOR (e:Entity) ON (e.agentId)",
    // Composite index for MERGE on (name, agentId) — entities are scoped per agent
    "CREATE INDEX entity_name_agent_index IF NOT EXISTS FOR (e:Entity) ON (e.name, e.agentId)",
    // Composite index for agentId + category (e.g. listByCategory)
    "CREATE INDEX memory_agent_category_index IF NOT EXISTS FOR (m:Memory) ON (m.agentId, m.category)",
    // Extraction status index for listPendingExtractions (sleep cycle)
    "CREATE INDEX memory_extraction_status_index IF NOT EXISTS FOR (m:Memory) ON (m.extractionStatus)",
    // validUntil for IS NULL predicate in search queries
    "CREATE INDEX memory_validUntil_index IF NOT EXISTS FOR (m:Memory) ON (m.validUntil)",
    // Temporal index for active vs. expired filtering
    "CREATE INDEX memory_temporal IF NOT EXISTS FOR (m:Memory) ON (m.validUntil, m.validFrom)",
    // Composite index for conflict/importance queries (OP-108/Perf-5)
    "CREATE INDEX memory_agent_category_importance IF NOT EXISTS FOR (m:Memory) ON (m.agentId, m.category, m.importance)",

    // ── Episode indexes (episodic memory tier) ──
    "CREATE CONSTRAINT episode_id_unique IF NOT EXISTS FOR (e:Episode) REQUIRE e.id IS UNIQUE",
    "CREATE INDEX episode_agent_index IF NOT EXISTS FOR (e:Episode) ON (e.agentId)",
    "CREATE INDEX episode_session_index IF NOT EXISTS FOR (e:Episode) ON (e.sessionKey)",
    "CREATE INDEX episode_timestamp_index IF NOT EXISTS FOR (e:Episode) ON (e.timestamp)",

    // ── Community indexes (community detection) ──
    "CREATE CONSTRAINT community_id_unique IF NOT EXISTS FOR (c:Community) REQUIRE c.id IS UNIQUE",
    "CREATE FULLTEXT INDEX community_fulltext_index IF NOT EXISTS FOR (c:Community) ON EACH [c.name, c.summary]",

    // ── Neuro-symbolic logic engine indexes ──
    "CREATE CONSTRAINT rule_id_unique IF NOT EXISTS FOR (r:Rule) REQUIRE r.id IS UNIQUE",
    "CREATE INDEX rule_agent_active_index IF NOT EXISTS FOR (r:Rule) ON (r.agentId, r.active)",
    "CREATE CONSTRAINT inferred_fact_id_unique IF NOT EXISTS FOR (f:InferredFact) REQUIRE f.id IS UNIQUE",
    "CREATE INDEX inferred_fact_agent_index IF NOT EXISTS FOR (f:InferredFact) ON (f.agentId)",
    `CREATE VECTOR INDEX inferred_fact_embedding_index IF NOT EXISTS
      FOR (f:InferredFact) ON f.embedding
      OPTIONS {indexConfig: {
        \`vector.dimensions\`: ${dimensions},
        \`vector.similarity_function\`: 'cosine'
      }}`,
    "CREATE FULLTEXT INDEX inferred_fact_fulltext_index IF NOT EXISTS FOR (f:InferredFact) ON EACH [f.text]",
    "CREATE CONSTRAINT causal_model_id_unique IF NOT EXISTS FOR (cm:CausalModel) REQUIRE cm.id IS UNIQUE",
    "CREATE INDEX causal_model_agent_index IF NOT EXISTS FOR (cm:CausalModel) ON (cm.agentId)",
    "CREATE CONSTRAINT causal_variable_id_unique IF NOT EXISTS FOR (cv:CausalVariable) REQUIRE cv.id IS UNIQUE",
    "CREATE INDEX causal_variable_agent_name_index IF NOT EXISTS FOR (cv:CausalVariable) ON (cv.agentId, cv.name)",
  ];

  const session = driver.session();
  try {
    for (const query of ddl) {
      await runSafe(session, query, logger);
    }
  } finally {
    await session.close();
  }

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
  // H6: Validate dimensions before interpolating into DDL to prevent invalid index creation
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 65536) {
    throw new Error(
      `memory-neo4j: invalid embedding dimensions: ${dimensions} (must be integer 1-65536)`,
    );
  }

  const batchSize = options?.batchSize ?? 50;
  const progress = options?.onProgress ?? (() => {});
  const agentId = options?.agentId;

  // C2: Re-embed FIRST, then drop+recreate the index. This ensures the old index
  // remains functional if embedding fails midway — memories stay searchable.
  // Embeddings are written to Memory nodes directly (the index rebuilds from them).

  // Step 1: Fetch memories with cursor-based pagination (H8)
  progress("memories", 0, 0);
  let totalMemories = 0;
  let lastId = "";
  const PAGE_SIZE = 500;

  while (true) {
    const fetchSession = driver.session();
    let page: Array<{ id: string; text: string }>;
    try {
      const result = await fetchSession.run(
        `MATCH (m:Memory)
         WHERE ($agentId IS NULL OR m.agentId = $agentId)
           AND m.id > $lastId
         RETURN m.id AS id, m.text AS text
         ORDER BY m.id ASC
         LIMIT $pageSize`,
        { agentId: agentId ?? null, lastId, pageSize: PAGE_SIZE },
      );
      page = result.records.map((r) => ({
        id: r.get("id") as string,
        text: r.get("text") as string,
      }));
    } finally {
      await fetchSession.close();
    }

    if (page.length === 0) {
      break;
    }
    lastId = page[page.length - 1].id;

    // Re-embed this page in batches
    for (let i = 0; i < page.length; i += batchSize) {
      const batch = page.slice(i, i + batchSize);
      const vectors = await embedFn(batch.map((m) => m.text));

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
    }

    totalMemories += page.length;
    progress("memories", totalMemories, totalMemories);

    if (page.length < PAGE_SIZE) {
      break;
    }
  }

  // Step 2: Drop old index and recreate with current dimensions
  progress("create-indexes", 0, 1);
  const dropSession = driver.session();
  try {
    await runSafe(dropSession, "DROP INDEX memory_embedding_index IF EXISTS", logger);
  } finally {
    await dropSession.close();
  }

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

  return { memories: totalMemories };
}
