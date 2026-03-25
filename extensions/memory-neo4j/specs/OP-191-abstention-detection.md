# OP-191: Fix Abstention Detection in memory-neo4j

## Problem Statement

The memory-neo4j eval harness reports **0% Recall, 0% MRR, 0% Hit Rate** on all 10 abstention test cases. The system retrieves distractor memories instead of recognizing that the query has no answerable content in the memory store.

## Current Behavior Analysis

### Root Cause: Max-Normalization Defeats the Classifier

The abstention classifier (`abstention-classifier.ts`, OP-137) checks:

- `maxScore < 0.35 AND meanScore < 0.25` → abstain
- `queryType === "long" AND candidates.length < 2 AND maxScore < 0.5` → abstain

However, **these thresholds never trigger** because:

1. **Signal normalization** (`normalizeSignalScores`, search.ts:249): divides all scores by the max, so the top signal result always gets score 1.0.
2. **Final score normalization** (search.ts:1082): `normalizer = 1 / maxBoosted` — divides all RRF+recency scores by the max, so the top result always gets score ~1.0.
3. The classifier receives `finalResults` where `maxScore ≈ 1.0` **always**, making `maxScore < 0.35` impossible.

### Why Distractor Memories Score High

Abstention test cases deliberately include topically related memories (e.g., food preferences when asking about dessert). These get high vector cosine similarity (0.7–0.85) because they share semantic space, even though they don't contain the specific answer.

After max-normalization, the top distractor always gets score 1.0 — indistinguishable from a genuine match.

## Proposed Solution

### Strategy: Pass Pre-Normalization Confidence to Classifier

Add a `rawMaxScore` parameter representing the **pre-normalization max boosted RRF score**. This preserves absolute retrieval confidence that max-normalization erases.

Additionally, add **score gap analysis** on normalized scores: when all top-k results have tightly clustered scores (small spread), no single result stands out — a hallmark of distractor-only retrieval.

### Abstention Classifier v2 — Decision Logic

```
shouldAbstain(candidates, queryType, rawMaxScore):
  1. Empty candidates → abstain (unchanged)
  2. rawMaxScore < RAW_SCORE_FLOOR → abstain
     (absolute retrieval confidence too low)
  3. Score gap analysis: if top-k scores are tightly clustered
     (spread < CLUSTER_THRESHOLD) AND rawMaxScore < RAW_SCORE_SOFT_CEIL → abstain
     (no standout result + moderate absolute confidence = likely absent)
  4. Existing long-query gate (adjusted thresholds)
```

### Thresholds (v2)

- `RAW_SCORE_FLOOR`: Minimum raw RRF+recency score below which we always abstain. Calibrated from eval data.
- `CLUSTER_THRESHOLD`: Maximum score spread (max - min among top-k normalized scores) below which results are considered "clustered" (no standout).
- `RAW_SCORE_SOFT_CEIL`: Below this raw score, clustering triggers abstention even if individual normalized scores look OK.

### Integration in search.ts

At the abstention decision point (line 1146+):

1. Compute `rawMaxScore = maxBoosted` (the pre-normalization maximum)
2. Pass to `shouldAbstain(finalResults, queryType, rawMaxScore)`
3. Skip conditions (graph-only, temporal) remain unchanged

## Implementation Tasks

1. **`abstention-classifier.ts`**: Add `rawMaxScore` parameter; implement raw score floor check and score gap/cluster analysis.
2. **`search.ts`**: Pass `maxBoosted` to `shouldAbstain` at the abstention decision point.
3. **`abstention-classifier.test.ts`**: Update tests for new parameter and add score-gap test cases.
4. **Eval verification**: Run abstention eval cases, tune thresholds if needed.

## Test Plan

1. **Unit tests** (`abstention-classifier.test.ts`):
   - Empty candidates → abstain (unchanged)
   - Low rawMaxScore → abstain regardless of normalized scores
   - High rawMaxScore + spread results → don't abstain
   - High rawMaxScore + clustered results → abstain (score gap trigger)
   - Moderate rawMaxScore + clustered → abstain
   - Moderate rawMaxScore + spread → don't abstain
   - Long-query gate still applies
   - Edge cases (single candidate, score=0, score=1.0)

2. **Integration test** (eval harness):
   - `openclaw memory neo4j eval --dataset abstention --k 5 --no-judge --format console`
   - Abstention ability should improve from 0%
   - Cross-check: `--dataset extraction`, `--dataset temporal`, `--dataset graph` should not regress

3. **Build gate**: `pnpm build` must pass (module boundary / lazy-loading check).
