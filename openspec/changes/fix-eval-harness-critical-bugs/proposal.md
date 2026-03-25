## Why

Code review of the memory-neo4j eval harness uncovered four bugs that compromise evaluation accuracy. The most critical silently drops the `validFrom` field, making all validfrom ability tests measure noise instead of the OP-129 freshness signal. The remaining three reduce verdict accuracy, distort aggregate metrics, and risk data loss in shared Neo4j environments.

## What Changes

- **Bug fix (critical)**: `storeTestMemories` in `harness.ts` maps `validFrom: mem.createdAt` instead of `validFrom: mem.validFrom ?? mem.createdAt`, silently discarding the fixture's `validFrom` field and breaking all 10 validfrom test cases
- **Bug fix**: `evaluateContextCompleteness` never passes `golden_answer` to the LLM judge, forcing the judge to guess what a complete answer requires instead of checking against the reference
- **Bug fix**: LongMemEval cases have `gold_memory_ids: []`, triggering the abstention handler (recall=1.0, precision=0) which silently distorts overall retrieval metrics when mixed with other datasets
- **Bug fix**: `findOrphanEntities()` during eval cleanup scans globally rather than per-agent, risking deletion of entities belonging to other agents or production data sharing the same Neo4j instance

## Capabilities

### New Capabilities

- `eval-harness-correctness`: Fixes to eval harness data flow, metric accuracy, and cleanup safety

### Modified Capabilities

## Impact

- `extensions/memory-neo4j/eval/harness.ts` — validFrom mapping fix, scoped orphan cleanup
- `extensions/memory-neo4j/eval/metrics/context-completeness.ts` — accept and forward golden_answer
- `extensions/memory-neo4j/eval/judges/llm-judge.ts` — accept golden_answer in context completeness prompt
- `extensions/memory-neo4j/eval/metrics/retrieval.ts` — annotate empty-gold cases in aggregation
- `extensions/memory-neo4j/eval/types.ts` — add `emptyGoldSet` flag to CaseRetrievalMetrics
