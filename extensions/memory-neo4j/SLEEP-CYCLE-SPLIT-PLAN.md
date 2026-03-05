# sleep-cycle.ts Split Plan

Current: 1659 LOC — candidate for splitting into focused modules.

## Proposed Module Structure

### `sleep-cycle-types.ts` (~130 LOC)

All exported types and interfaces:

- `SleepCycleResult`
- `SleepCycleOptions`
- `CREDENTIAL_PATTERNS` + `detectCredential()`

### `sleep-phases-dedup.ts` (~350 LOC)

Phase 1 group — all deduplication work:

- Phase 1: Vector deduplication (`runVectorDedup`)
- Phase 1b: Semantic dedup (`runSemanticDedup`)
- Phase 1c: Conflict detection (`runConflictDetection`)
- Phase 1d: Entity dedup (`runEntityDedup`)

### `sleep-phases-extract.ts` (~200 LOC)

Phase 2 group — extraction and tagging:

- Phase 2: Entity extraction (`runExtraction`)
- Phase 2b: Retroactive tagging (`runRetroactiveTagging`)

### `sleep-phases-decay.ts` (~250 LOC)

Phase 3 group — memory decay and staleness:

- Phase 3: Decay/pruning (`runDecay`)
- Phase 3b: Temporal staleness (`runTemporalStaleness`)
- Phase 3c: Retroactive conflict scan (`runRetroactiveConflictScan`)

### `sleep-phases-cleanup.ts` (~200 LOC)

Phase 4-5 group — cleanup and security:

- Phase 4: Orphan cleanup (`runOrphanCleanup`)
- Phase 5: Noise pattern cleanup (`runNoiseCleanup`)
- Phase 5b: Credential scan (`runCredentialScan`)

### `sleep-phases-tasks.ts` (~300 LOC)

Phase 6-7 group — task lifecycle:

- Phase 6: Task ledger cleanup (`runTaskLedger`)
- Phase 7: Task-memory cleanup (`runTaskMemoryCleanup`)
- Tip generation prompt constant

### `sleep-phases-tips.ts` (~150 LOC)

Phase 8:

- Phase 8: Tip generation (`runTipGeneration`)

### `sleep-cycle.ts` residual (~80 LOC)

Pure orchestrator:

- `runSleepCycle()` — calls phase runners in order, aggregates result
- Imports from all phase modules
- Re-exports `SleepCycleResult`, `SleepCycleOptions` for external consumers

## Migration Notes

- All phase runner functions accept `(db, embeddings, config, logger, options, result, abortSignal)` signature
- `result` is passed by reference (mutated in place) — no return value needed per phase
- `CREDENTIAL_PATTERNS` + `detectCredential` move to `sleep-cycle-types.ts` (also used in tests)
- `classifyTaskMemory` prompt constant stays in `sleep-phases-tasks.ts`
- `TIP_GENERATION_PROMPT` stays in `sleep-phases-tips.ts`
- All test files targeting phases should import from the new phase modules directly

## Why Not Now

Split is pure refactor (zero behavior change). Low risk but high merge surface — best done
after all P0/P1 fixes are merged and the branch is stable.
