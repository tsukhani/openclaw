## Why

The memory-neo4j code review identified 4 medium-severity issues that expose a ReDoS vector, degrade write throughput under entity-heavy workloads, leave a contradiction window between sleep cycles, and rely on fragile string matching for connection error classification. Fixing these hardens the extension before broader adoption.

## What Changes

- **Regex DoS guard in deleteMemoriesByPattern**: Add structural complexity checks (nested quantifier detection, alternation depth) beyond the existing 200-char length cap to block pathological patterns before they reach Neo4j's regex engine.
- **Batched entity property writes**: Replace the per-entity `tx.run()` loop in `batchEntityOperations()` with a single UNWIND-based Cypher query that sets properties for all entities in one server round-trip.
- **Inline contradiction check at auto-capture**: Extend the existing 0.75-0.95 semantic dedup band in `captureMessage()` to also detect contradictions (not just paraphrases), quarantining or superseding conflicting memories at ingest time rather than waiting for the sleep cycle.
- **Robust connection error classification**: Refactor `isNeo4jConnectionError()` to prefer error `code` properties and OS-level `errno`/`code` fields over string-matching error messages.

## Capabilities

### New Capabilities

_(none -- all changes modify existing capabilities)_

### Modified Capabilities

- `autocapture-quality-gates`: Inline contradiction detection added to the dedup band, extending the existing semantic dedup check.

## Impact

- `extensions/memory-neo4j/neo4j-client-memory.ts` -- regex complexity guard in `deleteMemoriesByPattern()`
- `extensions/memory-neo4j/neo4j-client-entity.ts` -- UNWIND-based entity property writes in `batchEntityOperations()`
- `extensions/memory-neo4j/auto-capture.ts` -- inline contradiction check in `captureMessage()`
- `extensions/memory-neo4j/extractor.ts` -- new or extended contradiction detection function
- `extensions/memory-neo4j/errors.ts` -- code-based connection error classification
- Tests: `auto-capture.test.ts`, `neo4j-client.entity-dedup.test.ts`, corresponding unit tests
