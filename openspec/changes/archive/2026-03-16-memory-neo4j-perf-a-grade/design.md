## Context

The memory-neo4j sleep cycle orchestrator (`sleep-cycle.ts`) runs 12+ phases strictly sequentially. Many phases are independent (no shared state or data dependencies) but still wait for previous phases to complete. Additionally, several inner loops make per-item DB calls where batch APIs already exist. A code review scored performance at B+ with the sequential sleep cycle as the primary bottleneck.

Current sleep cycle wall-clock time: ~4-10 minutes for a typical agent. Target: ~2-5 minutes.

## Goals / Non-Goals

**Goals:**

- Reduce sleep cycle wall-clock time by 40-60% via phase parallelization
- Eliminate N DB round-trips where batch operations exist (conflict resolution, noise cleanup)
- Add a taskId index to support Phase 7 lookups
- Improve service start reliability (health check) and first-recall latency (cache warm-up)
- Maintain identical sleep cycle results — all changes are execution-order optimizations

**Non-Goals:**

- Changing the sleep cycle phase logic itself (dedup algorithms, decay curves, extraction prompts)
- Adding new sleep cycle phases
- Modifying the search/recall hot path (already well-optimized with parallel signals)
- Changing the plugin's public API or configuration schema
- Optimizing LLM call latency (external dependency, not within scope)

## Decisions

### D1: Phase parallelization strategy — Dependency-grouped Promise.all

**Decision:** Split sleep cycle into a sequential pipeline of phase groups, where independent groups run concurrently within each stage.

**Stage 1 (sequential — data dependencies):**
Phase 1 (dedup) → 1c (conflict) → 1d (entity dedup) → 2 (extraction) → 2b (tagging) → 2c (community)

**Stage 2 (parallel — all independent of each other):**

- Group A: Phase 3 → 3b → 3c → 3d (decay pipeline, internally sequential)
- Group B: Phase 5 + 5b (noise + credential scan)
- Group C: Phase 6 → 7 (task pipeline, internally sequential)
- Group D: Phase 8 (tip generation)
- Group E: Phase 9 → 9b (reclassification pipeline)

**Stage 3 (sequential — depends on Stage 2 decay):**
Phase 4 (orphan cleanup) — must run after decay creates orphans

**Alternative considered:** Full DAG scheduler with per-phase dependency declarations. Rejected — adds complexity for marginal gain over the 3-stage approach.

### D2: Batch conflict resolution — Collect-then-flush

**Decision:** In Phase 3d's inner loop, collect invalidation IDs and pending-conflict clear pairs into arrays, then issue batch calls at the end of each LLM chunk. Uses existing `invalidateMemories()` and `clearPendingConflictsBatch()`.

**Alternative considered:** Per-pair calls with Promise.all parallelism. Rejected — still N round-trips; batching reduces to 2 total.

### D3: Noise pattern consolidation — Single combined regex

**Decision:** Join the 7 noise patterns into one alternation group `(?:pattern1|pattern2|...)` and issue a single `deleteMemoriesByPattern` call.

**Alternative considered:** New `deleteMemoriesByPatterns(patterns[])` method with UNWIND. Rejected — single combined regex is simpler and Neo4j's regex engine handles alternation efficiently.

### D4: TaskId index — Standard B-tree property index

**Decision:** Add `CREATE INDEX memory_taskId_index IF NOT EXISTS FOR (m:Memory) ON (m.taskId)` in `ensureIndexes()`. B-tree is correct for equality lookups.

### D5: Health check — setInterval with unref

**Decision:** 60-second interval calling `verifyConnection()`. Timer uses `.unref()` to avoid blocking process exit. Cleared in service `stop()`.

### D6: Embedding pre-warm — Core memories at startup

**Decision:** After `db.ensureInitialized()` in service `start()`, load up to 10 core memories and embed them via `embedBatch()`. Wrapped in try/catch — failure is non-fatal.

## Risks / Trade-offs

- **[Risk] Parallel DB load during sleep cycle** → Neo4j connection pool (50 connections) can handle concurrent phases. Each phase uses short-lived sessions. Pool exhaustion is unlikely but monitored via existing metrics.
- **[Risk] Race condition in parallel phases** → Phases in Stage 2 operate on disjoint node sets (decay touches Memory importance/validity, noise cleanup touches Memory text patterns, task cleanup touches Memory taskId, tips generate new Memory nodes). No shared write targets.
- **[Risk] Combined noise regex exceeds Neo4j regex limit** → Neo4j has no documented regex length limit. The combined pattern is ~500 chars — well within practical bounds.
- **[Risk] Pre-warm adds startup latency** → Capped at 10 embeddings (~50-200ms total). Wrapped in catch so embedding failures don't block service start.
- **[Trade-off] Phase 4 must wait for all Stage 2 groups** → Orphan cleanup depends on decay completing. This means Stage 2's wall-clock is max(Group A through E), then Phase 4 adds ~5-10s. Acceptable — Phase 4 is fast.
