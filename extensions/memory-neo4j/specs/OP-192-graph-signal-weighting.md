# OP-192: Improve Graph Signal Weighting for Multi-Hop Traversal

## Problem Statement

The eval harness graph ability tests show poor ranking metrics despite gold memories being found:

- **Recall@5**: 50% (memories are retrieved but not in top 5)
- **MRR**: 16.2% (gold results ranked low)
- **NDCG**: 24.5% (poor ranking quality)

Graph test cases require multi-hop entity relationship traversal (e.g., "What is Ahmad Riza's
company AI training budget?" requires Ahmad Riza → TechPact Solutions → budget). The gold memory
often lacks query keywords entirely and is only reachable via entity graph traversal. When found,
it's consistently outranked by vector/BM25 hits from distractor memories that share surface-level
keyword overlap (e.g., other budget-related memories for Ahmad Riza).

## Current Graph Signal Analysis

### Adaptive Weights (getAdaptiveWeights)

Graph weights are significantly lower than vector/BM25 across all query types:

| Query Type | Vector | BM25 | Graph | Freshness |
| ---------- | ------ | ---- | ----- | --------- |
| entity     | 0.8    | 1.0  | 0.4   | 0.2       |
| causal     | 0.9    | 0.7  | 0.5   | 0.1       |
| short      | 0.8    | 1.2  | 0.3   | 0.2       |
| default    | 1.0    | 1.0  | 0.3   | 0.2       |
| long       | 1.2    | 0.7  | 0.3   | 0.2       |
| extraction | 1.1    | 1.1  | 0.3   | 0.0       |

For entity queries (the primary type for graph test cases), graph weight is 0.4 — less than
half of BM25 (1.0). This means even when graph traversal correctly identifies the gold memory,
it can't outrank keyword-matching distractors.

### RRF Fusion Mechanics

The confidence-weighted RRF formula: `score += weight × signal_score / (k + rank)`

With k=60 and normalized scores, a graph-found memory at rank 1 with score 1.0 contributes:
`0.4 × 1.0 / (60 + 1) = 0.00656` from graph signal.

A distractor at vector rank 3 with score 0.85 contributes:
`0.8 × 0.85 / (60 + 3) = 0.01079` from vector alone.

The vector signal for a distractor easily overwhelms the graph signal for the correct answer.

### Secondary Signal Stacking

MPFP weight (0.2) can supplement graph signal for entity queries, but together graph + MPFP
= 0.6, still below a single vector signal (0.8). The problem compounds because distractors
often appear in multiple signals (vector + BM25) while graph-only hits appear in one.

## Proposed Changes

### 1. Increase Graph Weights for Entity and Causal Queries

Entity queries are the primary beneficiary — these are the queries that require multi-hop
traversal. Increase graph weight from 0.4 to 0.9, making it the dominant signal for entity
queries (matching the intent that graph traversal should be the primary retrieval mechanism).

For causal queries, increase from 0.5 to 0.7 (graph causal chains are important but shouldn't
fully dominate over semantic similarity).

Modestly increase default/short/long graph weights from 0.3 to 0.4 as a general lift.

### 2. Increase MPFP Weight for Entity Queries

MPFP meta-path traversal complements structured graph search by finding paths through
SIMILAR/EXTRACTED_FROM edges. For entity queries, increase MPFP weight from 0.2 to 0.35
to further reinforce graph-discovered memories.

### New Weight Table

| Query Type | Vector | BM25 | Graph | Freshness | Notes                            |
| ---------- | ------ | ---- | ----- | --------- | -------------------------------- |
| entity     | 0.8    | 1.0  | 0.9   | 0.2       | Graph now dominant signal        |
| causal     | 0.9    | 0.7  | 0.7   | 0.1       | Stronger graph for causal chains |
| short      | 0.8    | 1.2  | 0.4   | 0.2       | Modest lift                      |
| default    | 1.0    | 1.0  | 0.4   | 0.2       | Modest lift                      |
| long       | 1.2    | 0.7  | 0.4   | 0.2       | Modest lift                      |
| extraction | 1.1    | 1.1  | 0.3   | 0.0       | Unchanged (keyword precision)    |
| updates    | 1.0    | 1.0  | 0.3   | 0.6       | Unchanged (freshness focus)      |

### 3. Entity-Aware MPFP Weight Boost

When query type is "entity", boost MPFP signal weight from default 0.2 to 0.35 to reinforce
graph-discovered paths through meta-path traversal.

## Implementation Tasks

1. Update `getAdaptiveWeights()` in `search.ts` with new weight values
2. Add entity-aware MPFP weight boost in `hybridSearch()` orchestrator
3. Update unit tests in `search.test.ts` for new weight values
4. Verify with eval harness: graph MRR should improve from 16.2%

## Test Plan

1. **Unit tests**: Update `getAdaptiveWeights` tests to match new values
2. **Scoped eval**: `openclaw memory neo4j eval --dataset custom --k 5 --limit 10 --no-judge --format console`
   - Graph ability MRR should improve from 16.2%
   - Extraction/temporal/multi-session abilities should not regress
3. **Build gate**: `pnpm build` must pass
