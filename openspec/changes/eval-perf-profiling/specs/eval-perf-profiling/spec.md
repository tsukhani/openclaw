## ADDED Requirements

### Requirement: Per-query latency recording

The eval harness SHALL record the wall-clock latency of each `hybridSearch` call using `performance.now()` and store the latency in milliseconds alongside the case's retrieval metrics.

#### Scenario: Latency recorded for each test case

- **WHEN** the eval harness runs a test case through `hybridSearch`
- **THEN** the result for that case SHALL include a `latencyMs` field with the elapsed time in milliseconds (sub-millisecond precision)

#### Scenario: Latency recorded independently of retrieval metrics

- **WHEN** the eval harness computes retrieval metrics for a case
- **THEN** the latency measurement SHALL reflect only the `hybridSearch` call duration, not metric computation, LLM judge calls, or memory ingestion time

### Requirement: Latency distribution aggregation

The eval harness SHALL compute aggregate latency statistics across all queries in a run, producing a `LatencyStats` object with count, min, max, mean, stddev, p50, p95, and p99.

#### Scenario: Distribution computed from all query latencies

- **WHEN** the eval run completes with N test cases
- **THEN** the result SHALL include a `performance.retrieval.cold` field containing a `LatencyStats` object computed from all N latency samples

#### Scenario: Percentile computation with sorted-array indexing

- **WHEN** latency samples are aggregated
- **THEN** p50 SHALL equal the sample at index `floor(0.50 * count)`, p95 at `floor(0.95 * count)`, and p99 at `floor(0.99 * count)` of the sorted samples array

#### Scenario: Standard deviation uses population formula

- **WHEN** latency samples are aggregated
- **THEN** stddev SHALL be computed as the population standard deviation (dividing by N, not N-1) since we have the full population of queries, not a sample

### Requirement: Per-ability latency breakdown

The eval harness SHALL compute latency statistics grouped by memory ability category.

#### Scenario: Latency stats per ability

- **WHEN** the eval run includes cases from multiple abilities (e.g., extraction, temporal, graph)
- **THEN** the result SHALL include a `performance.retrieval.perAbility` map keyed by ability name, each value being a `LatencyStats` object computed from that ability's query latencies

#### Scenario: Abilities with one case

- **WHEN** an ability has only one test case
- **THEN** the `LatencyStats` for that ability SHALL have min = max = mean = p50 = p95 = p99 = that single latency value, and stddev = 0

### Requirement: Retrieval throughput measurement

The eval harness SHALL compute queries-per-second (QPS) for the retrieval phase.

#### Scenario: QPS computed from total retrieval time

- **WHEN** the eval run completes
- **THEN** `performance.retrieval.qps` SHALL equal `totalQueries / totalRetrievalDurationSeconds` where `totalRetrievalDurationSeconds` is the sum of all per-query latencies divided by 1000

#### Scenario: QPS excludes ingestion and judge time

- **WHEN** QPS is computed
- **THEN** the denominator SHALL include only time spent in `hybridSearch` calls, not memory ingestion, entity extraction, LLM judge calls, or cleanup

### Requirement: Ingestion throughput measurement

The eval harness SHALL measure the ingestion rate during the memory storage phase.

#### Scenario: Ingestion metrics recorded per haystack group

- **WHEN** the eval harness stores memories for a haystack group (via `storeTestMemories` and optionally `extractMemoriesInBatches`)
- **THEN** the harness SHALL record the number of memories stored and the total duration in milliseconds for that group

#### Scenario: Aggregate ingestion throughput

- **WHEN** the eval run completes
- **THEN** the result SHALL include `performance.ingestion` with `totalMemories`, `totalDurationMs`, and `memoriesPerSecond` (totalMemories / totalDurationSeconds)

#### Scenario: Ingestion metrics skipped in production mode

- **WHEN** the eval harness runs in production mode (`productionMode: true`)
- **THEN** `performance.ingestion` SHALL be omitted from the result (no memories are ingested in production mode)

### Requirement: Cold-start vs warm-cache comparison

The eval harness SHALL support a `--warmup` mode that runs the query set twice to compare cold-start and steady-state latency.

#### Scenario: Warm-up pass executes queries without recording metrics

- **WHEN** the `warmup` option is `true`
- **THEN** the harness SHALL execute all `hybridSearch` calls once (cold pass), record those latencies as `performance.retrieval.cold`, then execute all `hybridSearch` calls a second time and record those latencies as `performance.retrieval.warm`

#### Scenario: Warm-up pass skips LLM judge calls

- **WHEN** the warm-up pass (first pass) executes
- **THEN** the harness SHALL NOT invoke the LLM judge for context completeness or E2E grading during that pass (judge calls run only on the second measured pass)

#### Scenario: Warm results absent without warmup flag

- **WHEN** the `warmup` option is `false` or unset
- **THEN** `performance.retrieval.warm` SHALL be `undefined` and only `performance.retrieval.cold` SHALL be populated

#### Scenario: Retrieval metrics computed from final pass only

- **WHEN** the `warmup` option is `true`
- **THEN** retrieval quality metrics (precision, recall, MRR, NDCG) and context completeness verdicts SHALL be computed from the second (warm) pass results only

### Requirement: Performance field on EvalRunResult

The `EvalRunResult` type SHALL include an optional `performance` field containing all latency and throughput metrics.

#### Scenario: Performance field structure

- **WHEN** an eval run completes
- **THEN** `result.performance` SHALL be an object with `retrieval` (containing `cold`, optional `warm`, `perAbility`, `qps`) and optional `ingestion` (containing `totalMemories`, `totalDurationMs`, `memoriesPerSecond`)

#### Scenario: Backward compatibility with existing consumers

- **WHEN** existing code destructures `EvalRunResult` without accessing `performance`
- **THEN** the code SHALL continue to work without modification (the field is optional)

### Requirement: Performance in CI metrics summary

The `CiMetricsSummary` type SHALL include optional latency and throughput fields for CI reporting.

#### Scenario: CI summary includes performance metrics

- **WHEN** `buildCiSummary` produces a summary from a run with performance data
- **THEN** the summary SHALL include `p50_latency_ms`, `p95_latency_ms`, and `qps` fields with values from `performance.retrieval.cold`

#### Scenario: CI summary defaults for runs without performance data

- **WHEN** `buildCiSummary` produces a summary from a run without performance data (e.g., old baseline)
- **THEN** `p50_latency_ms`, `p95_latency_ms`, and `qps` SHALL default to `0`

### Requirement: Latency regression detection

The baseline comparison SHALL detect latency regressions using a relative threshold on p95 latency.

#### Scenario: Regression flagged when p95 exceeds threshold

- **WHEN** the current run's `performance.retrieval.cold.p95` exceeds `baseline.performance.retrieval.cold.p95 * (1 + threshold)` where threshold defaults to 0.20 (20%)
- **THEN** the regression report SHALL include a `MetricDelta` entry for `p95LatencyMs` with `isRegression: true`

#### Scenario: Regression threshold is configurable

- **WHEN** `EvalRunOptions.perfRegressionThreshold` is set to a custom value (e.g., 0.10 for 10%)
- **THEN** the regression check SHALL use that value instead of the default 0.20

#### Scenario: Graceful degradation for old baselines

- **WHEN** the baseline `EvalRunResult` has no `performance` field (pre-existing baseline)
- **THEN** the regression check SHALL skip latency comparison entirely without error or warning

### Requirement: Console reporter displays performance metrics

The console reporter SHALL display latency distribution and throughput metrics when performance data is present.

#### Scenario: Latency section in console output

- **WHEN** the console reporter formats a result with `performance` data
- **THEN** it SHALL render a "Performance Metrics" section showing p50, p95, p99, mean, min, max latency values in milliseconds and QPS

#### Scenario: Cold vs warm comparison in console output

- **WHEN** the result includes both `cold` and `warm` latency stats
- **THEN** the console reporter SHALL display both distributions side-by-side with labels "Cold" and "Warm"

#### Scenario: Console reporter omits performance section when absent

- **WHEN** the result has no `performance` field
- **THEN** the console reporter SHALL not render any performance section (no empty placeholder)

### Requirement: JSON reporter includes performance metrics

The JSON reporter SHALL include the full `performance` object in its output.

#### Scenario: Performance object serialized in JSON

- **WHEN** the JSON reporter formats a result with `performance` data
- **THEN** the JSON output SHALL include the `performance` field with all nested latency stats and throughput metrics

### Requirement: Markdown reporter includes performance metrics

The markdown reporter SHALL include a performance table when performance data is present.

#### Scenario: Performance table in markdown output

- **WHEN** the markdown reporter formats a result with `performance` data
- **THEN** it SHALL render a "Performance Metrics" section with a table of latency percentiles (p50, p95, p99), mean, QPS, and ingestion throughput

#### Scenario: Cold vs warm table in markdown output

- **WHEN** the result includes both `cold` and `warm` latency stats
- **THEN** the markdown reporter SHALL render a comparison table with columns for Cold and Warm values

### Requirement: LatencyStats computation module

A new `eval/metrics/latency.ts` module SHALL compute latency distribution statistics from an array of latency samples.

#### Scenario: Empty input produces zero stats

- **WHEN** `computeLatencyStats` receives an empty array
- **THEN** it SHALL return a `LatencyStats` with all fields set to `0`

#### Scenario: Single sample produces degenerate stats

- **WHEN** `computeLatencyStats` receives a single sample `[42.5]`
- **THEN** it SHALL return `min=42.5, max=42.5, mean=42.5, stddev=0, p50=42.5, p95=42.5, p99=42.5, count=1`

#### Scenario: Correct percentile computation on known data

- **WHEN** `computeLatencyStats` receives 100 samples `[1, 2, 3, ..., 100]`
- **THEN** p50 SHALL be `51`, p95 SHALL be `96`, p99 SHALL be `100`

### Requirement: A/B comparison includes latency metrics

The A/B comparison runner SHALL include per-query latency in its paired bootstrap CI analysis alongside existing retrieval quality metrics.

#### Scenario: Latency metrics in A/B comparison

- **WHEN** `runAbComparison` completes with both variants having performance data
- **THEN** the `AbComparisonResult.metrics` array SHALL include `MetricComparison` entries for `p50_latency` and `p95_latency` with paired bootstrap CIs computed from per-case latency values

#### Scenario: Significance detection for latency

- **WHEN** variant B has significantly lower p95 latency than variant A
- **THEN** the `p95_latency` metric comparison SHALL have `significant: true` and `delta < 0` (negative delta means B is faster)

#### Scenario: A/B comparison without performance data

- **WHEN** one or both variants lack performance data (e.g., performance profiling disabled)
- **THEN** latency metric comparisons SHALL be omitted from the results (no error)

### Requirement: Warm-up clears query-result-cache between passes

When `--warmup` is enabled, the eval harness SHALL clear the query-result-cache after the cold pass and before the warm pass.

#### Scenario: Cache cleared between cold and warm passes

- **WHEN** the cold pass (first pass) completes and the warm pass is about to begin
- **THEN** the harness SHALL invoke the agent-scoped cache invalidation to flush the query-result-cache, ensuring the warm pass measures Neo4j-page-cache-warm latency rather than query-result-cache-hit latency

#### Scenario: Cache clearing scoped to eval namespace

- **WHEN** the harness clears the cache between passes
- **THEN** it SHALL invalidate only cache entries for the eval agent namespace, not cache entries belonging to other agents
