## Context

The memory-neo4j extension has two conflicting data models:

1. **Legacy (pre-OP-142):** Entities are secondary — `(:Memory)-[:MENTIONS]->(:Entity)` is the authoritative link. Entity lifecycle, scoring, and agent scoping all derive from MENTIONS.
2. **OP-142 (current):** Entities are first-class. `structuredGraphSearch` traverses entity-entity relationships (WORKS_AT, MARRIED_TO) without Memory nodes. But MENTIONS still controls entity lifecycle, causing the sleep cycle to destroy the entity graph.

MENTIONS is used in ~15 code locations across 8 files. The relationship is always `Memory → Entity` (never Memory→Memory or Entity→Entity). It serves: provenance, agent scoping, conflict detection, and mentionCount scoring.

## Goals / Non-Goals

**Goals:**

- Entity nodes are fully independent of Memory nodes for lifecycle and scoring
- Entity agent scoping uses a property on the Entity node, not MENTIONS traversal
- Conflict detection works without MENTIONS (embedding similarity on memories)
- Sleep cycle never destroys entities that have entity-entity relationships
- Existing graphs continue working (no destructive migration)

**Non-Goals:**

- Removing MENTIONS edges from existing graphs (harmless, just ignored)
- Changing the search API or CLI interfaces
- Refactoring the extraction pipeline LLM prompts
- Modifying how entity-entity relationships are created (WORKS_AT, etc.)

## Decisions

### D1: Add `agentId` property to Entity nodes (not a separate relationship)

A property is simpler than `(:Entity)-[:BELONGS_TO]->(:Agent)` and avoids adding another relationship type. Entities already have `firstSeen`, `lastSeen`, `type` etc. — `agentId` fits the same pattern.

**Trade-off:** An entity extracted by multiple agents would need the first agent's ID, or an `agentIds` array. Since entities are MERGED by name, concurrent agents could overwrite. Decision: use the first-seen agent's ID (ON CREATE SET only, not ON MATCH). Multi-agent scoping can use `agentIds` array later if needed, but current deployment is single-agent.

### D2: Replace conflict detection with embedding similarity (not entity co-occurrence)

Current: `(m1)-[:MENTIONS]->(e)<-[:MENTIONS]-(m2)` finds memory pairs sharing entities.
New: Use existing `findSimilar()` vector search to find memory pairs with high embedding similarity. This is already how semantic dedup works — conflict detection can use the same mechanism with a different similarity threshold.

**Alternative considered:** Text search for entity names in memory content. Rejected — embedding similarity is more robust and already implemented.

### D3: Remove mentionCount entirely, keep relationshipCount

`mentionCount` is used for entity dedup priority (keep entity with more mentions). With MENTIONS gone, this property has no data source. `relationshipCount` (already added in previous fix) replaces it for graph importance scoring. Entity dedup priority falls back to `relationshipCount` or name length.

### D4: Backfill agentId via one-time migration query

```cypher
MATCH (m:Memory)-[:MENTIONS]->(e:Entity)
WHERE e.agentId IS NULL AND m.agentId IS NOT NULL
WITH e, collect(DISTINCT m.agentId)[0] AS firstAgent
SET e.agentId = firstAgent
```

Run during `ensureInitialized()` index migration, same pattern as existing temporal field migrations.

### D5: Phased implementation order

1. **Phase A:** Add `agentId` to Entity nodes + migration backfill + index
2. **Phase B:** Replace MENTIONS-dependent agent scoping in search/community with `agentId` property
3. **Phase C:** Replace conflict detection with embedding similarity
4. **Phase D:** Remove MENTIONS creation from extraction pipeline
5. **Phase E:** Remove all MENTIONS transfer/decrement/reconciliation code
6. **Phase F:** Clean up tests

Phases A-B can be deployed independently (MENTIONS still created but no longer relied on). Phase D is the breaking change — after this, new entities have no MENTIONS.

## Risks / Trade-offs

- **[Risk] Multi-agent entity ownership** — An entity MERGED by agent-B after agent-A created it won't update `agentId`. → Mitigation: ON CREATE SET only. Multi-agent arrays are a future enhancement; current deployment is single-agent.
- **[Risk] Conflict detection quality change** — Embedding similarity may find different pairs than entity co-occurrence. → Mitigation: Embedding similarity is strictly more general (catches conflicts even without shared entities). Quality should improve.
- **[Risk] Reclassification context retrieval** — Currently uses `(:Memory)-[:MENTIONS]->(e)` to get sample texts. → Mitigation: Replace with fulltext search on Memory.text matching entity name. Slightly less precise but adequate for LLM context.
- **[Risk] Stale MENTIONS edges in existing graphs** — Old edges remain but are ignored. → Mitigation: Harmless. Can be cleaned up with a manual Cypher query if desired.
