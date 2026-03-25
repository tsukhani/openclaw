## 1. Batch Dedup Scan

- [x] 1.1 Rewrite `findDuplicateClusters` in `neo4j-client-sleep.ts` to use a single batch Cypher statement per chunk (500 memories) with UNWIND + CALL subquery, replacing per-memory network round-trips
- [x] 1.2 Preserve union-find clustering logic and 2000-pair safety cap
- [x] 1.3 Update `sleep-cycle.orchestrator.test.ts` and any dedup tests to verify batch behavior produces identical clusters

## 2. LIMIT Clauses

- [x] 2.1 Add `LIMIT $requestedLimit` to `vectorSearch` in `neo4j-client-search.ts` after the ORDER BY clause
- [x] 2.2 Add `LIMIT 200` safety cap to `listCoreForInjection` in `neo4j-client-memory.ts` with a warning log when cap is reached
- [x] 2.3 Update search tests to verify LIMIT is applied after post-filtering

## 3. Verification

- [x] 3.1 Run `pnpm test -- extensions/memory-neo4j/` to verify no regressions
- [x] 3.2 Run `pnpm build` to verify no type errors
- [x] 3.3 Run `pnpm check` to verify formatting/linting
