# Memory Neo4j — Architecture

## Overview

The memory-neo4j plugin provides long-term memory for OpenClaw agents using a Neo4j graph database. It replaces the simpler memory-lancedb plugin with three-signal hybrid search (vector + BM25 + graph traversal), entity extraction, and a knowledge graph that captures relationships between people, organizations, concepts, and events.

The design draws on cognitive science foundations. Memory decay follows the Ebbinghaus forgetting curve, where importance-weighted half-lives control how long memories survive. Retrieval-based strengthening mirrors ACT-R — each recall boosts a memory's effective importance. The storage hierarchy uses a MemGPT/Letta-inspired tiered architecture: episodic memory (raw conversation turns), semantic memory (extracted facts and entities), and reflective memory (observations and opinions synthesized during sleep cycles).

The system operates in two modes: real-time (capture and recall during conversation) and batch (sleep cycle consolidation). Real-time paths are latency-sensitive and use fire-and-forget patterns. The sleep cycle runs offline — typically on a cron schedule — and performs expensive LLM-based operations like entity extraction, conflict detection, community detection, and opinion synthesis.

## Module Map

### Core Infrastructure

| File                | Purpose                                                                                |
| ------------------- | -------------------------------------------------------------------------------------- |
| `index.ts`          | Plugin entry point — wires config, creates shared resources, registers tools/hooks/CLI |
| `config.ts`         | TypeBox config schema with env var resolution, presets, validation                     |
| `schema.ts`         | Graph node/edge types, extraction types, search result types, constants                |
| `errors.ts`         | Error classification (transient vs. connection vs. permanent)                          |
| `retry.ts`          | Exponential backoff with jitter for transient Neo4j errors                             |
| `metrics.ts`        | Pluggable metrics collector (counters, histograms, no-op default)                      |
| `llm-client.ts`     | LLM call wrapper — routes through OpenClaw's model stack via plugin API                |
| `embeddings.ts`     | Embedding provider abstraction (OpenAI, Ollama)                                        |
| `message-utils.ts`  | Helpers for extracting user/assistant messages from conversation turns                 |
| `porter-stemmer.ts` | Porter stemming for BM25 query expansion                                               |
| `_testing.ts`       | Shared test utilities                                                                  |

### CLI

| File              | Purpose                                                                     |
| ----------------- | --------------------------------------------------------------------------- |
| `cli.ts`          | CLI command registration entry point                                        |
| `cli-commands.ts` | `openclaw memory` subcommands: search, store, forget, stats, sleep, reindex |

### Neo4j Client Layer

`neo4j-client.ts` is a thin facade over the Neo4j driver. It delegates all operations to specialist modules:

| File                             | Purpose                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------ |
| `neo4j-client.ts`                | Connection management, driver lifecycle, retrieval tracking buffer, delegation |
| `neo4j-client-indexes.ts`        | DDL: constraints, vector/fulltext/property indexes, reindex                    |
| `neo4j-client-memory.ts`         | CRUD for Memory nodes (store, update, delete, list, find-similar)              |
| `neo4j-client-entity.ts`         | Entity/relationship/tag MERGE, alias resolution, property storage              |
| `neo4j-client-episode.ts`        | Episodic memory tier — episode storage, linking, retention                     |
| `neo4j-client-search.ts`         | Raw signal queries: vector (HNSW), BM25 (fulltext), graph traversal            |
| `neo4j-client-observation.ts`    | Observation node CRUD (per-entity summaries)                                   |
| `neo4j-client-opinion.ts`        | Opinion node CRUD (synthesized beliefs with confidence)                        |
| `neo4j-client-community.ts`      | Community detection — Louvain-style entity clustering                          |
| `neo4j-client-sleep.ts`          | Sleep-cycle DB operations (dedup candidates, decay queries)                    |
| `neo4j-client-sleep-conflict.ts` | Conflict detection DB queries                                                  |
| `neo4j-client-sleep-decay.ts`    | Decay curve application, temporal staleness queries                            |

### Search and Retrieval

| File                       | Purpose                                                                    |
| -------------------------- | -------------------------------------------------------------------------- |
| `search.ts`                | Three-signal hybrid search orchestrator with query-adaptive RRF fusion     |
| `query-analyzer.ts`        | Query classification, temporal constraint extraction, query decomposition  |
| `abstention-classifier.ts` | Feature-based classifier — decides when to return empty vs. weak results   |
| `reranker.ts`              | Reranker dispatcher — routes to local cross-encoder or LLM reranker        |
| `reranker-local.ts`        | Local cross-encoder HTTP client for fast semantic reranking                |
| `reranker-llm.ts`          | LLM-based reranker for temporal/update queries (understands recency)       |
| `search-cache.ts`          | LRU query result cache with TTL                                            |
| `mpfp-search.ts`           | Meta-path forward push graph traversal (MPFP) for advanced search patterns |

### Memory Extraction

| File                      | Purpose                                                                 |
| ------------------------- | ----------------------------------------------------------------------- |
| `extractor.ts`            | Core extraction pipeline — LLM-based entity/relationship/tag extraction |
| `extractor-local.ts`      | Local NER (regex + pattern) before LLM fallback                         |
| `extractor-decompose.ts`  | Decompose compound memories into atomic facts                           |
| `extractor-dedup.ts`      | Semantic duplicate detection (embedding similarity + LLM confirmation)  |
| `extractor-conflict.ts`   | Contradiction detection between memories                                |
| `extractor-importance.ts` | Importance rating (0-10 scale via LLM)                                  |
| `extractor-capture.ts`    | Capture-worthiness classification                                       |

### Sleep Cycle

| File                           | Purpose                                                                 |
| ------------------------------ | ----------------------------------------------------------------------- |
| `sleep-cycle.ts`               | Orchestrator — sequences phases with mutex, abort support, metrics      |
| `sleep-cycle-types.ts`         | Phase result types, credential detection, options                       |
| `sleep-phases-dedup.ts`        | Phases 1/1b/1c/1d: vector dedup, semantic dedup, conflict, entity dedup |
| `sleep-phases-extract.ts`      | Phases 2/2b: pending extraction, retroactive tagging                    |
| `sleep-phases-links.ts`        | Phase 10: SIMILAR, TEMPORAL_NEXT, CAUSED_BY edge creation               |
| `sleep-phases-observations.ts` | Phase 11: per-entity observation synthesis                              |
| `sleep-phases-reflect.ts`      | Phase 12: opinion/belief generation from observations                   |
| `sleep-phases-community.ts`    | Phase 2c: community detection (opt-in)                                  |
| `sleep-phases-decay.ts`        | Phases 3/3b/3c/3d: decay, temporal staleness, retroactive conflicts     |
| `sleep-phases-cleanup.ts`      | Phases 4/5/5b: orphan cleanup, noise patterns, credential scan          |
| `sleep-phases-reclassify.ts`   | Phase 9: entity and relationship type reclassification                  |
| `sleep-phases-tips.ts`         | Phase 6: lesson/tip generation from failure patterns                    |

### Auto-Capture and Attention Gate

| File                      | Purpose                                                               |
| ------------------------- | --------------------------------------------------------------------- |
| `auto-capture.ts`         | Fire-and-forget capture pipeline from agent_end hook                  |
| `attention-gate.ts`       | Heuristic noise filter — rejects greetings, commands, metadata, emoji |
| `instruction-detector.ts` | Detects prompt injection patterns, quarantines suspicious memories    |

### Plugin Integration

| File              | Purpose                                                                            |
| ----------------- | ---------------------------------------------------------------------------------- |
| `plugin-hooks.ts` | Hook registrations: before_prompt_build (recall), agent_end (capture), session_end |
| `plugin-tools.ts` | Tool registrations: memory_recall, memory_store, memory_forget                     |

### Evaluation Framework (`eval/`)

| File                                   | Purpose                                                 |
| -------------------------------------- | ------------------------------------------------------- |
| `eval/harness.ts`                      | Core eval runner — store, search, measure, report       |
| `eval/types.ts`                        | Eval types: test cases, metrics, results                |
| `eval/variants.ts`                     | Named config variants for A/B testing search parameters |
| `eval/baseline.ts`                     | Regression baseline storage/comparison                  |
| `eval/ab-compare.ts`                   | Side-by-side variant comparison                         |
| `eval/judges/llm-judge.ts`             | LLM-as-judge for context completeness scoring           |
| `eval/metrics/retrieval.ts`            | Precision, recall, MRR, NDCG                            |
| `eval/metrics/context-completeness.ts` | Context completeness metric                             |
| `eval/metrics/signal-attribution.ts`   | Per-signal contribution analysis                        |
| `eval/metrics/latency.ts`              | Latency percentile tracking                             |
| `eval/metrics/end-to-end.ts`           | End-to-end answer quality (Tier 2)                      |
| `eval/datasets/loader.ts`              | Dataset loading dispatcher                              |
| `eval/datasets/custom-adapter.ts`      | Custom fixture format adapter                           |
| `eval/datasets/locomo-adapter.ts`      | LoCoMo benchmark adapter                                |
| `eval/datasets/longmemeval-adapter.ts` | LongMemEval benchmark adapter                           |
| `eval/datasets/hybrid-adapter.ts`      | Mixed dataset adapter                                   |
| `eval/reporters/console.ts`            | Terminal table reporter                                 |
| `eval/reporters/json.ts`               | JSON output for CI                                      |
| `eval/reporters/markdown.ts`           | Markdown report generator                               |

## Data Model

### Node Types

```
(:Memory {id, text, embedding, importance, category, source, agentId,
          validFrom, validUntil, supersededBy, trustScore, quarantined,
          extractionStatus, retrievalCount, lastRetrievedAt, ...})

(:Entity {id, name, type, aliases[], description, agentId,
          firstSeen, lastSeen, relationshipCount, embedding})

(:Tag {id, name, category})

(:Episode {id, text, role, timestamp, sessionKey, agentId})

(:Community {id, name, summary, entityCount, embedding})

(:Observation {id, entityName, agentId, summary, lastRefreshed, memoryCount})

(:Opinion {id, agentId, topic, belief, confidence, archived,
           supportingMemoryIds[], contradictingMemoryIds[]})
```

### Relationship Types

```
(Memory)-[:MENTIONS]->(Entity)        -- extraction output
(Memory)-[:TAGGED_WITH]->(Tag)        -- category tagging
(Memory)-[:SIMILAR]->(Memory)         -- cosine similarity edges (sleep phase 10)
(Memory)-[:TEMPORAL_NEXT]->(Memory)   -- chronological ordering within agent
(Memory)-[:CAUSED_BY]->(Memory)       -- causal chain links
(Memory)-[:PART_OF_EPISODE]->(Episode)
(Entity)-[*]->(Entity)                -- dynamic types: WORKS_AT, KNOWS, LIVES_AT, etc.
(Entity)-[:PART_OF_COMMUNITY]->(Community)
(Observation)-[:OBSERVES]->(Entity)
```

Entity-to-entity relationships carry temporal properties: `validFrom`, `validUntil`, `confidence`, `qualifier`.

### Indexes

- **Vector (HNSW cosine):** `memory_embedding_index`, `entity_embedding_index`
- **Fulltext (BM25/Lucene):** `memory_fulltext_index`, `entity_fulltext_index`, `community_fulltext_index`
- **Property:** agentId, category, createdAt, extractionStatus, validUntil, composites for common query patterns
- **Constraints:** uniqueness on Memory.id, Entity.id, Tag.name, Episode.id, Community.id

## Signal Flow

### Capture Path

```
message
  |
  v
attention-gate ──> reject (noise, emoji, commands, metadata)
  |
  v
importance-rating (LLM: 0-10 scale)
  |
  v
dedup-check (vector similarity >= 0.95 = exact dup, >= 0.85 = semantic dup candidate)
  |
  v
credential-check (reject leaked secrets)
  |
  v
instruction-check (quarantine prompt injection patterns)
  |
  v
decompose (split compound facts into atomic memories)
  |
  v
embed + store (fire-and-forget, extraction marked "pending")
```

### Recall Path

```
query
  |
  v
classify (short | entity | long | updates | extraction | causal | default)
  |
  v
+-- Signal 1: Vector similarity (HNSW cosine)
|
+-- Signal 2: BM25 keyword search (fulltext index, stemmed + expanded)
|
+-- Signal 3: Graph traversal (entity fulltext lookup -> spreading activation)
  |
  v
RRF fusion (query-adaptive weights per signal)
  |
  v
temporal filtering (validUntil, supersededBy)
  |
  v
abstention classifier (return empty if scores too weak)
  |
  v
reranker (local cross-encoder or LLM for temporal queries)
  |
  v
inject into prompt (via before_prompt_build hook)
```

### Sleep Cycle (Consolidation)

```
Stage 1 (sequential — data dependencies):
  Phase 1:   Dedup (vector + semantic)
  Phase 1c:  Conflict detection
  Phase 1d:  Entity dedup
  Phase 2:   Entity extraction (pending memories)
  Phase 2b:  Retroactive tagging
  Phase 10:  Link creation (SIMILAR, TEMPORAL_NEXT, CAUSED_BY)
  Phase 11:  Observation generation
  Phase 12:  Reflection (opinion synthesis)
  Phase 2c:  Community detection (opt-in)

Stage 2 (parallel — independent groups):
  Group A: Decay -> temporal staleness -> retroactive conflict scan -> pending conflict retry
  Group B: Noise cleanup -> credential scan -> episode retention
  Group C: Tip generation
  Group D: Entity reclassification -> relationship reclassification

Stage 3 (sequential — depends on Stage 2):
  Phase 4: Orphan cleanup (entities/tags orphaned by decay)
```

## Key Design Patterns

**Delegation.** `Neo4jMemoryClient` is a thin facade that delegates to `neo4j-client-*.ts` specialist modules. Each specialist owns one concern (indexes, memory CRUD, search, entity management, sleep operations). This keeps the client class navigable while specialist modules remain independently testable.

**Circuit breaker (auto-capture).** The auto-capture pipeline uses connection guards that catch Neo4j connection errors and return graceful fallbacks instead of crashing the agent. The retrieval tracking buffer caps at 1000 entries to prevent unbounded growth during outages, with automatic flush retries on shorter intervals after failures.

**Query-adaptive RRF.** The search module classifies each query (short, entity, long, updates, causal) and adjusts signal weights accordingly. Short queries boost BM25 (exact keywords matter more), entity queries boost graph traversal, long queries boost vector similarity, and update queries boost temporal freshness. The abstention classifier then decides whether the fused results are strong enough to return.

**Bi-temporal validity.** Every Memory node carries `validFrom` and `validUntil` timestamps. `validFrom` records when the fact became true (defaults to creation time). `validUntil` records when it stopped being true (null = still valid). `supersededBy` links to the replacement memory. Search queries filter on temporal validity by default. The sleep cycle's conflict detection and retroactive conflict scan maintain these fields.

**Fire-and-forget with drain.** Auto-capture runs asynchronously from the agent_end hook — the agent does not wait for memory storage to complete. Retrieval count updates are batched in an in-memory buffer and flushed periodically (30s) or on threshold (50 entries). Plugin shutdown drains pending operations via the flush mechanism before closing the Neo4j driver.

**Sleep cycle mutex.** A module-level boolean flag prevents concurrent sleep cycles (safe because Node.js is single-threaded). If a CLI-triggered sleep overlaps with a cron-triggered one, the second invocation returns immediately with an aborted result.

## Configuration

The full configuration schema is in `extensions/memory-neo4j/config.ts`. Key tuning knobs:

- **`autoCapture` / `autoRecall`** — toggle real-time capture and recall
- **`autoRecallMinScore`** — minimum RRF score to inject a memory into prompt
- **`graphSearchDepth`** / **`graphSeedCap`** — control graph traversal breadth and depth
- **`decayCurves`** — per-category half-life in days (e.g., core memories decay slower)
- **`sleepCycle.schedule`** — cron expression for automatic consolidation
- **`conflictDetection`** — toggle and tune LLM-based contradiction detection
- **`reranker`** — provider selection (local cross-encoder, LLM, none)
- **`disposition`** — personality parameters (skepticism, literalism, empathy) that influence extraction
- **`coreMemory.refreshAtContextPercent`** — re-inject core memories mid-conversation to counter "lost in the middle"

## Architecture Decision Records

Detailed specs for major design decisions live in `extensions/memory-neo4j/specs/`:

- **OP-191** — Abstention detection: when to return empty results vs. weak matches
- **OP-192** — Graph signal weighting: how graph traversal scores are normalized and fused
- **OP-193** — Temporal validity filtering: bi-temporal query semantics
- **OP-194** — Knowledge update detection: identifying and resolving contradictions between old and new facts
