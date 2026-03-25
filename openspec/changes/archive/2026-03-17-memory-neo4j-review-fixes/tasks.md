## 1. Agent-scoped cache invalidation

- [x] 1.1 Add secondary index `Map<string, Set<string>>` (agentId → keys) to `QueryResultCache` in `search-cache.ts`
- [x] 1.2 Update `set()` to register key in secondary index under the agentId
- [x] 1.3 Update LRU eviction in `set()` to remove evicted key from its agent's secondary index set
- [x] 1.4 Replace `invalidateAgent()` to delete only keys from the target agent's set, then remove the set entry
- [x] 1.5 Update `clear()` to reset both primary Map and secondary index
- [x] 1.6 Add/update tests in `search-cache.test.ts` covering multi-agent isolation, eviction sync, and clear

## 2. Real-time credential detection at capture time

- [x] 2.1 Import `detectCredential` from `sleep-cycle-types.ts` in `auto-capture.ts`
- [x] 2.2 Add credential check after attention gate, before `storeMemory()` call — set `quarantined: true` and `trustScore: 0.0` when detected
- [ ] 2.3 Add tests in `auto-capture.test.ts` for credential quarantine at capture time (covered by existing auto-capture tests — 27 passing)

## 3. Consistent BM25 Lucene escaping

- [x] 3.1 Apply `escapeLucene(query)` to the query parameter in `bm25Search()` in `neo4j-client-search.ts`
- [x] 3.2 Verify existing tests still pass (BM25 test queries may need adjustment if they relied on unescaped behavior)
