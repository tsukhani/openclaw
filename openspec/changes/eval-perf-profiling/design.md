## Context

The memory-neo4j eval harness (`extensions/memory-neo4j/eval/`) currently runs a pipeline of:

1. Load dataset → 2. Store memories → 3. Run `hybridSearch` per case → 4. Compute retrieval metrics → 5. (optional) LLM judge → 6. Aggregate and report

The harness records `durationMs` for the entire run but has no per-query timing, no throughput metrics, and no way to distinguish cold-start from steady-state performance. The existing `query-result-cache` spec (LRU cache with TTL) and `service-lifecycle-perf` spec (embedding cache pre-warming) mean cache state significantly affects query latency, but the eval harness has no way to measure or control for this.

Key code paths:

- **Retrieval loop**: `harness.ts` lines 198-227 — iterates cases within haystack groups, calls `hybridSearch`, maps results
- **Memory ingestion**: `harness.ts` lines 446-476 — `storeTestMemories` with batch embedding and `storeManyMemories`
- **Entity extraction**: `harness.ts` lines 424-440 — `extractMemoriesInBatches` in groups of 5
- **Types**: `types.ts` — `EvalRunResult`, `EvalRunOptions`, `CiMetricsSummary`
- **Baseline**: `baseline.ts` — regression thresholds and `computeRegression`
- **Reporters**: `reporters/console.ts`, `reporters/json.ts`, `reporters/markdown.ts`

## Goals / Non-Goals

**Goals:**

- Per-query latency instrumentation with p50/p95/p99/min/max/mean/stddev distribution
- Per-ability latency breakdown (temporal queries may be slower than extraction queries)
- Ingestion throughput (memories/sec) for the store+embed phase
- Retrieval throughput (queries/sec) for the search phase
- Cold-start vs warm-cache comparison mode (`--warmup`)
- Latency regression detection in CI baselines
- All reporters updated to display performance data
- Backward-compatible: old baselines without perf data still work

**Non-Goals:**

- Distributed tracing or span-level instrumentation inside `hybridSearch` internals (vector vs BM25 vs graph sub-query timing) — that would require changes to `search.ts` which is outside eval scope
- Memory (RAM) profiling or heap snapshots
- Network-level latency isolation (Neo4j round-trip vs embedding API latency)
- Flame graphs or CPU profiling
- Benchmarking actual competitor implementations (LanceDB, Mem0, Zep) — that requires separate adapters

## Decisions

### 1. Timing mechanism: `performance.now()` over `Date.now()`

`performance.now()` provides sub-millisecond monotonic resolution. `Date.now()` has only millisecond precision and can be affected by system clock adjustments. Since individual `hybridSearch` calls can complete in <10ms on warm cache, sub-millisecond resolution matters.

**Alternative considered**: `process.hrtime.bigint()` — offers nanosecond resolution but returns BigInt which complicates arithmetic and JSON serialization. `performance.now()` (DOMHighResTimeStamp, available in Node 16+) gives microsecond-level precision in a plain number, which is sufficient and ergonomic.

### 2. Latency collection: inline in the run loop, not a wrapper/decorator

Instrument the `hybridSearch` call directly in the harness run loop (`harness.ts` lines 200-208) by capturing `t0`/`t1` around the call and pushing `{ caseId, latencyMs }` to a collector array. This is the simplest approach and avoids adding abstraction layers.

**Alternative considered**: A `TimedHybridSearch` wrapper that proxies the real function — adds indirection, complicates the type signature (hybridSearch has 7 parameters), and makes it harder to see what's being timed in the harness code. Not worth the abstraction for a single call site.

### 3. Latency statistics: new `eval/metrics/latency.ts` module

Create a dedicated module that takes an array of latency samples and computes the distribution. This parallels the existing pattern where each metric category has its own module (`retrieval.ts`, `context-completeness.ts`, `signal-attribution.ts`).

The module exports:

- `computeLatencyStats(samples: number[]): LatencyStats` — full distribution
- `computeLatencyStatsByAbility(cases: Array<{ability, latencyMs}>): Map<ability, LatencyStats>` — per-ability breakdown

### 4. Warm-up mode: run the full query set twice, report only the second pass

When `--warmup` is set, the harness runs all queries once (populating Neo4j page cache, query-result-cache, and embedding cache), discards those latency measurements, then runs all queries a second time and records those latencies. Both cold (first pass) and warm (second pass) distributions are stored in the result for side-by-side comparison.

**Alternative considered**: Run each query twice individually (cold then warm per query). This would interleave cache population and measurement, but the query-result-cache has a TTL, and running all queries first gives a more realistic steady-state picture. The "run all twice" approach also matches how users would experience the system — after the first few queries, the cache is warm for subsequent ones.

**Implementation detail**: The warm-up pass skips LLM judge calls (Tier 1 and Tier 2) since those are expensive and their results don't change between passes. Only `hybridSearch` timing is captured in the warm-up pass.

### 5. Ingestion throughput: measured per haystack group

Wrap the `storeTestMemories` + `extractMemoriesInBatches` calls with timing and record `{ memoriesStored, extractionsDone, durationMs }` per group. Aggregate to memories-per-second across all groups. This naturally handles the shared-haystack optimization (LoCoMo stores once per group, not per case).

### 6. Performance in EvalRunResult: new optional `performance` field

```ts
type PerformanceMetrics = {
  retrieval: {
    cold: LatencyStats;
    warm?: LatencyStats; // present only when --warmup used
    perAbility: Record<string, LatencyStats>;
    qps: number; // queries per second (retrieval phase only)
  };
  ingestion: {
    totalMemories: number;
    totalDurationMs: number;
    memoriesPerSecond: number;
  };
};
```

The field is optional on `EvalRunResult` so existing code that destructures the result doesn't break. The `CiMetricsSummary` gains `p50_latency_ms`, `p95_latency_ms`, and `qps` as optional fields (default to 0 if absent for backward compatibility with old baselines).

### 7. Latency regression detection: percentage-based threshold on p95

Add a `p95LatencyMs` regression threshold to `baseline.ts`. Unlike retrieval metrics (which use absolute deltas like -0.02), latency regression uses a relative threshold: flag if `current_p95 > baseline_p95 * 1.20` (20% increase). This accounts for the fact that absolute latency varies across machines, but relative changes are meaningful.

**Alternative considered**: Absolute threshold (e.g., p95 must stay under 100ms). This is too hardware-dependent to be useful in CI across different machines. Relative comparison against a same-machine baseline is more robust.

When the baseline has no performance data (`performance` field is undefined), latency regression checks are silently skipped — no false positives from old baselines.

### 8. LatencyStats shape

```ts
type LatencyStats = {
  count: number;
  min: number;
  max: number;
  mean: number;
  stddev: number;
  p50: number;
  p95: number;
  p99: number;
};
```

Percentiles computed via sorted-array indexing (same approach as bootstrap CI in `ab-compare.ts`). No external stats library needed.

## Risks / Trade-offs

**[Warm-up doubles runtime]** → The `--warmup` flag doubles the retrieval phase duration. Mitigation: it's opt-in and skips LLM judge calls in the warm-up pass, so the cost is manageable for datasets without judge evaluation. For LoCoMo (large haystack, many queries), this is already slow; warm-up would push it further. Document the trade-off and suggest using `--warmup` with smaller datasets or the `custom` fixture set.

**[Latency measurements include Neo4j network round-trip]** → The harness measures wall-clock time for `hybridSearch`, which includes Neo4j bolt protocol latency, vector index search, BM25 query, graph traversal, and result serialization. We cannot isolate these components without instrumenting `search.ts` internals (a non-goal). Mitigation: this is actually what users experience — total query latency is the relevant metric for competitive comparison.

**[System load affects latency]** → Background processes, other Neo4j queries, or CPU contention can skew results. Mitigation: the `--warmup` mode helps by comparing cold/warm on the same run, and the stddev metric helps detect noisy runs. CI environments should run eval on dedicated workers for reliable regression detection.

**[p95 regression threshold may need tuning]** → The 20% default may be too tight (flaky on noisy CI) or too loose (misses real regressions). Mitigation: make the threshold configurable via `EvalRunOptions.perfRegressionThreshold` and allow CLI override.

## Resolved Questions

1. **A/B comparison includes latency bootstrap CI.** The paired bootstrap infrastructure in `ab-compare.ts` already supports arbitrary metric functions. Add a `p50_latency` and `p95_latency` metric spec to `METRIC_SPECS` (or a parallel `PERF_METRIC_SPECS`) that extracts per-case latency values and computes paired bootstrap CI for the delta. This lets us say "variant A is statistically significantly faster than B at the 95% confidence level." The `MetricComparison` type already has everything needed — just add the new metric extractors.

2. **`--warmup` clears the query-result-cache between passes.** After the cold pass completes, the harness calls the cache invalidation API (agent-scoped `invalidateCache` or equivalent) to flush the query-result-cache before running the warm pass. This way the warm pass measures Neo4j-page-cache-warm + fresh-query latency, which is more realistic — in production the query-result-cache has a short TTL so users rarely get exact cache hits, but Neo4j's page cache stays warm across queries.
