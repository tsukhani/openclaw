## 1. Add agentId to Entity nodes

- [x] 1.1 Add `agentId` to Entity MERGE in `batchEntityOperations` (ON CREATE SET only) — `neo4j-client-entity.ts`
- [x] 1.2 Add property index on `Entity.agentId` in `neo4j-client-indexes.ts`
- [x] 1.3 Add one-time migration to backfill `agentId` from MENTIONS — `neo4j-client-sleep-conflict.ts` (migrateEntityAgentId)
- [x] 1.4 Pass `agentId` through extraction pipeline to `batchEntityOperations` — reads from Memory node in-query

## 2. Replace MENTIONS-based agent scoping

- [x] 2.1 Replace fulltext seed filter in `structuredGraphSearch` with `node.agentId = $agentId` — `neo4j-client-search.ts`
- [x] 2.2 Replace fulltext seed filter in `causalChainSearch` with `node.agentId = $agentId` — `neo4j-client-search.ts`
- [x] 2.3 Replace MENTIONS-based entity loading in `runLabelPropagation` with `e.agentId = $agentId` — `neo4j-client-community.ts`
- [x] 2.4 Replace MENTIONS-based community listing in `getCommunitiesForAgent` with `agentId` property — `neo4j-client-community.ts`
- [x] 2.5 Replace MENTIONS-based scoping in `findDuplicateEntityPairs` with `e1.agentId = $agentId` — `neo4j-client-entity.ts`
- [x] 2.6 Replace MENTIONS-based stats in `getEntityGraphStats` with `agentId` property + `relationshipCount` — `neo4j-client-entity.ts`

## 3. Replace conflict detection

- [x] 3.1 Replace `findConflictingMemories` shared-entity MENTIONS query with embedding similarity — `neo4j-client-sleep-conflict.ts`

## 4. Replace reclassification context retrieval

- [x] 4.1 Replace MENTIONS traversal in `listConceptsForReclassification` with fulltext search on Memory.text — `neo4j-client-entity.ts`
- [x] 4.2 Replace MENTIONS traversal in `listRelationshipsForReclassification` with fulltext search — `neo4j-client-entity.ts`

## 5. Remove MENTIONS creation

- [x] 5.1 Remove MENTIONS creation query from `batchEntityOperations` — `neo4j-client-entity.ts`
- [x] 5.2 Update `extractor.ts` docstring (step 3 no longer applies)

## 6. Remove MENTIONS transfer and mentionCount

- [x] 6.1 Remove MENTIONS transfer from `mergeMemoryCluster` — `neo4j-client-sleep.ts`
- [x] 6.2 Remove MENTIONS transfer from `mergeEntityPair` — `neo4j-client-entity.ts`
- [x] 6.3 Remove MENTIONS transfer from `batchMergeEntityPairs` — `neo4j-client-entity.ts`
- [x] 6.4 Remove `mentionCount = 1` from entity ON CREATE in `batchEntityOperations` — `neo4j-client-entity.ts`
- [x] 6.5 Remove mentionCount decrement from `deleteMemory` — `neo4j-client-memory.ts`
- [x] 6.6 Remove mentionCount decrement from `pruneMemories` — `neo4j-client-sleep-decay.ts`
- [x] 6.7 Remove mentionCount decrement from `deleteMemoriesByIds` — `neo4j-client-memory.ts`
- [x] 6.8 Remove `reconcileEntityMentionCounts` function — `neo4j-client-entity.ts`
- [x] 6.9 Remove `reconcileEntityMentionCounts` from facade — `neo4j-client.ts`
- [x] 6.10 Remove `reconcileEntityMentionCounts` call from sleep Phase 1d — `sleep-phases-dedup.ts`
- [x] 6.11 Update `findDuplicateEntityPairs` to use `relationshipCount` instead of `mentionCount` for dedup priority — `neo4j-client-entity.ts`
- [x] 6.12 Update `batchMergeEntityPairs` to reconcile `relationshipCount` instead of `mentionCount` — `neo4j-client-entity.ts`

## 7. Simplify orphan detection and relationship expiry

- [x] 7.1 Simplify `findOrphanEntities` — remove MENTIONS check, keep only entity-entity relationship check — `neo4j-client-sleep.ts`
- [x] 7.2 Simplify `expireOrphanedEntityRelationships` — remove MENTIONS references from orphan endpoint check — `neo4j-client-sleep-conflict.ts`

## 8. Clean up N-hop traversal

- [x] 8.1 Update MENTIONS in exclusion list comment in `structuredGraphSearch` N-hop traversal — `neo4j-client-search.ts` (kept for legacy graph compat)

## 9. Remove MENTIONS from memory deletion paths

- [x] 9.1 Remove MENTIONS-related cleanup from `deleteMemory` — `neo4j-client-memory.ts`
- [x] 9.2 Remove MENTIONS-related cleanup from `deleteMemoriesByIds` — `neo4j-client-memory.ts`
- [x] 9.3 Replace `listMemoriesWithManyEntities` MENTIONS-based query with text length heuristic — `neo4j-client-entity.ts`

## 10. Update tests

- [x] 10.1 Update `sleep-cycle.orchestrator.test.ts` — remove `reconcileEntityMentionCounts` mock, update orphan tests
- [x] 10.2 Update `temporal.test.ts` — update `expireOrphanedEntityRelationships` tests
- [x] 10.3 Update `neo4j-client.test.ts` — remove MENTIONS transfer/decrement assertions
- [x] 10.4 Update `neo4j-client.entity-dedup.test.ts` — remove MENTIONS transfer tests, update mentionCount → relationshipCount
- [x] 10.5 Update `auto-sleep.test.ts` — remove `reconcileEntityMentionCounts` mock
- [x] 10.6 Update `sleep-cycle.credential-scan.test.ts` — remove `reconcileEntityMentionCounts` mock
- [ ] 10.7 Update `neo4j-integration.test.ts` — remove MENTIONS setup/assertions (deferred: integration tests use real Neo4j)
- [ ] 10.8 Update `extractor.test.ts` — remove MENTIONS transfer assertions (deferred: no test failures)
- [x] 10.9 Run full `extensions/memory-neo4j/` test suite — 38 files, 1138 tests pass, 0 failures
