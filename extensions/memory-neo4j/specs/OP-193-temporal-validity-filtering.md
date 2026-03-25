# OP-193: Tune Temporal Validity Filtering (validFrom/validUntil)

## Problem Statement

The `validfrom` eval ability scores 40% Recall@5 and 25% MRR. Queries asking for the
"current" value of a fact that has been updated over time fail to rank the most recent
memory high enough. The temporal freshness signal (OP-129) exists but is too selective
to differentiate candidates effectively.

## Current Behavior

### Storage

Memories are stored with temporal fields (`neo4j-client-memory.ts`):

- `validFrom`: ISO-8601 timestamp when the fact became true (defaults to `createdAt`)
- `validUntil`: ISO-8601 timestamp when the fact stopped being true (`null` = still valid)
- `supersededBy`: ID of the replacement memory (`null` = not superseded)

When conflict detection finds a SUPERSEDES relationship, `supersedeMemory()` sets
`validUntil = now` and `supersededBy = newId` on the old memory.

### Query-Time Filtering

- `buildTemporalFilter()` in `neo4j-client-search.ts` excludes expired memories
  (`validUntil IS NULL`) in Cypher queries — this works correctly.
- `buildFreshnessSignal()` in `search.ts` builds a synthetic ranking signal, but
  **only includes memories where `|validFrom - createdAt| > 7 days`**. This makes it
  a sparse signal — in the validfrom fixtures, only the gold memory (m1) participates,
  while all distractors are excluded. With no rank differentiation among non-participating
  candidates, the freshness weight (0.6 for "updates" queries) cannot overcome
  vector/BM25 similarity from 20 semantically-similar distractors.

### Why Recall Is Low

Each validfrom test case has:

- **m0**: outdated fact (`createdAt == validFrom` → excluded from freshness signal)
- **m1**: current fact (`validFrom` 45 days after `createdAt` → included, rank 1)
- **d1-d20**: distractors (`createdAt == validFrom` → all excluded)

m1 gets a freshness boost but competes against 20+ distractors that score well on
vector/BM25 and receive no freshness penalty. The RRF contribution from a single
freshness rank-1 entry is insufficient to lift m1 above the pack.

## Proposed Solution

### 1. Dense freshness signal for "updates" queries

When `queryType === "updates"`, include **all** candidates in the freshness signal
scored by `validFrom` recency — remove the 7-day gap requirement. This gives every
candidate a freshness rank, allowing RRF to properly differentiate:

- m1 (recent validFrom) → high freshness score, low rank number
- Distractors (old validFrom) → low freshness score, high rank number

For non-"updates" queries, keep the existing gap-based behavior to avoid regressions.

### 2. Increase freshness weight for "updates" queries

Bump the freshness weight from 0.6 to 1.5 for "updates" queries. With a dense signal,
this gives sufficient ranking power to surface the most temporally-recent memory.

### 3. Superseded memory penalty in RRF fusion

Apply a multiplicative penalty (0.3x) to memories with `supersededBy` set in the
fusion step. This ensures explicitly superseded memories rank below their replacements
even when vector/BM25 scores are similar. Requires propagating `supersededBy` through
the search signal results.

## Implementation Tasks

1. **`search.ts:buildFreshnessSignal`** — Add `queryType` parameter; when `"updates"`,
   skip the 7-day gap guard and include all candidates scored by validFrom recency.
2. **`search.ts:getAdaptiveWeights`** — Increase freshness weight for "updates" from
   0.6 to 1.5.
3. **`search.ts:hybridSearch`** — Pass `queryType` to `buildFreshnessSignal`.
4. **`schema.ts:SearchSignalResult`** — Add optional `supersededBy` field.
5. **`neo4j-client-search.ts`** — Return `supersededBy` from vector/BM25 Cypher queries.
6. **`search.ts:fuseWithConfidenceRRF`** — Apply supersededBy penalty to fused scores.

## Test Plan

- **Unit**: Extend `search.test.ts` with tests for dense freshness signal behavior
  (all candidates included for "updates", gap-based for others).
- **Unit**: Test supersededBy penalty in `fuseWithConfidenceRRF`.
- **Eval**: `openclaw memory neo4j eval --dataset custom --k 5 --limit 10 --no-judge`
  — validfrom ability Recall@5 should improve from 40% and MRR from 25%.
- **Regression**: Other abilities (extraction, graph, updates, abstention) should not
  degrade.
