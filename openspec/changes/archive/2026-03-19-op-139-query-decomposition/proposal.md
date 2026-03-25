## Why

Compound extraction queries ("what did he say about his company and his family?") retrieve a single memory node and often miss partial matches. The system needs to decompose multi-part queries into atomic sub-queries, retrieve memories for each independently, then merge and deduplicate results. This mirrors how a human analyst would break a complex question into focused searches.

## What Changes

- Add a `QueryDecomposer` that uses a lightweight LLM call to split compound queries into ≤4 atomic sub-queries
- Run parallel retrieval for each sub-query (Promise.all)
- Merge results with RRF fusion, deduplicating by memory ID
- Gate behind config: `search.queryDecomposition.enabled` (default: false for now — enable after eval validates)
- Add decomposition to the eval harness so we can measure per-subquery recall

## Capabilities

### New Capabilities

- `query-decomposition`: Split compound queries into atomic sub-queries before retrieval

## Impact

- **Files:** New `query-decomposer.ts`, `neo4j-client-search.ts` (decomposition integration)
- **Risk:** Medium — adds LLM call latency per decomposed query; mitigated by parallel execution + config flag
- **Expected gain:** +5–8pp MRR on extraction queries (combined with OP-138)
- **Eval target:** ≥60% extraction MRR after OP-138 + OP-139
