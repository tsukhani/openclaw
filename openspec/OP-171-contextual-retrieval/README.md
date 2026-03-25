# OP-171: Contextual Retrieval for RAG-Anything

## Summary

Implement Anthropic's Contextual Retrieval technique in the memory-neo4j extension to reduce failed retrievals by 49% (67% with reranking). The core insight: prepend LLM-generated contextual summaries to memory text before embedding and BM25 indexing, preserving conversational and document-level context that atomic memory storage discards.

**Reference**: [Anthropic — Contextual Retrieval](https://www.anthropic.com/engineering/contextual-retrieval)

**JIRA**: OP-171

## Artifacts

| Artifact                                                     | Description                                        |
| ------------------------------------------------------------ | -------------------------------------------------- |
| [architecture.md](./architecture.md)                         | System architecture, data flow, integration points |
| [phase-1-preprocessing.md](./phase-1-preprocessing.md)       | Context generation pipeline design                 |
| [phase-2-dual-indexing.md](./phase-2-dual-indexing.md)       | Contextual embeddings + contextual BM25 indexes    |
| [phase-3-hybrid-retrieval.md](./phase-3-hybrid-retrieval.md) | Hybrid retrieval with rank fusion + reranking      |
| [api-changes.md](./api-changes.md)                           | All interface, type, and API surface changes       |
| [config-schema.md](./config-schema.md)                       | Configuration schema additions                     |
| [data-flow-diagrams.md](./data-flow-diagrams.md)             | Mermaid data flow diagrams for all pipelines       |
| [test-plan.md](./test-plan.md)                               | Test plan and benchmarking strategy                |
| [migration-plan.md](./migration-plan.md)                     | Migration plan for existing collections            |

## Scope

**In scope**:

- Context generation for Memory nodes using configurable LLM
- Dual indexing (contextual vector + contextual BM25)
- Enhanced hybrid retrieval with contextual signals
- Integration with decomposition pipeline (parent memory as source context)
- Integration with sleep cycle consolidation (context generation during Phase 2c)
- Integration with episodic memory tier (source text recovery from Episode nodes)
- Backward-compatible migration path
- Prompt caching for cost efficiency

**Out of scope**:

- RAG-Anything upstream library changes (Python, document parsing)
- Entity/Community node contextualization (future work)
- Cross-agent contextual retrieval
- Changes to the GLiNER/regex local NER pipeline

## Key Metrics

| Technique                    | Failed Retrieval Reduction |
| ---------------------------- | -------------------------- |
| Contextual Embeddings only   | ~35%                       |
| Contextual Embeddings + BM25 | ~49%                       |
| + Reranking                  | ~67%                       |

## Architecture Adaptation

The Anthropic article describes Contextual Retrieval for traditional document-chunking RAG. The memory-neo4j extension uses **atomic semantic memories** rather than fixed-size chunks. Key adaptations:

| Anthropic Article                       | memory-neo4j Adaptation                                    |
| --------------------------------------- | ---------------------------------------------------------- |
| Fixed-size document chunks (800 tokens) | Atomic memories (variable size, max ~4000 chars)           |
| Whole document as context source        | Conversation compaction, session episodes, parent memories |
| Single embedding per chunk              | Dual embedding (original + contextual) per Memory node     |
| Standalone BM25 index                   | Neo4j Lucene fulltext index (existing + contextual)        |
| Simple cosine similarity                | 4-signal RRF fusion with confidence weighting              |

## Files Affected

```
extensions/memory-neo4j/
  contextual-retrieval.ts        (NEW)  - context generation pipeline
  contextual-cache.ts            (NEW)  - document/context caching
  migration.ts                   (NEW)  - backfill existing memories
  embeddings.ts                  (MOD)  - embed contextual text
  search.ts                      (MOD)  - add contextual signals to RRF
  neo4j-client-search.ts         (MOD)  - contextual vector + BM25 queries
  neo4j-client-indexes.ts        (MOD)  - new index definitions
  neo4j-client-memory.ts         (MOD)  - store contextual fields
  schema.ts                      (MOD)  - Memory node schema additions
  config.ts                      (MOD)  - contextualRetrieval config block
  plugin-hooks.ts                (MOD)  - wire context generation into pipeline
  reranker.ts                    (MOD)  - context-aware reranking
  auto-capture.ts                (MOD)  - pass source text through pipeline
  extractor-decompose.ts         (MOD)  - pass parent text as source context
  sleep-cycle.ts                 (MOD)  - context generation during consolidation
```
