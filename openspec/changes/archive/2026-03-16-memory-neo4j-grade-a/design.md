## Context

The memory-neo4j extension (32K LOC, 60+ files) provides a Neo4j-backed agentic long-term memory system with three-signal hybrid search (vector + BM25 + graph), 9-phase sleep cycle consolidation, and bitemporal validity. A comprehensive code review graded it B+ — best-in-class retrieval sophistication but gaps in test coverage, caching, and cognitive architecture breadth (no community detection, episodic memory, or memory poisoning defenses).

The current architecture is cleanly modular: search signals are composed via `fuseWithConfidenceRRF()`, sleep phases are sequentially orchestrated, and config/schema/indexes follow consistent patterns. All six new capabilities can be added via insertion — no refactoring of existing code is required.

**Key architectural anchor points:**

- **Search signals** combine in `search.ts` → `hybridSearch()` → `fuseWithConfidenceRRF(signals[], weights[])`
- **Sleep phases** execute sequentially in `sleep-cycle.ts` with abort signal support
- **Config** is a flat TypeScript type with optional sections; validated in `config.ts`
- **Graph schema** is defined in `schema.ts` with types, indexes in `neo4j-client-indexes.ts`
- **Plugin hooks** register via `api.on("agent_end")` in `plugin-hooks.ts`
- **Caching** follows the `EmbeddingCache` LRU pattern in `embeddings.ts` (Map-based, MD5 key hashing)

## Goals / Non-Goals

**Goals:**

- Validate all Cypher queries against real Neo4j (integration tests with Docker)
- Add query result caching to reduce redundant index hits
- Add community detection for global/thematic queries
- Add episodic memory for non-lossy conversation preservation
- Add trust scoring and instruction detection for memory poisoning defense
- All new features opt-in (disabled by default except trust scoring and instruction detection heuristics) to preserve zero-config deployments

**Non-Goals:**

- Refactoring existing search/sleep-cycle code — insertions only
- Procedural memory (future work, requires agent self-management tools)
- Agent-managed memory tools (Letta-style OS paradigm — different design philosophy)
- Horizontal sharding by agentId (infrastructure concern, not application-level)
- Changing the existing embedding provider interface
- Real-time community updates (batch in sleep cycle is sufficient)

## Decisions

### D1: Integration tests use testcontainers via Docker

**Decision:** Use a programmatic Docker-based Neo4j container spun up per test suite, gated behind `MEMORY_NEO4J_INTEGRATION=1`.

**Rationale:** testcontainers gives each test suite a clean Neo4j instance without CI configuration complexity. Tests validate actual Cypher syntax, index behavior, and constraint enforcement — the primary gap identified in the review.

**Alternatives considered:**

- Docker Compose in CI: More infrastructure to maintain, harder to parallelize test suites
- Neo4j embedded (Java): Not available for Node.js
- Mock validation layer: Defeats the purpose — we need real query validation

**Structure:** Single file `neo4j-integration.test.ts` with describe blocks per operation category. Setup creates container + runs `ensureIndexes()`. Teardown stops container. Each describe block gets a fresh database via `MATCH (n) DETACH DELETE n`.

### D2: Query result cache follows EmbeddingCache LRU pattern

**Decision:** New `QueryResultCache` class in `search-cache.ts` following the existing `EmbeddingCache` pattern — Map-based LRU with MD5 hash keys. Key: `md5(query + ":" + agentId)`. Value: `{ results: HybridSearchResult[], expiresAt: number }`.

**Rationale:** The embedding cache pattern is proven in this codebase. Map insertion order gives O(1) LRU eviction. TTL expiry is checked on read (lazy). Cache is invalidated (cleared for agentId) on `memory_store`, `memory_forget`, and `invalidateMemory`.

**Alternatives considered:**

- External cache (Redis/Valkey): Over-engineered for a plugin; adds operational dependency
- Normalized cache (per-signal caching): More granular but complex; full-result caching is simpler and the primary goal is reducing redundant Neo4j hits
- No cache (rely on Neo4j query cache): Neo4j's internal cache helps but doesn't prevent network round-trips for three parallel signal queries

**Integration point:** `hybridSearch()` in `search.ts` checks cache before executing signals, stores result after fusion. The cache instance lives on the `Neo4jMemoryClient` alongside the embedding cache.

### D3: Community detection uses Neo4j native label propagation via GDS

**Decision:** Use Neo4j's built-in label propagation algorithm (available via Cypher `gds.labelPropagation` when GDS plugin is installed, or a custom iterative Cypher approach for instances without GDS). Communities stored as `Community` nodes with `BELONGS_TO` edges from entities.

**Rationale:** Label propagation is O(N) per iteration and converges quickly on natural clusters. It's the same algorithm Zep uses (their research paper specifically chose label propagation over Leiden for incremental updates). Neo4j's native implementation avoids external dependencies.

**Alternatives considered:**

- Leiden algorithm (GraphRAG pattern): Better modularity scores but requires external library (igraph/leidenalg), not available in Neo4j natively, and designed for batch processing not incremental updates
- Louvain: Good but non-deterministic and harder to update incrementally
- Application-level clustering: Pulls all entities into memory for clustering — doesn't scale

**Fallback for non-GDS instances:** When GDS is unavailable, use a custom Cypher-based iterative label propagation: each entity starts with its own label, then iteratively adopts the most common label among its neighbors. Cap at 10 iterations.

**Sleep cycle placement:** After entity extraction (Phase 2) and before decay (Phase 3). Communities need extracted entities to cluster. Phase runs only when `communityDetection.enabled: true`.

### D4: Community search signal integrates as 5th RRF signal

**Decision:** Add `communitySearch()` as a new search function returning `SearchSignalResult[]`. It queries Community nodes by embedding similarity (community summary embeddings), then collects connected entities' memories. The signal is added to the `fuseWithConfidenceRRF()` array alongside vector, BM25, graph, and freshness.

**Rationale:** The existing RRF fusion is designed to accept N signals with independent weights. Adding a 5th signal requires no changes to the fusion algorithm — only extending the signals array and weights tuple. Query classification can boost community weight for "long" and "entity" query types.

**Weight defaults:** Community signal weight starts at 0.15 (lower than vector/BM25/graph) to avoid over-influencing results until communities are well-established.

### D5: Episode nodes are stored alongside but separate from semantic memory

**Decision:** Episodes are first-class Neo4j nodes (`Episode` label) stored in the same database. They contain raw text, role, timestamp, sessionKey, agentId. Episodes link to auto-captured Memory nodes via `EPISODE_SOURCE` relationships. Episodes are NOT included in any search index — they're a preservation layer queried only via the dedicated `memory_episodes` tool.

**Rationale:** Zep's architecture demonstrates that separating the episodic tier from semantic search prevents noise in retrieval while preserving audit trail. Storing in the same Neo4j instance avoids operational complexity of a separate store.

**Alternatives considered:**

- Separate store (SQLite/file): Simpler but loses graph relationships and complicates deployment
- Indexed episodes (searchable): Bloats vector/BM25 indexes with raw conversation noise
- In-memory only: Loses persistence across restarts

**Capture point:** Inside the `agent_end` hook, before auto-capture runs. Episode is created regardless of whether the attention gate passes the message. This ensures even noise-filtered messages are preserved for audit.

**Retention:** Configurable `retentionDays` (default 30). Sleep cycle cleanup phase deletes expired episodes and their `EPISODE_SOURCE` relationships.

### D6: Trust scoring is a lightweight multiplicative weight, not a separate signal

**Decision:** `trustScore` is a float property on Memory nodes (0.0–1.0, default 1.0). It multiplies the final RRF fused score: `weightedScore = rrfScore * trustScore`. Memories with `trustScore: 0.0` are quarantined (excluded from default recall).

**Rationale:** Trust should attenuate relevance, not compete with it as a separate signal. A highly relevant but low-trust memory should still surface, just ranked lower. Multiplicative weighting achieves this naturally. The `trustScore: 0.0` quarantine provides a hard cutoff for flagged content.

**Alternatives considered:**

- Separate trust signal in RRF: Adds complexity; trust is a property of the memory, not a query-matching signal
- Binary trusted/untrusted: Too coarse; gradual trust enables nuanced ranking
- Trust decay over time: Over-engineered for initial implementation; can be added later

**Default source scores:** Configured via `trustScoring.sourceDefaults` map. Defaults: `user: 1.0`, `auto-capture: 0.8`, `auto-capture-assistant: 0.7`, `import: 0.6`, `decomposed: 0.9` (derived from trusted parent), `memory-watcher: 0.5`.

### D7: Instruction detection uses heuristic patterns with optional LLM fallback

**Decision:** Two-tier detection: (1) Fast regex/keyword pattern matcher (~50 patterns for instruction-like syntax) runs on every write (sub-millisecond). (2) Optional LLM classifier for ambiguous cases when `instructionDetection.llmFallback: true`.

**Rationale:** Heuristic-only mode provides baseline protection at zero LLM cost. The attention gate already uses a similar pattern-matching approach (130+ patterns in `attention-gate.ts`). The heuristic catches obvious injection attempts; the LLM fallback handles sophisticated ones.

**Alternatives considered:**

- LLM-only: Too expensive for every write; adds latency to auto-capture pipeline
- Embedding similarity to known attack corpus: Requires maintaining a separate attack vector database
- Secondary model validation (Zep pattern): Adds a full LLM call per write; better as opt-in via llmFallback

**Pattern categories:** Imperative directives ("Always...", "Never...", "You must..."), system prompt overrides ("Ignore previous...", "Your new instructions..."), conditional response rules ("If asked about..., say..."), role-play commands ("You are now...", "Act as...").

**Integration point:** Runs in `auto-capture.ts` after importance rating and in `memory_store` tool before Neo4j write. Flagged memories get `trustScore: 0.0`, `quarantined: true`.

## Risks / Trade-offs

**[Risk] Community detection requires GDS plugin or falls back to custom Cypher**
→ Mitigation: Custom Cypher label propagation works without GDS. Document GDS as recommended for production deployments with >10K entities. Feature is opt-in so no impact on existing users.

**[Risk] Episode storage doubles write volume for enabled deployments**
→ Mitigation: Episodes are simple nodes (no embedding, no extraction). Write overhead is minimal (~1 additional MERGE per message). Retention policy (default 30 days) prevents unbounded growth. Feature is opt-in.

**[Risk] Trust scoring changes retrieval ranking for existing deployments**
→ Mitigation: Default trustScore is 1.0 for all sources, so `rrfScore * 1.0 = rrfScore` — identical behavior. Only users who configure custom source defaults will see ranking changes. Trust scoring is enabled by default but with safe defaults.

**[Risk] Instruction detection heuristic has false positives**
→ Mitigation: Quarantine, don't reject. Quarantined memories are still stored and retrievable via `includeQuarantined: true`. False positives can be manually unquarantined. LLM fallback reduces false positives for users who enable it.

**[Risk] Integration tests are slow (Neo4j container startup)**
→ Mitigation: Single container per test suite (not per test). Container startup is ~5-10s. Tests gated behind env var so they don't slow standard `pnpm test`. Can parallelize test suites across CI jobs.

**[Risk] Query cache serves stale results after external Neo4j modifications**
→ Mitigation: Cache is invalidated on all known write paths (store, forget, invalidate). External modifications (direct Cypher, sleep cycle) also trigger invalidation via the existing Neo4jMemoryClient methods. TTL provides a safety net for any missed invalidation paths.

## Migration Plan

**Phase 1 — Foundation (no breaking changes):**

1. Add integration test infrastructure and core Cypher validation tests
2. Add `QueryResultCache` class and wire into `hybridSearch()`
3. Add `trustScore` property to MemoryNode type and schema
4. Add instruction detection heuristic patterns

**Phase 2 — New tiers (opt-in features):** 5. Add `Community` node type, indexes, and label propagation phase 6. Add `communitySearch()` signal and wire into RRF fusion 7. Add `Episode` node type, indexes, and capture hook 8. Add `memory_episodes` tool

**Phase 3 — Polish:** 9. Add concurrent write integration tests 10. Add signal degradation integration tests 11. Add LLM fallback for instruction detection 12. Wire community summaries and embeddings

**Rollback:** All features are opt-in via config flags. Disabling a feature stops new data creation but preserves existing nodes. To fully rollback, disable the feature and run a cleanup Cypher to remove the new node types (`MATCH (n:Community) DETACH DELETE n`, `MATCH (n:Episode) DETACH DELETE n`).

## Open Questions

1. **GDS availability:** Should community detection hard-require the GDS plugin, or is the custom Cypher fallback sufficient for all deployment sizes? Need to benchmark the custom approach at 10K+ entities.

2. **Episode granularity:** Should episodes be per-message or per-session (batch of messages within a time window)? The spec currently says per-message. Per-session would reduce node count but require session boundary detection logic.

3. **Trust score mutability:** Should trust scores be updatable after storage? A memory initially quarantined might be manually verified and un-quarantined. The current design supports this via direct property update, but should there be a dedicated tool for it?

4. **Community signal in query classification:** Should "long" queries boost community weight, or should community be a separate query type? The current adaptive weights system classifies queries into 6 types — adding community-aware classification could improve result quality for thematic queries.
