## Why

The memory-neo4j extension scored B+ in a comprehensive code review cross-referenced against 6 major agentic memory systems (Mem0, Zep/Graphiti, LangMem, Letta/MemGPT, Neo4j Labs, Microsoft GraphRAG). Its retrieval sophistication (query-adaptive RRF, abstention classifier) is best-in-class, but it lacks integration test coverage, query-level caching, and three cognitive memory tiers that competitors offer. Closing these gaps would push the system to A/A+ grade — the most complete open-source agentic memory implementation available.

## What Changes

### Testing foundation (required for A grade)

- Add integration test suite that validates core Cypher queries against a real Neo4j instance (Docker in CI). Currently all 30 test files use mocked Neo4j — no query syntax, index behavior, or constraint enforcement is validated.
- Add concurrent write tests verifying multi-agent scenarios: two agents storing memories mentioning the same entity simultaneously, MENTIONS count consistency, entity merge under contention.
- Add signal degradation tests: vector search succeeds but BM25 times out, graph search returns empty — verify graceful partial results.

### Performance (required for A grade)

- Add LRU query result cache for hybrid recall results, keyed by `(query, agentId)` with configurable TTL (default 5 min). Currently every `memory_recall` hits all three Neo4j indexes fresh.
- Wire CLI sleep-cycle abort signal (OP-95): pass AbortController to `runSleepCycle` when triggered from CLI, so service stop can interrupt a mid-cycle run cleanly.

### Cognitive architecture (required for A+ grade)

- Add community detection and summarization layer. Cluster strongly-connected entities using label propagation, generate LLM summaries per community. Enables global queries ("What do I know about project X?") that neither entity traversal nor vector search handle well. Inspired by Zep's community subgraph and GraphRAG's Leiden communities.
- Add episodic memory tier: non-lossy storage of raw conversation segments as Episode nodes linked to extracted Memory nodes via DERIVED_FROM. Preserves full context for replay and audit without bloating semantic search results.
- Add memory source trust scoring: extend the existing `source` field with a numeric `trustScore` (0.0-1.0) that weights retrieval ranking. System-stored memories get 1.0; auto-captured from untrusted channels get lower scores. Defends against memory poisoning attacks (MINJA, NeurIPS 2025).
- Add instruction-pattern detection on writes: lightweight classifier that flags memories containing instruction-like patterns ("When asked about X, always respond with Y") before storage. Flagged memories are quarantined for review rather than silently entering the retrieval pool.

## Capabilities

### New Capabilities

- `integration-tests`: Integration test suite validating Cypher queries, indexes, constraints, and concurrent writes against real Neo4j (Docker). Includes signal degradation and multi-agent contention scenarios.
- `query-result-cache`: LRU cache for hybrid search results with configurable TTL, keyed by query text + agentId. Reduces redundant index hits for repeated or similar recalls within a session.
- `community-detection`: Entity community detection via label propagation, with LLM-generated community summaries stored as CommunityNode. Adds a community-aware search signal to the existing RRF pipeline.
- `episodic-memory`: Non-lossy episode storage tier preserving raw conversation segments as Episode nodes. Episodes link to extracted semantic Memory nodes but remain separate from the main search index.
- `trust-scoring`: Memory source trust scoring with numeric trustScore field, trust-weighted retrieval ranking, and configurable per-source trust defaults.
- `instruction-detection`: Write-time instruction-pattern detection that quarantines memories containing behavioral directives before they enter the retrieval pool.

### Modified Capabilities

- `autocapture-quality-gates`: The instruction-detection gate adds a new pre-storage check to the autocapture pipeline. Memories flagged as instruction-like are stored with `trustScore: 0.0` and `quarantined: true` instead of being silently captured.

## Impact

- **Code**: `extensions/memory-neo4j/` — new files for community detection, episodic storage, trust scoring, instruction detection, query cache. Modified files: `search.ts` (cache layer + community signal), `schema.ts` (Episode/Community node types, trustScore field), `config.ts` (cache/trust/community config sections), `neo4j-client-indexes.ts` (community + episode indexes), `auto-capture.ts` (instruction gate), `neo4j-client-search.ts` (trust-weighted scoring, community search signal), `plugin-hooks.ts` (episode capture hook).
- **Graph schema**: New node labels `Episode` and `Community`. New relationship types `BELONGS_TO` (Entity→Community), `EPISODE_SOURCE` (Memory→Episode). New property `trustScore` on Memory nodes.
- **Dependencies**: No new runtime deps expected. Test infra needs `testcontainers` or Docker Compose for Neo4j integration tests.
- **Config**: New config sections for `cache`, `trustScoring`, `communityDetection`, `episodicMemory`, `instructionDetection`. All optional with sensible defaults (disabled by default for community/episodic to avoid breaking existing deployments).
- **Migration**: Existing deployments need no migration — new node types and properties are additive. `trustScore` defaults to `1.0` for existing memories (trusted).
