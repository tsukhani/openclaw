## ADDED Requirements

### Requirement: Independent sleep cycle phases run concurrently

The sleep cycle orchestrator SHALL execute independent phase groups concurrently using `Promise.all`, while maintaining sequential ordering for phases with data dependencies. The orchestrator SHALL use a three-stage execution model: Stage 1 (sequential enrichment pipeline), Stage 2 (parallel independent groups), Stage 3 (post-parallel cleanup).

#### Scenario: Parallel execution of independent groups in Stage 2

- **WHEN** the sleep cycle reaches Stage 2 (after extraction pipeline completes)
- **THEN** the decay pipeline (Phases 3/3b/3c/3d), noise+credential cleanup (Phases 5/5b), task pipeline (Phases 6/7), tip generation (Phase 8), and reclassification (Phases 9/9b) SHALL execute concurrently via `Promise.all`

#### Scenario: Sequential ordering preserved within dependent groups

- **WHEN** the decay pipeline group executes
- **THEN** Phase 3 (decay) SHALL complete before Phase 3b (temporal staleness), which SHALL complete before Phase 3c (retroactive conflict scan), which SHALL complete before Phase 3d (pending conflict retry)

#### Scenario: Orphan cleanup waits for parallel stage

- **WHEN** Stage 2 parallel groups complete
- **THEN** Phase 4 (orphan cleanup) SHALL execute in Stage 3 after all Stage 2 groups have finished, because decay in Stage 2 may create orphaned entities

#### Scenario: Abort signal respected across parallel groups

- **WHEN** the abort signal fires during Stage 2 parallel execution
- **THEN** all active phase groups SHALL check the abort signal and terminate gracefully

#### Scenario: Sleep cycle results aggregated from parallel groups

- **WHEN** all stages complete
- **THEN** the `SleepCycleResult` object SHALL contain the combined results from all phases regardless of execution order

### Requirement: Noise pattern cleanup uses single combined query

Phase 5 noise cleanup SHALL combine all noise regex patterns into a single alternation group and issue one `deleteMemoriesByPattern` call instead of sequential per-pattern calls.

#### Scenario: All noise patterns matched in one DB call

- **WHEN** Phase 5 noise cleanup executes
- **THEN** the system SHALL issue exactly 1 `deleteMemoriesByPattern` call with a combined regex pattern `.*(?:pattern1|pattern2|...pattern7).*`

### Requirement: Conflict resolution uses batched DB operations

Phase 3d pending conflict retry SHALL collect all invalidation and clear-pending decisions per LLM chunk, then issue batch calls using `invalidateMemories()` and `clearPendingConflictsBatch()`.

#### Scenario: Batch invalidation after chunk processing

- **WHEN** a chunk of conflict pairs has been resolved by the LLM
- **THEN** the system SHALL issue at most 2 DB calls per chunk (one `invalidateMemories` for all losers, one `clearPendingConflictsBatch` for all resolved pairs) instead of 2 calls per pair

### Requirement: Memory.taskId property has a database index

The `ensureIndexes` function SHALL create a B-tree index on `Memory.taskId` to support efficient Phase 7 task-memory lookups.

#### Scenario: Index created on initialization

- **WHEN** the Neo4j client initializes and ensures indexes
- **THEN** the system SHALL execute `CREATE INDEX memory_taskId_index IF NOT EXISTS FOR (m:Memory) ON (m.taskId)`
