## Why

The `(:Memory)-[:MENTIONS]->(:Entity)` relationship is a legacy artifact from before OP-142, when entities were secondary enrichment on memories. OP-142 made entities first-class: `structuredGraphSearch` traverses entity-entity relationships (WORKS_AT, MARRIED_TO, etc.) without needing Memory nodes. But MENTIONS still controls entity lifecycle — orphan detection, relationship expiry, mentionCount scoring, agent scoping — causing the sleep cycle to destroy the entity graph every cycle by deleting entities that have rich graph connections but no backing MENTIONS.

## What Changes

- **BREAKING**: Remove creation of `(:Memory)-[:MENTIONS]->(:Entity)` relationships during entity extraction. Entities become fully independent of Memory nodes.
- Add `agentId` property to Entity nodes during extraction (replaces MENTIONS-based agent scoping).
- Replace conflict detection's shared-entity-via-MENTIONS traversal with embedding similarity on Memory nodes directly.
- Replace reclassification context retrieval (sample memories for an entity) with text search matching entity name.
- Remove all MENTIONS transfer logic from memory merge and entity merge operations.
- Remove mentionCount property and all increment/decrement/reconciliation code. `relationshipCount` (already added) becomes the primary entity importance metric.
- Remove MENTIONS-dependent code from `findOrphanEntities`, `expireOrphanedEntityRelationships`, `findDuplicateEntityPairs`, `communitySearch`, `getEntityGraphStats`.
- Clean up `structuredGraphSearch` and `causalChainSearch` fulltext seed filters that fall back to MENTIONS for agent scoping — use `agentId` property instead.

## Capabilities

### New Capabilities

- `entity-agent-scoping`: Entity nodes carry their own `agentId` property, replacing MENTIONS-based agent filtering in search, community detection, and dedup.
- `entity-lifecycle-independence`: Entity creation, orphan detection, relationship expiry, and scoring operate purely on entity-entity relationships and entity properties — no dependency on Memory nodes or MENTIONS edges.

### Modified Capabilities

- `community-detection`: Agent scoping switches from `(:Memory {agentId})-[:MENTIONS]->(entity)` to `entity.agentId = $agentId`.

## Impact

- **Files (production):**
  - `neo4j-client-entity.ts` — Remove MENTIONS creation from `batchEntityOperations`, remove `mergeEntityPair` MENTIONS transfer, remove `reconcileEntityMentionCounts`, remove `mentionCount` from entity MERGE, remove MENTIONS-based scoping from `findDuplicateEntityPairs`, add `agentId` to entity MERGE, update `getEntityGraphStats`
  - `neo4j-client-sleep.ts` — Remove MENTIONS transfer from `mergeMemoryCluster`, simplify `findOrphanEntities` (already partially done), remove mentionCount decrement from `deleteMemory`/`pruneMemories`
  - `neo4j-client-sleep-conflict.ts` — Replace `findConflictingMemories` shared-entity query with embedding similarity, simplify `expireOrphanedEntityRelationships` (already partially done)
  - `neo4j-client-sleep-decay.ts` — Remove mentionCount decrement from decay pruning
  - `neo4j-client-search.ts` — Replace MENTIONS-based agent filter in fulltext seed with `node.agentId`, remove MENTIONS from exclusion list in N-hop traversal (no longer exists)
  - `neo4j-client-community.ts` — Replace MENTIONS-based agent scoping with `agentId` property
  - `neo4j-client-memory.ts` — Remove MENTIONS-related cleanup from memory deletion
  - `neo4j-client-indexes.ts` — Add index on `Entity.agentId`
  - `neo4j-client.ts` — Update facade methods, remove `reconcileEntityMentionCounts`
  - `sleep-phases-dedup.ts` — Remove mentionCount reconciliation call
  - `sleep-phases-cleanup.ts` — Already updated, minor cleanup
  - `extractor.ts` — Update docstring (step 3 "Create MENTIONS" no longer applies)
- **Files (tests):** All test files mocking MENTIONS-related methods need updates (~10 files)
- **Migration:** Existing graphs retain MENTIONS edges (harmless, ignored). New extractions stop creating them. No destructive migration needed — existing `agentId` can be backfilled from `(:Memory {agentId})-[:MENTIONS]->(e)` in a one-time migration query.
- **No external API changes.** Search, store, and CLI interfaces are unaffected.
