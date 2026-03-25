# OP-194: Improve Knowledge Update Detection

## Problem Statement

The "updates" eval ability tests queries about information that has changed over time
(e.g. "When was Tarun's API key last rotated?", "What is the current revenue target?").
The system should retrieve the **latest/correct** version. Current metrics:

- **Recall@5**: 50%
- **MRR**: 31.7%
- **Hit Rate**: 50%

The system finds the right memory half the time but often returns stale/superseded
versions ranked equally or higher than the correct one.

## Root Cause Analysis

### How supersededBy/invalidateMemory currently work

1. **`supersedeMemory(oldId, newId)`** (`neo4j-client-sleep-conflict.ts:122-135`):
   Sets `validUntil = now` and `supersededBy = newId` on the old memory. Used by
   conflict detection when a newer memory updates/contradicts an existing one.

2. **`invalidateMemory(session, id)`** (`neo4j-client-sleep-conflict.ts:85-93`):
   Sets `importance = 0.01` to effectively retire the memory without deletion.

3. **Search temporal filter** (`neo4j-client-search.ts:27-48`):
   `buildTemporalFilter()` adds `AND node.validUntil IS NULL` by default, which
   correctly excludes superseded memories from vector/BM25/graph signals.

### Why the search pipeline fails for "updates" queries

The temporal filter works for memories explicitly marked as superseded. However, the
**freshness signal** (`search.ts:296-327`) — which is the primary ranking mechanism
for "updates" queries (weight 0.6) — has a critical blind spot:

```
buildFreshnessSignal() only includes candidates where
|validFrom - createdAt| > 7 days
```

For memories where `validFrom` defaults to `createdAt` (which is the common case for
both eval fixtures and real-world memories without explicit backdating), the freshness
signal produces **zero candidates**. The 0.6 freshness weight in RRF is entirely wasted.

The only remaining temporal signal is the post-RRF recency boost (`recencyWeight = 0.1`),
which is far too weak to distinguish the newest memory among 20+ semantically similar
candidates about the same topic.

## Proposed Solution

### Fix 1: createdAt-based freshness fallback for "updates" queries

Modify `buildFreshnessSignal` to accept a `queryType` parameter. When `queryType === "updates"`,
fall back to `createdAt`-based freshness scoring for candidates where `validFrom` is not
informative (i.e. `validFrom === createdAt` or `validFrom` is missing). This activates the
0.6 RRF freshness weight for "updates" queries.

### Fix 2: Query-adaptive recency weight

Make the post-RRF recency weight adaptive to query type. For "updates" queries, use a higher
recency weight (0.3 instead of 0.1) so that even after RRF fusion, the most recently created
memories get an additional ranking boost.

### Fix 3: Superseded memory demotion (defense in depth)

Add a post-RRF demotion step that penalizes candidates with `supersededBy` set, for cases
where `includeExpired=true` or point-in-time (`asOf`) queries return superseded memories.
This is defense-in-depth — the temporal filter already excludes them in normal search, but
the demotion ensures they rank last if they somehow appear.

## Implementation Tasks

1. **`search.ts: buildFreshnessSignal`** — Add `queryType` parameter; for `"updates"`,
   include candidates using `createdAt` when `validFrom` is not informative.
2. **`search.ts: hybridSearch`** — Pass `queryType` to `buildFreshnessSignal`.
3. **`search.ts: hybridSearch`** — Make recency weight adaptive: 0.3 for "updates", 0.1 default.
4. **`search.ts`** — Add `demoteSupersededCandidates()` post-RRF step that applies a score
   penalty to any candidate with `supersededBy` set (requires fetching the property in
   vector/BM25 Cypher queries).
5. **`neo4j-client-search.ts`** — Return `supersededBy` from vector/BM25 queries for demotion.
6. **Unit tests** — Verify freshness signal produces candidates for "updates" queries with
   `validFrom === createdAt`.

## Test Plan

1. **Unit test**: `buildFreshnessSignal` with `queryType="updates"` produces non-empty results
   for candidates where `validFrom === createdAt`.
2. **Unit test**: `buildFreshnessSignal` with `queryType="default"` still skips candidates
   where `validFrom === createdAt` (no regression).
3. **Eval harness**: Run `openclaw memory neo4j eval --dataset custom --k 5 --limit 10 --no-judge --format console`
   and verify "updates" ability metrics improve from 50% Recall / 31.7% MRR.
4. **Build**: `pnpm build` passes.
