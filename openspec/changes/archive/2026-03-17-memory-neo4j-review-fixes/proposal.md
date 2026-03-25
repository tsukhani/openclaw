## Why

The memory-neo4j code review identified 3 high-priority issues that weaken cache efficiency, leave a credential-exposure window, and introduce an inconsistency in Lucene query escaping. Addressing these closes the gaps before broader adoption.

## What Changes

- **Agent-scoped cache invalidation**: Replace the full-cache-clear approach in `invalidateAgent()` with a secondary index (`agentId → Set<key>`) so that writes for agent A do not evict agent B's cached results.
- **Real-time credential detection at capture time**: Add a `detectCredential()` check in the auto-capture pipeline (Layer 2) so that leaked API keys, tokens, and passwords are quarantined immediately on ingest — not only during the deferred sleep consolidation cycle.
- **Consistent BM25 Lucene escaping**: Apply `escapeLucene()` to the query passed into `bm25Search()`, matching the escaping already applied in `communitySearch()`, to prevent Lucene special-character errors.

## Capabilities

### New Capabilities

_(none — all changes modify existing capabilities)_

### Modified Capabilities

- `query-result-cache`: Agent-scoped invalidation replaces full cache clear; new spec scenario for multi-agent write isolation.
- `autocapture-quality-gates`: Real-time credential detection added at capture time before storage.

## Impact

- `extensions/memory-neo4j/search-cache.ts` — secondary index for agent-scoped invalidation
- `extensions/memory-neo4j/auto-capture.ts` — credential check before store
- `extensions/memory-neo4j/neo4j-client-search.ts` — escapeLucene on BM25 query
- Tests: `search-cache.test.ts`, `auto-capture.test.ts`, `search.test.ts` or `neo4j-client.test.ts`
