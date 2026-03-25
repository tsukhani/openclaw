## 1. Sleep Cycle Parallelization

- [x] 1.1 Restructure `sleep-cycle.ts` to use three-stage execution: Stage 1 (sequential enrichment pipeline: phases 1/1c/1d/2/2b/2c), Stage 2 (parallel independent groups via Promise.all), Stage 3 (orphan cleanup after parallel stage)
- [x] 1.2 Verify abort signal propagation works correctly across parallel Promise.all groups
- [x] 1.3 Verify SleepCycleResult aggregation is correct when phases write to shared result object from parallel groups

## 2. Batch Conflict Resolution

- [x] 2.1 Refactor `runPendingConflictRetry` in `sleep-phases-decay.ts` to collect invalidation IDs and clear-pending pairs per chunk, then call `invalidateMemories()` and `clearPendingConflictsBatch()` once per chunk instead of per-pair

## 3. Noise Pattern Consolidation

- [x] 3.1 Refactor `runNoiseCleanup` in `sleep-phases-cleanup.ts` to combine 7 noise patterns into a single alternation regex and issue one `deleteMemoriesByPattern` call

## 4. TaskId Index

- [x] 4.1 Add `CREATE INDEX memory_taskId_index IF NOT EXISTS FOR (m:Memory) ON (m.taskId)` to `ensureIndexes` in `neo4j-client-indexes.ts`

## 5. Service Lifecycle Performance

- [x] 5.1 Add 60-second connection health check interval in `index.ts` service `start()`, with `.unref()` and cleanup in `stop()`
- [x] 5.2 Add embedding cache pre-warming in `index.ts` service `start()`: load up to 10 core memories and call `embedBatch()` when `autoRecall` is enabled, wrapped in try/catch

## 6. Testing

- [x] 6.1 Update `sleep-cycle.orchestrator.test.ts` to verify parallel execution (Stage 2 groups run concurrently) and result aggregation
- [x] 6.2 Verify existing sleep cycle tests still pass with the restructured orchestrator
