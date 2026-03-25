## 1. Types and latency module

- [x] 1.1 Add `LatencyStats` and `PerformanceMetrics` types to `eval/types.ts` — `LatencyStats` with count/min/max/mean/stddev/p50/p95/p99, `PerformanceMetrics` with `retrieval` (cold, optional warm, perAbility, qps) and optional `ingestion` (totalMemories, totalDurationMs, memoriesPerSecond). Add optional `performance` field to `EvalRunResult`. Add optional `latencyMs` to `CaseRetrievalMetrics`. Add optional `p50_latency_ms`, `p95_latency_ms`, `qps` to `CiMetricsSummary`.
- [x] 1.2 Create `eval/metrics/latency.ts` — implement `computeLatencyStats(samples: number[]): LatencyStats` using sorted-array percentile indexing and population stddev. Implement `computeLatencyStatsByAbility(cases: Array<{ability: string, latencyMs: number}>): Record<string, LatencyStats>`.
- [x] 1.3 Add `warmup` boolean and `perfRegressionThreshold` number to `EvalRunOptions`.
- [x] 1.4 Write unit tests for `latency.ts` — empty array, single sample, 100-sample known data, per-ability grouping with single-case abilities.

## 2. Harness instrumentation

- [x] 2.1 Instrument retrieval loop in `harness.ts` — wrap the `hybridSearch` call (lines 200-208) with `performance.now()` timing, store `latencyMs` on each case result, collect samples into an array for aggregation.
- [x] 2.2 Instrument ingestion in `harness.ts` — wrap `storeTestMemories` + `extractMemoriesInBatches` calls with timing per haystack group, accumulate `totalMemories` and `totalDurationMs`. Skip when `productionMode` is true.
- [x] 2.3 After the run loop, call `computeLatencyStats` and `computeLatencyStatsByAbility` on collected samples. Compute QPS as `totalQueries / (sumOfLatenciesMs / 1000)`. Build the `PerformanceMetrics` object and attach to `EvalRunResult.performance`.

## 3. Warm-up mode

- [x] 3.1 Implement warm-up logic in `harness.ts` — when `options.warmup` is true, run all `hybridSearch` calls once (cold pass, record cold latencies), then clear the query-result-cache for the eval agent namespace, then run all `hybridSearch` calls a second time (warm pass, record warm latencies). Skip LLM judge calls on the cold pass.
- [x] 3.2 Store cold latencies as `performance.retrieval.cold` and warm latencies as `performance.retrieval.warm`. Compute retrieval quality metrics (precision, recall, etc.) and context completeness from the warm pass results only.
- [x] 3.3 Identify the cache invalidation API on `Neo4jMemoryClient` or the query-result-cache module. If no agent-scoped invalidation exists, add a minimal `invalidateCacheForAgent(agentId)` method or call the existing cache clear mechanism scoped to the eval namespace.

## 4. Baseline and regression detection

- [x] 4.1 Update `baseline.ts` `computeRegression` — when both current and baseline have `performance` data, compare `current.performance.retrieval.cold.p95` against `baseline.performance.retrieval.cold.p95 * (1 + threshold)`. Use `options.perfRegressionThreshold` (default 0.20). Add `MetricDelta` entry for `p95LatencyMs` when regression detected.
- [x] 4.2 Update `buildCiSummary` — populate `p50_latency_ms`, `p95_latency_ms`, `qps` from `performance.retrieval.cold` when present, default to `0` when absent.
- [x] 4.3 Ensure `loadBaseline` gracefully handles old baselines without `performance` field — latency regression check skipped, no error.

## 5. A/B comparison latency metrics

- [x] 5.1 Add latency metric extractors to `ab-compare.ts` — create `PERF_METRIC_SPECS` (or extend `METRIC_SPECS`) with `p50_latency` and `p95_latency` entries. The `fn` extracts per-case `latencyMs` and computes the aggregate, the `overall` reads from `performance.retrieval.cold`.
- [x] 5.2 In `runAbComparison`, conditionally append latency `MetricComparison` entries when both runs have `performance` data. Skip when either run lacks it.
- [x] 5.3 Update `reportAbComparison` console output to display latency metrics with `ms` units instead of `%` formatting.

## 6. Reporters

- [x] 6.1 Update `reporters/console.ts` — add a "Performance Metrics" section showing p50/p95/p99/mean/min/max in ms, QPS, and ingestion throughput. When both cold and warm are present, display side-by-side. Omit section when `performance` is absent.
- [x] 6.2 Update `reporters/json.ts` — no code changes needed (`formatJson` already serializes the full `EvalRunResult`), but verify the `performance` field round-trips correctly through `JSON.stringify`/`JSON.parse`.
- [x] 6.3 Update `reporters/markdown.ts` — add a "Performance Metrics" section with a table of latency percentiles, mean, QPS, and ingestion rate. Add cold/warm comparison table when both are present. Omit section when `performance` is absent.

## 7. CLI wiring

- [x] 7.1 Add `--warmup` boolean flag and `--perf-regression-threshold` numeric flag to the eval CLI command in `cli-commands.ts`. Wire to `EvalRunOptions.warmup` and `EvalRunOptions.perfRegressionThreshold`.

## 8. Integration and export

- [x] 8.1 Export new types (`LatencyStats`, `PerformanceMetrics`) and functions (`computeLatencyStats`, `computeLatencyStatsByAbility`) from `eval/index.ts`.
- [x] 8.2 Run `pnpm build` to verify no type errors or build warnings.
- [x] 8.3 Run `pnpm test -- extensions/memory-neo4j/eval` to verify all existing + new tests pass.
- [x] 8.4 Run a manual smoke test: `openclaw memory eval --dataset custom --variant default` and verify performance metrics appear in console output.
