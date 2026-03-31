// One-off migration: Backfill relationshipCount for all Entity nodes.
//
// Root cause: relationshipCount was only updated during sleep-cycle reconciliation,
// which used a directed pattern (e)-[r]->(:Entity) that missed incoming relationships.
// Additionally, the write path (batchEntityOperations) never updated the counter
// when creating new inter-entity relationships.
//
// This migration sets the correct count using an undirected pattern to capture
// both incoming and outgoing entity-to-entity relationships, excluding
// infrastructure edge types (DERIVED_FROM).
//
// Run via Neo4j Browser, cypher-shell, or any Cypher client:

MATCH (e:Entity)
OPTIONAL MATCH (e)-[r]-(:Entity)
WHERE type(r) <> 'DERIVED_FROM'
WITH e, count(r) AS actual
WHERE e.relationshipCount IS NULL OR e.relationshipCount <> actual
SET e.relationshipCount = actual
RETURN count(e) AS entitiesUpdated;
