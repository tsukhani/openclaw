## Context

The memory-neo4j eval harness (`extensions/memory-neo4j/eval/`) is a RAG evaluation pipeline that measures retrieval quality via IR metrics, LLM-as-judge context completeness, and end-to-end answer grading. It supports A/B variant comparison with paired bootstrap confidence intervals and CI regression detection.

Code review identified two bugs and three code smells. All fixes are localized to the eval subsystem with no cross-module dependencies.

## Goals / Non-Goals

**Goals:**

- Fix `keepData` option so eval data persists when requested (debugging, manual inspection)
- Unify bootstrap CI percentile indexing so both code paths produce identical intervals
- Improve maintainability by eliminating dummy values, redundant filtering, and copied test logic

**Non-Goals:**

- Changing any eval metric formulas or scoring behavior
- Altering the public API surface of `runEval` or `runAbComparison`
- Adding new eval capabilities or metrics

## Decisions

### 1. `keepData` — gate cleanup on the option flag

Add `if (!options.keepData)` around the cleanup block in the `finally` clause. The production mode check (`!productionAgentId`) is retained as an inner guard since production mode should never clean up regardless of `keepData`.

**Alternative considered**: Moving cleanup to a separate post-run step. Rejected — the `finally` block is the right place for cleanup to ensure it runs even on errors.

### 2. Bootstrap CI — standardize on `Math.ceil(p * n) - 1`

The `pairedBootstrapCI` formula `Math.ceil(0.025 * nSamples) - 1` is the standard textbook percentile index (equivalent to 1-indexed percentile position converted to 0-indexed). Align `buildCompletenessComparison` to use the same formula for both lower and upper bounds.

**Alternative considered**: Using `Math.floor`. Rejected — `ceil - 1` is more conservative (slightly wider CI) which is preferable for hypothesis testing.

### 3. Retrieval aggregation — extract numeric-only helper

Extract the numeric averaging into `computeAggregateNumerics(cases)` that returns the metric averages without an ability field. `aggregateMetrics` calls this helper and adds the ability. `aggregateOverall` calls the helper directly. No dummy ability needed.

### 4. Loader double-filter — remove redundant filter

The `loadCustomDataset` function already accepts and applies the `ability` filter. The second filter in `loader.ts` is provably redundant. Remove it.

### 5. Test helpers — export and import real functions

Export `extractJson`, `normalizeVerdict`, `normalizeCorrectness` from `llm-judge.ts` and `pairedBootstrapCI` from `ab-compare.ts`. Update tests to import the real functions. This is low-risk since these are pure utility functions with no side effects.

## Risks / Trade-offs

- **Export surface expansion**: Exporting internal helpers increases the module's public API. Mitigated by the fact that these are pure functions with stable signatures, and the eval module is not a public SDK surface.
- **`keepData` data accumulation**: Users who enable `keepData` but forget to clean up will accumulate eval data in Neo4j. Acceptable — this is an opt-in debugging feature.
