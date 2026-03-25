## 1. Fix validFrom Mapping

- [x] 1.1 Change `validFrom: mem.createdAt` to `validFrom: mem.validFrom ?? mem.createdAt` in `storeTestMemories` in `harness.ts`

## 2. Pass Golden Answer to Context Completeness Judge

- [x] 2.1 Add `goldenAnswer: string` parameter to `evaluateContextCompleteness` in `context-completeness.ts`
- [x] 2.2 Add `goldenAnswer: string` parameter to `LlmJudge.judgeContextCompleteness` in `llm-judge.ts` and include it in the judge prompt
- [x] 2.3 Update the `evaluateContextCompleteness` call in `harness.ts` to pass `tc.golden_answer`

## 3. Exclude Empty Gold Set Cases from Retrieval Averages

- [x] 3.1 Add `emptyGoldSet: boolean` field to `CaseRetrievalMetrics` in `types.ts`
- [x] 3.2 Set `emptyGoldSet: true` in `computeCaseMetrics` when `goldIds.length === 0` in `retrieval.ts`
- [x] 3.3 Filter out `emptyGoldSet` cases in `computeAggregateNumerics` for metric averages (keep them in caseCount)
- [x] 3.4 Update retrieval tests to cover the empty-gold-set filtering behavior

## 4. Remove Global Orphan Entity Cleanup

- [x] 4.1 Remove the `findOrphanEntities` / `deleteOrphanEntities` calls from the cleanup block in `harness.ts`

## 5. Verification

- [x] 5.1 Run `pnpm test -- extensions/memory-neo4j/eval` to verify all eval tests pass
- [x] 5.2 Run `pnpm build` to verify no type errors
