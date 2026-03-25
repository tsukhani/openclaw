## ADDED Requirements

### Requirement: Hybrid search results are cached with LRU eviction

The memory-neo4j extension SHALL maintain an in-memory LRU cache for hybrid search results. Cache entries SHALL be keyed by `(queryText, agentId)` and store the full result array (including scores and signal attribution). The cache SHALL have a configurable maximum size (default 200 entries) and evict least-recently-used entries when full.

#### Scenario: Identical query within TTL returns cached results

- **WHEN** `memory_recall` is called with query "project deadlines" for agent A
- **AND** the same query is called again within the TTL window
- **THEN** the second call SHALL return the cached result without hitting Neo4j indexes
- **AND** the result SHALL be identical to the first call's response

#### Scenario: Different agentId is a cache miss

- **WHEN** agent A calls `memory_recall` with query "project deadlines"
- **AND** agent B calls `memory_recall` with the same query text
- **THEN** agent B's call SHALL execute a fresh search (cache miss)
- **AND** both results SHALL be cached independently

#### Scenario: Cache evicts LRU entries at capacity

- **WHEN** the cache contains 200 entries (at default capacity)
- **AND** a new unique query is executed
- **THEN** the least-recently-used entry SHALL be evicted
- **AND** the new result SHALL be cached

### Requirement: Cache entries expire after configurable TTL

Cache entries SHALL have a configurable time-to-live (default 5 minutes). Expired entries SHALL be treated as cache misses and trigger a fresh search. The TTL SHALL be configurable via the `cache.ttlMs` config key.

#### Scenario: Entry expires after TTL

- **WHEN** a search result is cached at time T
- **AND** the same query is called at time T + 6 minutes (with default 5 min TTL)
- **THEN** the cached entry SHALL be treated as expired
- **AND** a fresh search SHALL be executed

#### Scenario: Custom TTL is respected

- **WHEN** `cache.ttlMs` is configured to 120000 (2 minutes)
- **AND** a cached query is repeated at T + 3 minutes
- **THEN** the cached entry SHALL be expired and a fresh search SHALL execute

### Requirement: Cache is invalidated on memory writes

The cache SHALL be invalidated (cleared for the affected agentId) when memories are stored, deleted, or invalidated for that agent. This prevents stale results after memory mutations.

#### Scenario: memory_store clears cache for the storing agent

- **WHEN** agent A has cached search results
- **AND** agent A stores a new memory via `memory_store`
- **THEN** all cache entries for agent A SHALL be invalidated
- **AND** agent B's cache entries SHALL remain unaffected

#### Scenario: memory_forget clears cache for the agent

- **WHEN** agent A has cached search results
- **AND** agent A deletes a memory via `memory_forget`
- **THEN** all cache entries for agent A SHALL be invalidated

### Requirement: Cache is disabled by default and configurable

The query result cache SHALL be disabled by default (`cache.enabled: false`). When disabled, all searches SHALL execute against Neo4j directly with no caching overhead. The cache SHALL be configurable via the `cache` config section.

#### Scenario: Cache disabled by default

- **WHEN** no `cache` config section is provided
- **THEN** every `memory_recall` call SHALL execute a fresh search
- **AND** no cache data structure SHALL be allocated

#### Scenario: Cache enabled via config

- **WHEN** `cache: { enabled: true, maxSize: 100, ttlMs: 300000 }` is configured
- **THEN** search results SHALL be cached with the specified parameters

### Requirement: Cache metrics are tracked

When the cache is enabled, the metrics collector SHALL track cache hit count, cache miss count, and cache invalidation count. These SHALL be available via the existing metrics reporting mechanism.

#### Scenario: Cache hit increments hit counter

- **WHEN** a search returns a cached result
- **THEN** the `cache_hits` metric SHALL increment by 1

#### Scenario: Cache miss increments miss counter

- **WHEN** a search executes a fresh query (cache miss or expired)
- **THEN** the `cache_misses` metric SHALL increment by 1
