## 1. Remove reranker abstention threshold

- [x] 1.1 Remove the abstention threshold check from `reranker.ts` (lines 132–165): delete the `abstentionThreshold` variable, the `graphOnly` check, and the early-return block. Keep the `minScore` and `topJ` filtering unchanged.
- [x] 1.2 Remove `abstentionThreshold` from `RerankerConfig` in `schema.ts` and from config parsing in `config.ts`.
- [x] 1.3 Remove `abstentionThreshold` from the eval variant in `eval/variants.ts`.

## 2. Remove legacy threshold mode from search.ts

- [x] 2.1 Remove the `AbstentionConfig` type from `schema.ts` and the `abstention` config parsing from `config.ts` (lines 704–709).
- [x] 2.2 Remove the `abstentionConfig` parameter from `hybridSearch()` and all call sites.
- [x] 2.3 Remove the legacy threshold branch in `search.ts` (lines 601–614).

## 3. Unify classifier as post-filter

- [x] 3.1 Import `isTemporalQuery` from `reranker.ts` into `search.ts`.
- [x] 3.2 Restructure `search.ts` abstention block: move the classifier out of the `else` branch so it runs after both the reranker and non-reranker paths. Apply graph-only and temporal skip conditions before calling `shouldAbstain()`.
- [x] 3.3 Verify the classifier operates on `.score` (which is cross-encoder `relevanceScore` post-reranking, or RRF score when reranker is off).

## 4. Tests and verification

- [x] 4.1 Confirm existing `abstention-classifier.test.ts` tests pass unchanged.
- [x] 4.2 Run `pnpm build` and verify no type errors from removed config fields.
- [x] 4.3 Run `pnpm test` to verify no regressions.
