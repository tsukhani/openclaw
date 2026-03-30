## Why

The `EXTRACTED_FROM` relationship in memory-neo4j is created with direction `(Entity)-[:EXTRACTED_FROM]->(Memory)` (entity was extracted from memory), but 4 query sites use the reversed direction. This causes community search, MPFP bridge, observation queries, and reflection candidates to silently return zero results against real Neo4j data. The bug is masked by mocked unit tests that pattern-match on query strings rather than executing against a real graph.

## What Changes

- Fix Cypher arrow direction in community search (`neo4j-client-search.ts:270`) so it matches the canonical `(Entity)-[:EXTRACTED_FROM]->(Memory)` direction
- Fix Cypher arrow direction in MPFP entity-to-memory bridge (`mpfp-search.ts:181`)
- Fix Cypher arrow direction in 3 observation queries (`neo4j-client-observation.ts:47,116,141`)
- Fix Cypher arrow direction in reflection candidate query (`sleep-phases-reflect.ts:198`)
- Update existing unit tests to verify the corrected query direction strings

## Capabilities

### New Capabilities

_(none — this is a bug fix, not a new capability)_

### Modified Capabilities

_(no existing specs to modify)_

## Impact

- **Code**: 4 source files in `extensions/memory-neo4j/` (6 query sites total)
- **Signals affected**: community search signal, MPFP signal, observation signal — all currently non-functional; will begin returning results after fix
- **Sleep phases affected**: phase 11 (observations) and phase 12 (opinions/beliefs) — currently generating nothing; will begin producing summaries
- **Risk**: Low — the fix restores intended behavior; the current state is already broken. Correct direction is well-established by the creation site and the working graph search query.
