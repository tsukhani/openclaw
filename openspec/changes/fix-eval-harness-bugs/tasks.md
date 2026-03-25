## 1. Bug Fixes

- [x] 1.1 Gate cleanup on `keepData` in `harness.ts` — wrap the cleanup block in `if (!options.keepData)` inside the existing `if (!productionAgentId)` guard
- [x] 1.2 Fix bootstrap CI percentile in `ab-compare.ts` — change `buildCompletenessComparison` to use `Math.ceil(p * n) - 1` instead of `Math.floor(p * n)` for both lower and upper bounds

## 2. Refactor: Retrieval Aggregation

- [x] 2.1 Extract `computeAggregateNumerics` helper in `retrieval.ts` that returns metric averages without an ability field
- [x] 2.2 Refactor `aggregateMetrics` to call `computeAggregateNumerics` and add the ability field
- [x] 2.3 Refactor `aggregateOverall` to call `computeAggregateNumerics` directly, removing the dummy `"extraction"` ability

## 3. Refactor: Remove Redundant Filter

- [x] 3.1 Remove the second ability filter in `loader.ts` lines 67-69 for "custom" and "production" datasets

## 4. Refactor: Export Helpers and Fix Tests

- [x] 4.1 Export `extractJson`, `normalizeVerdict`, `normalizeCorrectness` from `llm-judge.ts`
- [x] 4.2 Export `pairedBootstrapCI` from `ab-compare.ts`
- [x] 4.3 Rewrite `llm-judge.test.ts` to import and test the real exported functions instead of local copies
- [x] 4.4 Rewrite `ab-compare.test.ts` to import and test the real `pairedBootstrapCI` instead of re-implementing the percentile logic

## 5. Verification

- [x] 5.1 Run `pnpm test -- extensions/memory-neo4j/eval` to verify all eval tests pass
- [x] 5.2 Run `pnpm build` to verify no type errors
