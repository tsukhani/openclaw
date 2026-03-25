## Why

The memory-neo4j eval harness correctly measures retrieval quality (Precision@K, Recall@K, MRR, NDCG, context completeness, E2E accuracy) but has zero performance instrumentation. For competitive benchmarking against LanceDB, Mem0, Zep, and memory-core, retrieval accuracy is only half the story — latency, throughput, and cold-start behavior are equally important to users choosing a memory backend. Without per-query latency distributions and cold/warm comparison data, we cannot make credible performance claims or detect performance regressions in CI.

## What Changes

- **Per-query latency recording**: Wrap each `hybridSearch` call in the eval runner with high-resolution timing (`performance.now()`), recording latency per test case alongside existing retrieval metrics.
- **Latency distribution aggregation**: Compute p50, p95, p99, min, max, mean, and standard deviation across all queries in a run. Break down by ability category.
- **Throughput metric**: Track queries-per-second (QPS) for the retrieval phase (excluding memory ingestion and cleanup).
- **Cold-start vs warm-cache comparison mode**: Add a `--warmup` option that runs the query set twice — first pass populates caches (query-result-cache, embedding cache, Neo4j page cache), second pass measures steady-state latency. Report both cold and warm distributions side-by-side.
- **Ingestion throughput**: Measure memories-per-second during the `storeTestMemories` + extraction phase, since ingestion speed matters for large-haystack benchmarks like LoCoMo.
- **Performance results in all reporters**: Extend console, JSON, and markdown reporters to include latency distributions and throughput metrics. CI summary gains `p50_latency_ms`, `p95_latency_ms`, `qps` fields.
- **Performance regression detection**: Extend baseline comparison to flag latency regressions (e.g., p95 increased by more than 20% vs baseline).

## Capabilities

### New Capabilities

- `eval-perf-profiling`: Per-query latency tracking (p50/p95/p99), throughput measurement (QPS, memories/sec), cold-start vs warm-cache comparison mode, and performance regression detection in the eval harness.

### Modified Capabilities

<!-- No existing specs have requirements that change. The eval harness is not covered by an existing spec. -->

## Impact

- **Code**: `extensions/memory-neo4j/eval/harness.ts` (timing instrumentation in the run loop), new `eval/metrics/latency.ts` module, updates to all three reporters (`console.ts`, `json.ts`, `markdown.ts`), `eval/types.ts` (new result types), `eval/baseline.ts` (latency regression thresholds), CLI wiring in `cli-commands.ts`.
- **APIs**: `EvalRunResult` type gains a `performance` field. `EvalRunOptions` gains `warmup` boolean. `CiMetricsSummary` gains latency/throughput fields. These are additive — no breaking changes.
- **Dependencies**: None. Uses built-in `performance.now()` for timing.
- **CI**: Baseline JSON format gains performance fields. Old baselines without performance data degrade gracefully (latency regression check skipped when baseline lacks perf data).
