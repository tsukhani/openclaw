# Phase 2: Dual Indexing

## Overview

Dual indexing creates parallel indexes for contextual content alongside existing indexes. This enables the retrieval pipeline to search both original and contextualized representations of each memory.

## New Neo4j Indexes

### Contextual Vector Index

```cypher
CREATE VECTOR INDEX memory_contextual_embedding_index IF NOT EXISTS
FOR (m:Memory)
ON (m.contextualEmbedding)
OPTIONS {
  indexConfig: {
    `vector.dimensions`: $dimensions,
    `vector.similarity_function`: 'cosine'
  }
}
```

- Same dimensions as `memory_embedding_index` (configurable, typically 1536 for text-embedding-3-small)
- Cosine similarity (consistent with existing index)
- HNSW algorithm (Neo4j default for vector indexes)

### Contextual Full-Text Index (BM25)

```cypher
CREATE FULLTEXT INDEX memory_contextual_fulltext_index IF NOT EXISTS
FOR (n:Memory)
ON EACH [n.contextualText]
```

- Lucene analyzer with BM25 scoring
- Indexes the concatenated `"{context}: {text}"` field
- Enables lexical matching against both the context prefix and original text

## Schema Changes (`schema.ts`)

### Memory Node Additions

```typescript
// Added to MemoryNode interface
interface MemoryNodeContextual {
  /** Generated context prefix (50-100 tokens) */
  contextualContext?: string;

  /** Concatenated "{context}: {text}" for search */
  contextualText?: string;

  /** Embedding of contextualText */
  contextualEmbedding?: number[];

  /** Model used for context generation */
  contextGenModel?: string;

  /** When context was generated */
  contextGenAt?: string; // ISO8601
}
```

### Field Nullability

All contextual fields are **optional** (nullable). This ensures:

1. Existing memories without context continue to work
2. Memories where context generation failed are stored normally
3. Memories where source text was unavailable are stored normally
4. The feature can be disabled without data loss
5. Mixed state (some memories with context, some without) works correctly in search

## Index Creation (`neo4j-client-indexes.ts`)

### Modifications to `ensureIndexes()`

The existing `ensureIndexes()` function (which already creates `memory_embedding_index`, `memory_fulltext_index`, `entity_embedding_index`, `entity_fulltext_index`, and `community_fulltext_index`) is extended:

```typescript
async function ensureIndexes(session: Session, config: Config): Promise<void> {
  // ... existing index creation (unchanged) ...

  // Contextual indexes (only if feature enabled)
  if (config.contextualRetrieval?.enabled) {
    const dims = config.embedding?.dimensions ?? 1536;

    await ensureVectorIndex(session, {
      name: "memory_contextual_embedding_index",
      label: "Memory",
      property: "contextualEmbedding",
      dimensions: dims,
      similarity: "cosine",
    });

    await ensureFulltextIndex(session, {
      name: "memory_contextual_fulltext_index",
      label: "Memory",
      properties: ["contextualText"],
    });
  }
}
```

### Index Status Checking

The existing `checkIndexStatus()` function is extended to report contextual index health:

```typescript
interface IndexStatus {
  // Existing
  memoryEmbedding: IndexState;
  memoryFulltext: IndexState;
  entityEmbedding: IndexState;
  entityFulltext: IndexState;
  communityFulltext: IndexState;

  // New (only present when contextual retrieval enabled)
  memoryContextualEmbedding?: IndexState;
  memoryContextualFulltext?: IndexState;
}
```

## Storage Changes (`neo4j-client-memory.ts`)

### `storeMemory()` Modifications

The Cypher `MERGE` / `SET` statement is extended to include contextual fields when present:

```cypher
MERGE (m:Memory {id: $id})
SET m.text = $text,
    m.embedding = $embedding,
    m.importance = $importance,
    m.category = $category,
    m.source = $source,
    m.agentId = $agentId,
    m.createdAt = $createdAt,
    m.updatedAt = $updatedAt,
    // Contextual fields (set only when non-null)
    m.contextualContext = $contextualContext,
    m.contextualText = $contextualText,
    m.contextualEmbedding = $contextualEmbedding,
    m.contextGenModel = $contextGenModel,
    m.contextGenAt = $contextGenAt
```

When contextual fields are `undefined`/`null`, Neo4j stores them as `null` (no property set). This is consistent with existing optional fields like `validUntil` and `supersededBy`.

### `storeManyMemories()` Modifications

The batch `UNWIND` path gains the same contextual fields. The `_created` marker pattern is unchanged.

### New: `updateMemoryContext()` for Migration Backfill

A new method for the migration pipeline to add contextual fields to existing memories without touching other fields:

```typescript
async function updateMemoryContext(
  memoryId: string,
  contextualFields: {
    contextualContext: string;
    contextualText: string;
    contextualEmbedding: number[];
    contextGenModel: string;
    contextGenAt: string;
  },
): Promise<boolean> {
  const result = await session.run(
    `MATCH (m:Memory {id: $id})
     SET m.contextualContext = $contextualContext,
         m.contextualText = $contextualText,
         m.contextualEmbedding = $contextualEmbedding,
         m.contextGenModel = $contextGenModel,
         m.contextGenAt = $contextGenAt,
         m.updatedAt = $updatedAt
     RETURN m.id`,
    { id: memoryId, ...contextualFields, updatedAt: new Date().toISOString() },
  );
  return result.records.length > 0;
}
```

## Indexing Behavior

### Write Path

When a memory is stored with contextual fields:

1. Neo4j automatically indexes `contextualEmbedding` in the HNSW index
2. Neo4j automatically indexes `contextualText` in the fulltext index
3. No additional indexing calls needed -- indexes are maintained by the database

When a memory is stored **without** contextual fields:

1. Contextual indexes have no entry for this memory
2. Search queries on contextual indexes simply won't return this memory
3. Original indexes continue to return it normally
4. The blending logic handles this gracefully (see Phase 3)

### Read Path

Search queries handle missing contextual indexes gracefully:

```typescript
async function contextualVectorSearch(
  queryEmbedding: number[],
  limit: number,
  agentId: string,
): Promise<SearchSignalResult[]> {
  try {
    return await session.run(
      `CALL db.index.vector.queryNodes(
        'memory_contextual_embedding_index', $limit, $embedding
      ) YIELD node, score
      WHERE node.agentId = $agentId
      RETURN node.id AS id,
             node.text AS text,
             node.contextualContext AS contextualContext,
             score`,
      { limit, embedding: queryEmbedding, agentId },
    );
  } catch (error) {
    // Index may not exist yet -- graceful fallback
    if (isIndexNotFoundError(error)) return [];
    throw error;
  }
}
```

## Storage Overhead Estimation

| Field                 | Avg Size per Memory | Notes                                      |
| --------------------- | ------------------- | ------------------------------------------ |
| `contextualContext`   | ~400 bytes          | 50-100 tokens of generated text            |
| `contextualText`      | ~4400 bytes         | context + original text                    |
| `contextualEmbedding` | ~6 KB               | 1536 float32 values                        |
| `contextGenModel`     | ~30 bytes           | Model ID string                            |
| `contextGenAt`        | ~24 bytes           | ISO8601 timestamp                          |
| **Total per memory**  | **~11 KB**          | ~15-20% overhead on existing ~60 KB/memory |

For a typical agent with 10,000 memories: **~110 MB additional storage**.

## Index Performance

### HNSW Vector Index

- Build time: ~O(N log N) -- incremental as memories are added
- Query time: ~O(log N) -- same as existing vector index
- Memory: ~1.5x of embedding data (HNSW graph structure)

### Fulltext BM25 Index

- Build time: O(N x L) where L = avg contextualText length
- Query time: O(1) amortized (inverted index lookup)
- Memory: ~30% of total contextualText data (term frequencies + positions)

## Reindexing Support

The existing `reindexMemories()` CLI command (in `neo4j-client-indexes.ts`) is extended for contextual reindexing:

```typescript
async function reindexContextual(
  agentId: string,
  options: {
    batchSize?: number; // default 50
    concurrency?: number; // default 4
    force?: boolean; // re-generate even if context exists
  },
): Promise<ReindexResult> {
  // 1. Find memories needing contextual indexing
  const query = options.force
    ? `MATCH (m:Memory {agentId: $agentId}) RETURN m`
    : `MATCH (m:Memory {agentId: $agentId})
       WHERE m.contextualEmbedding IS NULL
       RETURN m`;

  // 2. For each batch:
  //    a. Retrieve source text (from episodes, parent, or neighbors)
  //    b. Generate context via LLM
  //    c. Embed contextual text
  //    d. Update memory node via updateMemoryContext()
  // 3. Return stats (processed, succeeded, failed, skipped)
}
```

This is also exposed as a sleep cycle phase and a CLI command (see migration-plan.md).
