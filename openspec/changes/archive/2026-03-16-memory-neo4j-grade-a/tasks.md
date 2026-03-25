## 1. Schema & Type Foundation

- [x] 1.1 Add `trustScore` (float, default 1.0) and `quarantined` (boolean, default false) properties to `MemoryNode` type in `schema.ts`
- [x] 1.2 Add `EpisodeNode` type to `schema.ts` with properties: id, text, role, timestamp, sessionKey, agentId
- [x] 1.3 Add `CommunityNode` type to `schema.ts` with properties: id, name, summary, entityCount, embedding, createdAt, updatedAt
- [x] 1.4 Add `EPISODE_SOURCE` and `BELONGS_TO` relationship type constants to `schema.ts`
- [x] 1.5 Add config type sections for `cache`, `trustScoring`, `communityDetection`, `episodicMemory`, `instructionDetection` in `config.ts`
- [x] 1.6 Add config parsing and validation for all new sections with defaults in `config.ts`

## 2. Trust Scoring

- [x] 2.1 Set `trustScore` from `trustScoring.sourceDefaults` map during `storeMemory()` and `storeManyMemories()` in `neo4j-client-memory.ts`
- [x] 2.2 Apply `trustScore` multiplicative weight to final RRF fused score in `fuseWithConfidenceRRF()` in `search.ts`
- [x] 2.3 Add `WHERE m.trustScore > 0` filter to vector, BM25, and graph search queries (exclude quarantined by default)
- [x] 2.4 Add `includeQuarantined` parameter to `memory_recall` tool in `plugin-tools.ts` that bypasses the trustScore > 0 filter (wired into search options)
- [x] 2.5 Write unit tests for trust score assignment per source type
- [x] 2.6 Write unit tests for trust-weighted RRF ranking and quarantine exclusion

## 3. Instruction Detection

- [x] 3.1 Create `instruction-detector.ts` with heuristic pattern matcher (~50 regex patterns for instruction-like syntax)
- [x] 3.2 Add pattern categories: imperative directives, system prompt overrides, conditional response rules, role-play commands
- [x] 3.3 Wire heuristic check into `auto-capture.ts` after importance rating, before Neo4j storage — set `trustScore: 0.0` and `quarantined: true` on flagged memories
- [x] 3.4 Wire heuristic check into `memory_store` tool in `plugin-tools.ts` — quarantine flagged memories and return quarantine status in response
- [x] 3.5 Add optional LLM fallback classifier invoked when `instructionDetection.llmFallback: true` for ambiguous cases
- [x] 3.6 Write unit tests for heuristic patterns (true positives: directives, overrides; true negatives: facts, preferences)
- [x] 3.7 Write unit tests for quarantine flow in auto-capture and memory_store paths

## 4. Query Result Cache

- [x] 4.1 Create `search-cache.ts` with `QueryResultCache` class following `EmbeddingCache` LRU pattern (Map-based, MD5 key hashing, TTL expiry)
- [x] 4.2 Wire cache check before signal execution in `hybridSearch()` in `search.ts` — return cached result on hit
- [x] 4.3 Wire cache store after RRF fusion in `hybridSearch()` — cache fused results
- [x] 4.4 Add cache invalidation (clear for agentId) in `storeMemory()`, `deleteMemory()`, and `invalidateMemory()` paths
- [x] 4.5 Add cache metrics (hits, misses, invalidations) to `metrics.ts`
- [x] 4.6 Write unit tests for cache hit/miss/eviction/expiry/invalidation behavior

## 5. Episodic Memory

- [x] 5.1 Add Episode uniqueness constraint and agentId property index to `neo4j-client-indexes.ts`
- [x] 5.2 Create `neo4j-client-episode.ts` with `mergeEpisode()`, `linkMemoryToEpisode()`, `queryEpisodes()`, and `deleteExpiredEpisodes()` methods
- [x] 5.3 Wire episode capture into `agent_end` hook in `plugin-hooks.ts` — create Episode node for each message when `episodicMemory.enabled`, before auto-capture runs
- [x] 5.4 Link auto-captured Memory nodes to their source Episode via `EPISODE_SOURCE` relationship in `auto-capture.ts`
- [x] 5.5 Register `memory_episodes` tool in `plugin-tools.ts` with sessionKey, agentId, and from/to time range filters
- [x] 5.6 Add episode retention cleanup (delete episodes older than `retentionDays`) to sleep cycle cleanup phase in `sleep-phases-cleanup.ts`
- [x] 5.7 Write unit tests for episode CRUD, linking, time-range queries, and retention cleanup

## 6. Community Detection

- [x] 6.1 Add Community uniqueness constraint, fulltext index, and embedding vector index to `neo4j-client-indexes.ts`
- [x] 6.2 Create `neo4j-client-community.ts` with `runLabelPropagation()` (custom Cypher iterative approach), `mergeCommunity()`, `linkEntityToCommunity()`, `getCommunities()`
- [x] 6.3 Create `sleep-phases-community.ts` implementing the community detection sleep phase: fetch entity graph, run label propagation, create/update Community nodes, link via BELONGS_TO
- [x] 6.4 Generate LLM summaries for new/changed communities and embed summaries for community-level vector search
- [x] 6.5 Wire community detection phase into `sleep-cycle.ts` after entity extraction (Phase 2), gated by `communityDetection.enabled`
- [x] 6.6 Add `communitySearch()` function to `neo4j-client-search.ts` — query Community embeddings, expand to member entities, collect connected memories
- [x] 6.7 Wire community signal as 5th signal into `hybridSearch()` in `search.ts` — add to `fuseWithConfidenceRRF()` signals array and adaptive weights
- [x] 6.8 Update `getAdaptiveWeights()` to include community weight (boost for "long" and "entity" query types)
- [x] 6.9 Write unit tests for label propagation clustering, community CRUD, and community search signal

## 7. Integration Tests

- [x] 7.1 Add testcontainers (or Docker-based Neo4j provisioning) as dev dependency and create test infrastructure in `neo4j-integration.test.ts`
- [x] 7.2 Add setup/teardown helpers: start Neo4j container, run `ensureIndexes()`, clean database between describe blocks
- [x] 7.3 Gate all integration tests behind `MEMORY_NEO4J_INTEGRATION=1` environment variable
- [x] 7.4 Write integration tests for memory CRUD: store, retrieve, delete, MERGE idempotency, uniqueness constraints
- [x] 7.5 Write integration tests for vector search: store memories with known embeddings, verify similarity ordering and score ranges
- [x] 7.6 Write integration tests for BM25 search: store memories with distinct keywords, verify keyword matching and Lucene escaping
- [x] 7.7 Write integration tests for graph traversal: create entity chain (A→B→C), verify multi-hop discovery with decay scoring
- [x] 7.8 Write integration tests for entity batch operations: create entities + relationships + tags atomically, verify rollback on failure
- [x] 7.9 Write integration tests for concurrent writes: two parallel `storeMemory()` calls mentioning the same entity, verify MENTIONS count consistency
- [x] 7.10 Write integration tests for signal degradation: mock one signal to throw, verify remaining signals produce valid results
- [x] 7.11 Write integration tests for index readiness: verify all indexes reach ONLINE state after `ensureIndexes()`

## 8. CI & Documentation

- [x] 8.1 Add `MEMORY_NEO4J_INTEGRATION=1` test job to CI pipeline with Docker service for Neo4j
- [x] 8.2 Add config documentation for all new sections (cache, trustScoring, communityDetection, episodicMemory, instructionDetection) with defaults and examples
