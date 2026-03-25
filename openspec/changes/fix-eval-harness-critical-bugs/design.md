## Context

The memory-neo4j eval harness (`extensions/memory-neo4j/eval/`) orchestrates retrieval quality evaluation across custom fixtures, LoCoMo, and LongMemEval datasets. Four bugs were identified during code review that affect data flow correctness, metric accuracy, and cleanup safety.

All fixes are localized to the eval subsystem with no cross-module API changes.

## Goals / Non-Goals

**Goals:**

- Ensure `validFrom` values from fixtures reach Neo4j storage so the OP-129 freshness signal is actually tested
- Give the context completeness LLM judge access to the golden answer for more accurate verdicts
- Prevent empty-gold-set cases (LongMemEval, abstention) from silently distorting aggregate retrieval metrics
- Scope entity cleanup to the eval agent's namespace to prevent data loss in shared environments

**Non-Goals:**

- Changing retrieval metric formulas or scoring behavior
- Altering the public API of `runEval` or `runAbComparison`
- Adding new eval capabilities, metrics, or datasets

## Decisions

### 1. validFrom mapping — use `mem.validFrom ?? mem.createdAt`

One-line fix in `storeTestMemories`. The `TestMemory` type already declares `validFrom?: string`. The harness should prefer the explicit `validFrom` when present, falling back to `createdAt` for backward compatibility with fixtures that don't set it.

**Alternative**: Always require `validFrom` in fixtures. Rejected — most fixtures (extraction, temporal, multi-session) don't need it; forcing them to duplicate `createdAt` adds noise.

### 2. Context completeness — pass `golden_answer` to judge

Add `goldenAnswer` parameter to `evaluateContextCompleteness()` and `LlmJudge.judgeContextCompleteness()`. Include the golden answer in the judge prompt as a reference for what constitutes a complete answer, without revealing it as the expected output.

Prompt addition: `"Reference answer (for evaluator use only — assess whether the context COULD support this answer): ${goldenAnswer}"`

**Alternative**: Leave the judge without golden_answer and rely on Tier 2 E2E for accuracy. Rejected — Tier 1 is the primary signal for most eval runs (Tier 2 is opt-in), so its accuracy matters.

### 3. Empty-gold-set metric handling — flag and filter

Add `emptyGoldSet: boolean` to `CaseRetrievalMetrics`. Set it when `goldIds.length === 0`. In `computeAggregateNumerics`, split computation: include all cases in caseCount but exclude `emptyGoldSet` cases from retrieval metric averages (precision, recall, F1, MRR, NDCG, hitRate). This prevents LongMemEval's vacuous recall=1.0 from inflating aggregates while still counting these cases in total.

When all cases have empty gold sets (e.g., pure LongMemEval run), metrics will be 0 with caseCount reflecting the actual count — the user should rely on context completeness instead.

**Alternative**: Warn in the console reporter but still include them. Rejected — a warning doesn't fix the metric distortion; downstream CI regression checks would still compare distorted values.

### 4. Orphan cleanup — scope by eval agent IDs

After deleting stored memories by ID, the harness should skip the global `findOrphanEntities()` call. Entity nodes created during entity extraction are linked to memory nodes via MENTIONS relationships. When the memory nodes are deleted, those MENTIONS become dangling, but the Entity nodes themselves may be shared with other agents. The eval harness should only delete entities it created.

Approach: track entity IDs created during `extractMemoriesInBatches` and delete only those after memory cleanup, rather than scanning globally for orphans.

**Alternative**: Filter `findOrphanEntities` by a prefix/label. Rejected — Entity nodes don't carry agentId; adding one is a schema change out of scope.

**Simpler alternative chosen**: Skip orphan entity cleanup entirely during eval runs. Eval entities are ephemeral and will be cleaned up by the next sleep cycle. The risk of stale eval entities is minimal (small count, scoped to eval namespace prefixes), while the risk of deleting production entities is real.

## Risks / Trade-offs

- **Context completeness prompt change**: Adding golden_answer to the judge prompt could cause the judge to anchor on it too heavily (checking for exact match rather than sufficiency). Mitigated by prompt wording that frames it as a reference, not a target.
- **Metric filtering for empty gold sets**: Runs with only empty-gold-set cases (pure LongMemEval) will show 0 for all retrieval metrics. This is correct but may surprise users. The console reporter should note this.
- **Skipping orphan cleanup**: Eval entity nodes will persist until the next sleep cycle. Acceptable trade-off vs. the data loss risk.
