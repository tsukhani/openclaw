## Why

The memory-neo4j extension received a B+ on performance in a comprehensive code review. The primary bottleneck is the sleep cycle running all 12+ phases sequentially even when many are independent. Secondary issues include per-item DB calls where batch operations exist, a missing index, and cold-start latency. These improvements target an A grade by reducing sleep cycle wall-clock time by ~40-60% and eliminating hot-path latency spikes.

## What Changes

- **Parallelize independent sleep cycle phases**: Restructure `sleep-cycle.ts` to run independent phase groups concurrently via `Promise.all`. Phases with no data dependencies (cleanup, credential scan, task ledger, tip generation, reclassification) run in parallel with the decay/conflict pipeline.
- **Batch conflict invalidation in Phase 3d**: Collect all conflict resolution decisions per chunk, then issue a single `invalidateMemories` + `clearPendingConflictsBatch` call instead of 2 DB calls per pair.
- **Consolidate noise pattern cleanup in Phase 5**: Combine 7 sequential `deleteMemoriesByPattern` calls into a single combined regex pattern, reducing 7 DB round-trips to 1.
- **Add composite index on Memory.taskId**: Add `CREATE INDEX` in `ensureIndexes` so Phase 7 task-memory lookups use an index instead of full label scans.
- **Add connection pool health check**: Periodic `verifyConnection` call in the service lifecycle to detect stale connections before they cause hot-path retry latency.
- **Pre-warm embedding cache on service start**: Embed core memories at startup so the first auto-recall after gateway restart avoids cold-start embedding latency (~100-200ms).

## Capabilities

### New Capabilities

- `sleep-cycle-parallelization`: Concurrent execution of independent sleep cycle phase groups with dependency-aware ordering
- `service-lifecycle-perf`: Connection health checks and embedding cache pre-warming at service start

### Modified Capabilities

_(No existing spec-level requirement changes — these are implementation optimizations within existing behavior contracts)_

## Impact

- **Code**: `extensions/memory-neo4j/sleep-cycle.ts` (major restructure), `sleep-phases-cleanup.ts` (noise pattern consolidation), `sleep-phases-decay.ts` (batch conflict resolution), `neo4j-client-indexes.ts` (taskId index), `index.ts` (health check + cache warm-up)
- **Behavior**: No user-facing behavior changes. Sleep cycle produces identical results but faster. Service start takes slightly longer (cache warm-up) but first recall is faster.
- **Risk**: Low — all changes are internal performance optimizations. Sleep cycle results are deterministic regardless of phase execution order for independent groups.
