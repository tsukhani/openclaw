# Architecture: Contextual Retrieval

## Overview

Contextual Retrieval augments the existing memory-neo4j pipeline by inserting a **context generation** step between memory capture and embedding/indexing. An LLM generates a short (50-100 token) contextual summary for each memory, which is prepended to the original text before creating embeddings and BM25 entries. This preserves conversational context that would otherwise be lost when memories are stored as atomic units.

## Current Pipeline (Baseline)

```
User Input / Auto-Capture
        |
        v
+-------------------+
|  Attention Gate    |  passesAttentionGate() — skip noise
+--------+----------+
         |
         v
+-------------------+
|  Memory Text      |  <= 4000 chars, sanitized
|  (sanitized)      |
+--------+----------+
         |
    +----+-----+
    v          v
+--------+ +--------+
| Embed  | | Store  |
| (HNSW) | | (BM25) |
+----+---+ +----+---+
     |          |
     v          v
+---------------------+
|   Neo4j Node        |
|  Memory {           |
|    text,            |
|    embedding,       |
|    ...              |
|  }                  |
+---------------------+
```

## Proposed Pipeline (Contextual)

```
User Input / Auto-Capture
        |
        v
+-------------------+
|  Attention Gate    |
+--------+----------+
         |
         v
+-------------------+
|  Memory Text      |  <= 4000 chars, sanitized
+--------+----------+
         |
         v
+-------------------------------+
|  Context Generation (LLM)     |
|                               |
|  Input:                       |
|    - Source text (see below)  |
|    - Memory text              |
|                               |
|  Output:                      |
|    - 50-100 token context     |
|                               |
|  Optimizations:               |
|    - Prompt caching           |
|    - Batch processing         |
|    - Local model fallback     |
+--------+----------------------+
         |
         v
+-------------------------------+
|  Contextual Text              |
|  = "{context}: {original}"    |
+--------+----------------------+
         |
    +----+---------+
    v              v
+----------+  +-----------+
| Embed    |  | Store     |
| both     |  | both text |
| original |  | fields in |
| + ctx    |  | BM25      |
+----+-----+  +-----+-----+
     |               |
     v               v
+-------------------------------+
|   Neo4j Node                  |
|  Memory {                     |
|    text,                      |
|    contextualText,    (NEW)   |
|    contextualContext, (NEW)   |
|    embedding,         (EXIST) |
|    contextualEmbedding(NEW)   |
|    contextGenModel,   (NEW)   |
|    contextGenAt,      (NEW)   |
|    ...                        |
|  }                            |
+-------------------------------+
```

## Source Text Strategy

The Anthropic technique uses `WHOLE_DOCUMENT` as context. In memory-neo4j, memories come from conversations and various capture paths. The "source text" varies by memory origin:

| Memory Source     | SOURCE_TEXT                                             | Code Location                           |
| ----------------- | ------------------------------------------------------- | --------------------------------------- |
| `auto-capture`    | Compacted conversation text from `agent_end` hook       | `plugin-hooks.ts` → `auto-capture.ts`   |
| `user` (explicit) | Full user message containing the "remember" instruction | `plugin-tools.ts` → `memory_store` tool |
| `decomposed`      | Parent memory text (pre-decomposition)                  | `extractor-decompose.ts`                |
| `import`          | Full imported document/file                             | CLI import command                      |
| `memory-watcher`  | Conversation context window at capture time             | `plugin-hooks.ts`                       |

When `sourceText` is unavailable or too short (< 2x the memory text), context generation is skipped and the memory is stored without contextual fields.

### Episodic Memory as Source Recovery

For migration of existing memories, Episode nodes provide the richest source text:

```cypher
// Find episodes from the same session as the memory
MATCH (m:Memory {id: $memoryId})-[:EPISODE_SOURCE]->(e:Episode)
WITH e ORDER BY e.timestamp
RETURN collect(e.text) AS episodeTexts
```

If no direct EPISODE_SOURCE link exists, temporal proximity is used:

```cypher
MATCH (m:Memory {id: $memoryId})
MATCH (e:Episode {agentId: m.agentId, sessionKey: m.sessionKey})
WHERE abs(duration.between(m.createdAt, e.timestamp).seconds) < 300
RETURN e.text ORDER BY e.timestamp
```

## Integration Points

### 1. Auto-Capture Pipeline (`auto-capture.ts`)

The `runAutoCapture()` function gains a context generation step after importance rating:

```
extractUserMessages / extractAssistantMessages
    |
passesAttentionGate()
    |
detectInstructionPattern()
    |
detectTaskSignals()
    |
embeddings.embed()
    |
isSemanticDuplicate()
    |
isContradiction()
    |
rateImportance()
    |
decomposeIntoAtomicFacts()   <-- parent text becomes sourceText
    |
+-- generateContext()         <-- NEW: context from compacted text
    |
storeMemory / storeManyMemories
```

### 2. Decomposition Integration (`extractor-decompose.ts`)

When `decomposeIntoAtomicFacts()` splits a multi-entity memory into atomic facts, the **parent memory text** is the natural source context:

```typescript
// In decomposeIntoAtomicFacts, after splitting:
for (const atomicFact of atomicFacts) {
  // Parent text is the ideal sourceText for context generation
  atomicFact._sourceText = parentMemoryText;
}
```

This is one of the strongest use cases: decomposed facts like "Revenue grew 3%" gain context like "This fact is from a Q3 2025 earnings discussion about Acme Corp" from the parent memory.

### 3. Sleep Cycle Integration (`sleep-cycle.ts`)

The 8-phase sleep cycle consolidation can generate context during appropriate phases:

- **Phase 2c (Decomposition)**: When memories are decomposed, generate context using the parent text
- **Phase 5 (Entity extraction)**: After extraction reveals new relationships, context can reference entity connections
- **New Phase (optional)**: A dedicated "contextual enrichment" phase that backfills context for memories that were stored without it

### 4. Memory Storage (`neo4j-client-memory.ts`)

The `storeMemory` path gains contextual fields:

```typescript
interface MemoryNode {
  // Existing fields
  text: string;
  embedding: number[];

  // New contextual fields
  contextualContext?: string; // Generated context prefix
  contextualText?: string; // "{context}: {text}" concatenated
  contextualEmbedding?: number[]; // Embedding of contextualText
  contextGenModel?: string; // Model used (e.g. "claude-haiku-4-5")
  contextGenAt?: string; // ISO8601 timestamp
}
```

### 5. Embedding Pipeline (`embeddings.ts`)

No changes to the embedding functions themselves. The caller passes `contextualText` instead of `text` when generating the contextual embedding. Both `embedding` (original) and `contextualEmbedding` (contextual) are stored. The existing LRU cache (500 entries, xxhash64 keys) handles both transparently.

### 6. Index Schema (`neo4j-client-indexes.ts`)

New indexes alongside existing ones:

```
memory_contextual_embedding_index:
  Label: Memory
  Property: contextualEmbedding
  Type: HNSW cosine
  Dimensions: (same as memory_embedding_index)

memory_contextual_fulltext_index:
  Label: Memory
  Properties: [contextualText]
  Type: Lucene fulltext (BM25)
```

### 7. Search Pipeline (`search.ts`, `neo4j-client-search.ts`)

The existing 4-signal RRF fusion gains two contextual sub-signals, blended into their parent signals:

```
Signal 1: Vector Similarity
  1a. Original embedding search (existing, memory_embedding_index)
  1b. Contextual embedding search (NEW, memory_contextual_embedding_index)
  -> Blended with configurable weight (default 0.7 contextual, 0.3 original)

Signal 2: BM25 Full-Text
  2a. Original text BM25 (existing, memory_fulltext_index)
  2b. Contextual text BM25 (NEW, memory_contextual_fulltext_index)
  -> Blended with same configurable weight

Signal 3: Graph Traversal (unchanged)
Signal 4: Freshness/Temporal (unchanged)
```

### 8. Plugin Hooks (`plugin-hooks.ts`)

The `agent_end` and explicit memory store paths call the context generator before storing. Context generation is async and non-blocking for the user -- if it fails, the memory is stored without context (graceful degradation).

### 9. Reranker (`reranker.ts`, `reranker-local.ts`)

The local cross-encoder receives `contextualText` (context + original) when available, giving the model more signal for relevance scoring. The LLM reranker includes the context as additional metadata in its prompt.

## Cost Model

Based on Anthropic's analysis, adapted for memory-neo4j's memory sizes:

| Component                                           | Cost per 1M tokens processed |
| --------------------------------------------------- | ---------------------------- |
| Context generation (Haiku 4.5, no cache)            | ~$1.00                       |
| Context generation (Haiku 4.5, with prompt caching) | ~$0.015                      |
| Additional embedding (text-embedding-3-small)       | ~$0.02                       |
| Storage overhead                                    | ~15-20% more index space     |

**Prompt caching** reduces context generation cost by ~98.5% for memories from the same conversation session.

## Backward Compatibility

- **Existing memories**: Continue working with original `embedding` + `text` fields
- **New memories**: Get both original and contextual fields when enabled
- **Migration**: Optional background job + lazy migration for existing memories
- **Feature flag**: `contextualRetrieval.enabled` (default: `false` initially, `true` after validation)
- **Retrieval fallback**: If `contextualEmbedding` is null for a memory, that memory's contextual sub-signal scores are zero and original signals carry full weight
- **Disabling**: Setting `enabled: false` immediately stops generating and querying contextual data; existing contextual fields remain in Neo4j (harmless, no data loss)
