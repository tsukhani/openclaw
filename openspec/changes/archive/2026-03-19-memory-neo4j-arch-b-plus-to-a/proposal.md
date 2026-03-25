## Why

The memory-neo4j extension has three architecture concerns identified in code review: retry logic is duplicated across 3 modules with inconsistent backoff strategies (some use jitter, some don't), the `isNeo4jConnectionError` catch-and-return pattern is copy-pasted 7 times in `plugin-tools.ts`, and `neo4j-client.ts` is a 938 LOC God facade with ~60 methods that mostly delegate 1:1 to sub-modules.

## What Changes

- Extract a shared `retryWithBackoff` utility from the 3 existing implementations (`neo4j-client.ts` `retryOnTransient`, `extractor.ts` `withRetry`, `embeddings.ts` inline retry loops) with consistent jitter and abort signal support
- Extract a `withConnectionErrorHandling` wrapper to replace the 7 copy-pasted `isNeo4jConnectionError` catch blocks in `plugin-tools.ts`
- Refactor `neo4j-client.ts` from a flat class with ~60 methods into a facade with grouped sub-objects (`db.memory.*`, `db.search.*`, `db.entity.*`, `db.sleep.*`) that expose the sub-module methods through the session/retry infrastructure

## Capabilities

### New Capabilities

- `shared-retry-utility`: Shared retry-with-backoff utility with consistent jitter, abort support, and transient error classification

### Modified Capabilities

_(none — these are internal architecture refactors with no behavioral changes)_

## Impact

- New file: `extensions/memory-neo4j/retry.ts` — shared retry utility
- `extensions/memory-neo4j/neo4j-client.ts` — facade refactor (major restructure)
- `extensions/memory-neo4j/plugin-tools.ts` — extract connection error wrapper
- `extensions/memory-neo4j/extractor.ts` — replace `withRetry` with shared utility
- `extensions/memory-neo4j/embeddings.ts` — replace inline retry loops with shared utility
- All callers of `Neo4jMemoryClient` methods — update to use sub-object access pattern if public API changes
- All existing tests — verify no behavioral regressions
