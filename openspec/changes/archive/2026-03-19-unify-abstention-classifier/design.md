## Context

Abstention — returning empty rather than injecting low-confidence noise into context — is currently split across two independent code paths:

1. **Reranker path** (`reranker.ts:132–165`): when the reranker is active, a scalar `abstentionThreshold` check fires on cross-encoder scores. Skips temporal and graph-only queries.
2. **Non-reranker path** (`search.ts:576–614`): when the reranker is off, either the feature-based classifier or a legacy threshold mode runs on RRF scores. Skips graph-only queries.

The classifier (OP-137) is the default and only mode used in production. The reranker threshold (OP-131) is active but operates on a different score space with a different decision function. The search-level threshold mode is dead config.

After reranking, `.score` is overwritten with the cross-encoder `relevanceScore` (reranker.ts:119), so the classifier's `ScoredMemory.score` field works on both RRF and cross-encoder outputs without changes.

## Goals / Non-Goals

**Goals:**

- Single abstention code path that runs consistently regardless of reranker configuration
- Remove dead config (`abstention.mode`, `reranker.abstentionThreshold`) to reduce surface area
- Preserve all existing skip conditions (graph-only, temporal)

**Non-Goals:**

- Recalibrating classifier thresholds for cross-encoder score distributions (the current thresholds are conservative and safe on both score spaces; tuning is a separate effort)
- Adding new classifier features or signals
- Changing the reranker's `minScore` or `topJ` filtering — those are pre-abstention filters with different purposes

## Decisions

### 1. Move abstention out of the reranker, into search.ts as a unified post-filter

The classifier runs in `search.ts` after `rerankCandidates()` returns, on the final candidate list. This is the natural place: search.ts already orchestrates retrieval → reranking → delivery, and abstention is a delivery-gate decision.

**Alternative considered**: Run the classifier inside `reranker.ts` after the existing minScore/topJ filtering. Rejected because the reranker should focus on scoring and filtering — abstention is a search-level policy decision, and keeping it in `search.ts` makes the flow readable: retrieve → rerank → abstain? → deliver.

### 2. Detect temporal queries in search.ts using the exported `isTemporalQuery()`

The reranker currently knows if a query is temporal (line 60) and skips abstention for temporal queries. After moving abstention to search.ts, we need the same signal there. `isTemporalQuery()` is already exported from `reranker.ts` — import and call it in search.ts before the classifier.

**Alternative considered**: Have `rerankCandidates()` return a metadata object with `{ results, temporal }`. Rejected — heavier API change for a single boolean, and `isTemporalQuery()` is a pure function of `(query, queryType)`, both of which search.ts already has.

### 3. Remove `AbstentionConfig` type and `abstention` config section entirely

With only one mode remaining, the config section serves no purpose. The classifier has no user-facing knobs — it's a hardcoded feature-based decision. Remove the type from `schema.ts`, remove parsing from `config.ts`, and remove the parameter threading through `hybridSearch()`.

### 4. Remove `reranker.abstentionThreshold` from `RerankerConfig`

This field is only consumed by the abstention check in `reranker.ts:141–160`. After removing that check, the field has no readers. Remove it from the config type, parsing, and the eval variant.

### 5. Keep `reranker.minScore` unchanged

`minScore` is not abstention — it's a per-result quality floor that removes weak individual results while still returning the strong ones. Abstention is an all-or-nothing gate on the entire result set. These are orthogonal.

## Risks / Trade-offs

**[Classifier thresholds may be too lenient for cross-encoder scores]** → The classifier's global gate (maxScore < 0.35) is conservative on cross-encoder scores where irrelevant results typically score 0.0–0.2. This means the classifier will rarely abstain on reranked results unless they're truly garbage. This is the right default — better to surface a borderline result than to incorrectly abstain. Tuning can happen separately with eval data.

**[Config breakage for anyone setting `abstentionThreshold` or `abstention.mode`]** → Safe degradation: `assertAllowedKeys` will log a warning for unrecognized keys, and the classifier runs by default anyway. No silent behavior change — users who had threshold mode get the (better) classifier instead.

**[Eval variant `with-reranker-local` uses `abstentionThreshold: 0.95`]** → Remove the field from the variant. The eval will use the classifier instead. If eval results shift, that's expected and informative — it shows how the classifier behaves vs the old threshold.
