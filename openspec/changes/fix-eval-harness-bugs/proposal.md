## Why

The memory-neo4j eval harness has two bugs and three code smells discovered during code review. The `keepData` option is declared but never honored (cleanup always runs), bootstrap CI percentile indexing is inconsistent between two functions in the same file, and several patterns reduce maintainability (dummy ability labels, redundant filtering, tests that re-implement private logic instead of testing the real code).

## What Changes

- **Bug fix**: Honor `keepData` option in `harness.ts` — skip cleanup when the flag is set
- **Bug fix**: Unify bootstrap CI percentile indexing in `ab-compare.ts` to use `Math.ceil(p * n) - 1` consistently
- **Refactor**: Extract numeric aggregation in `retrieval.ts` so `aggregateOverall` no longer passes a dummy `"extraction"` ability
- **Refactor**: Remove redundant second ability filter in `datasets/loader.ts`
- **Refactor**: Export private helpers (`extractJson`, `normalizeVerdict`, `normalizeCorrectness`) from `llm-judge.ts` and (`pairedBootstrapCI`) from `ab-compare.ts` as named exports, then update tests to import the real functions instead of re-implementing them

## Capabilities

### New Capabilities

- `eval-harness-fixes`: Bug fixes and code quality improvements for the memory-neo4j eval harness

### Modified Capabilities

## Impact

- `extensions/memory-neo4j/eval/harness.ts` — cleanup gating on `keepData`
- `extensions/memory-neo4j/eval/ab-compare.ts` — percentile formula fix, export `pairedBootstrapCI`
- `extensions/memory-neo4j/eval/metrics/retrieval.ts` — refactor aggregation helpers
- `extensions/memory-neo4j/eval/datasets/loader.ts` — remove redundant filter
- `extensions/memory-neo4j/eval/judges/llm-judge.ts` — export parsing helpers
- `extensions/memory-neo4j/eval/judges/llm-judge.test.ts` — import real helpers
- `extensions/memory-neo4j/eval/ab-compare.test.ts` — import real `pairedBootstrapCI`
