## Context

The `EXTRACTED_FROM` provenance edge connects Entity nodes to their source Memory nodes. It was introduced in OP-142 to replace the old `MENTIONS` relationship. The canonical creation direction is `(Entity)-[:EXTRACTED_FROM]->(Memory)` — meaning "this entity was extracted from this memory."

The graph search query (`neo4j-client-search.ts:621`) and entity merge operations correctly follow this direction. However, 4 other query sites use the reversed direction, causing them to match zero relationships in Neo4j. This went undetected because all unit tests use mocked sessions that pattern-match on query substrings rather than executing real Cypher.

## Goals / Non-Goals

**Goals:**

- Fix all 6 reversed Cypher arrow directions across 4 files
- Restore community search, MPFP bridge, observation, and reflection query functionality
- Ensure test assertions reference the corrected direction strings

**Non-Goals:**

- Adding integration tests against a real Neo4j instance (separate effort)
- Changing the canonical relationship direction itself
- Refactoring EXTRACTED_FROM into a bidirectional pattern

## Decisions

**Decision 1: Fix query direction, not creation direction.**
The creation site (`neo4j-client-entity.ts:205`) uses `(Entity)-[:EXTRACTED_FROM]->(Memory)`, which semantically means "entity was extracted from memory." This is correct and consistent with the entity merge operations and the working graph search. The 4 broken query sites should be fixed to match, not the other way around.

**Decision 2: Use consistent Cypher idiom per context.**

- When querying from Memory perspective: `(mem:Memory)<-[:EXTRACTED_FROM]-(entity)` (incoming arrow)
- When querying from Entity perspective: `(e:Entity)-[:EXTRACTED_FROM]->(m:Memory)` (outgoing arrow)

Both are equivalent; choose whichever reads naturally for the query's starting node.

## Risks / Trade-offs

- **[Risk] Observations/opinions suddenly appear for agents with existing data** → Expected and desired. These features were silently non-functional; enabling them is the point of the fix.
- **[Risk] Community search returns results where it previously returned nothing** → Could surface low-quality results if community detection data is stale. Mitigated by existing score thresholds and the abstention classifier.
- **[Risk] Mocked tests still pass with wrong direction** → Low risk for this change since we're fixing to the correct direction, but flagged as a broader testing gap.
