## Why

The memory-neo4j sleep cycle has two scaling bottlenecks identified in code review: `findDuplicateClusters` issues O(N) individual vector queries (one per memory), and `findConflictingMemories` runs 200 vector sub-queries via a Cypher CALL subquery (N+1 pattern). Additionally, `vectorSearch` and `listCoreForInjection` lack final LIMIT clauses, producing unbounded result sets.

## What Changes

- Replace O(N) per-memory vector queries in `findDuplicateClusters` with a single batch Cypher query that uses UNWIND + vector index lookups in one statement
- Refactor `findConflictingMemories` to eliminate the N+1 sub-query pattern by pre-fetching candidate pairs with a batch approach
- Add LIMIT clause to `vectorSearch` after post-filtering (currently over-fetches but never caps the final result set)
- Add safety cap LIMIT to `listCoreForInjection` to prevent unbounded context injection

## Capabilities

### New Capabilities

- `batch-dedup-scan`: Batch vector deduplication scan replacing per-memory sequential queries

### Modified Capabilities

_(none — these are implementation-level performance improvements, not requirement changes)_

## Impact

- `extensions/memory-neo4j/neo4j-client-sleep.ts` — `findDuplicateClusters` rewrite
- `extensions/memory-neo4j/neo4j-client-sleep-conflict.ts` — `findConflictingMemories` refactor
- `extensions/memory-neo4j/neo4j-client-search.ts` — add LIMIT to `vectorSearch`
- `extensions/memory-neo4j/neo4j-client-memory.ts` — add LIMIT to `listCoreForInjection`
- Existing tests: `sleep-cycle.orchestrator.test.ts`, `search.test.ts` may need updates
