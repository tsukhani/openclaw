## ADDED Requirements

### Requirement: keepData option gates eval cleanup

The eval harness SHALL skip memory cleanup when `keepData` is `true` in `EvalRunOptions`. When `keepData` is falsy or unset, the harness SHALL clean up eval memories after the run completes, preserving existing behavior. Production mode (`productionMode: true`) SHALL never clean up regardless of `keepData`.

#### Scenario: keepData is true — memories persist after eval

- **WHEN** `runEval` is called with `options.keepData = true`
- **THEN** the harness SHALL NOT delete stored memories or orphan entities after the run

#### Scenario: keepData is false — memories cleaned up

- **WHEN** `runEval` is called with `options.keepData` unset or `false`
- **THEN** the harness SHALL delete stored memories and orphan entities after the run (existing behavior)

#### Scenario: production mode overrides keepData

- **WHEN** `runEval` is called with `productionMode = true` and `keepData = false`
- **THEN** the harness SHALL NOT delete memories (production memories are never owned by eval)

### Requirement: Consistent bootstrap CI percentile indexing

Both `pairedBootstrapCI` and `buildCompletenessComparison` in `ab-compare.ts` SHALL use the same percentile indexing formula: `Math.ceil(percentile * nSamples) - 1` for both the 2.5th and 97.5th percentile bounds.

#### Scenario: Default 1000 samples produce identical index formula

- **WHEN** computing a 95% bootstrap CI with `nSamples = 1000`
- **THEN** both `pairedBootstrapCI` and `buildCompletenessComparison` SHALL use index 24 for the lower bound and index 974 for the upper bound

#### Scenario: Non-default sample sizes

- **WHEN** computing a 95% bootstrap CI with any `nSamples` value
- **THEN** both functions SHALL produce identical lower/upper indices for the same `nSamples`

### Requirement: aggregateOverall does not use dummy ability

`aggregateOverall` SHALL compute overall aggregate metrics without passing a dummy ability value to `aggregateMetrics`. The numeric aggregation logic SHALL be extracted into a shared helper that both `aggregateMetrics` and `aggregateOverall` can use.

#### Scenario: Overall aggregation returns correct metrics

- **WHEN** `aggregateOverall` is called with a list of `CaseRetrievalMetrics`
- **THEN** it SHALL return the same numeric averages as before (no behavioral change) without referencing any ability label

### Requirement: No redundant ability filtering in dataset loader

The dataset loader SHALL filter by ability at most once per load operation. The redundant second filter in `loader.ts` for "custom" and "production" datasets SHALL be removed since `loadCustomDataset` already applies the ability filter.

#### Scenario: Custom dataset with ability filter

- **WHEN** `loadDataset("custom", { ability: "extraction" })` is called
- **THEN** the returned cases SHALL contain only "extraction" cases, filtered once inside `loadCustomDataset`

### Requirement: Tests import real helper functions

Tests for `llm-judge.ts` and `ab-compare.ts` SHALL import and test the actual module functions rather than re-implementing the logic locally. The helpers `extractJson`, `normalizeVerdict`, `normalizeCorrectness` SHALL be exported from `llm-judge.ts`. The helper `pairedBootstrapCI` SHALL be exported from `ab-compare.ts`.

#### Scenario: llm-judge tests use real exports

- **WHEN** `llm-judge.test.ts` tests context verdict fallback parsing
- **THEN** it SHALL import and call the real `normalizeVerdict` and `extractJson` functions from `../judges/llm-judge.js`

#### Scenario: ab-compare tests use real bootstrap function

- **WHEN** `ab-compare.test.ts` tests bootstrap CI percentile indexing
- **THEN** it SHALL import and call the real `pairedBootstrapCI` function from `../ab-compare.js`
