## Why

Code review of the eval harness uncovered two correctness bugs and two robustness issues. The most critical: `judgeContext` is declared in `EvalRunOptions` but never checked — context completeness always runs when extraction is enabled and never runs otherwise, regardless of the user's intent. The second: A/B bootstrap CI computes averages over all cases (including vacuous `emptyGoldSet` abstention/LongMemEval cases) while the reported overall metrics exclude them, making CI deltas and reported deltas measure different populations.

## What Changes

- **Bug fix (critical)**: Gate context completeness on `options.judgeContext !== false` (default true when judge available) and E2E on `options.endToEnd` in `harness.ts`, so the `judgeContext` option is actually honored
- **Bug fix (critical)**: Warn to stderr when user requests `judgeContext` or `endToEnd` but extraction config is disabled (judge unavailable)
- **Bug fix**: Filter `emptyGoldSet` cases in A/B bootstrap CI `avg()` helper to match `computeAggregateNumerics` behavior, preventing metric population mismatch
- **Bug fix**: Replace `extractJson` indexOf/lastIndexOf approach with brace-depth matching to avoid over-capturing when LLM responses contain trailing `{…}` blocks
- **Cleanup**: Collapse redundant `overallA`/`overallB` extractors in `METRIC_SPECS` into a single `overall` field

## Capabilities

### New Capabilities

- `eval-harness-review-fixes`: Correctness fixes for judge gating, A/B metric consistency, and JSON extraction robustness

### Modified Capabilities

## Impact

- `extensions/memory-neo4j/eval/harness.ts` — gate judge on `judgeContext`, warn when judge unavailable
- `extensions/memory-neo4j/eval/ab-compare.ts` — filter emptyGoldSet in avg(), collapse overallA/B
- `extensions/memory-neo4j/eval/judges/llm-judge.ts` — robust extractJson with brace-depth matching
- `extensions/memory-neo4j/eval/judges/llm-judge.test.ts` — add test for trailing braces edge case
- `extensions/memory-neo4j/eval/ab-compare.test.ts` — add test verifying emptyGoldSet exclusion
