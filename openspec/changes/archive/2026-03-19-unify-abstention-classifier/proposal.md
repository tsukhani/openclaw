## Why

The memory-neo4j extension has two independent abstention mechanisms that evolved separately: a legacy scalar threshold (OP-131) and a feature-based classifier (OP-137). The classifier is strictly superior — multi-signal, query-type-aware, and well-tested — but it only runs when the reranker is disabled. When the reranker is active, abstention falls back to the legacy threshold, which is a single `topScore < N` check with no query-type awareness. This creates inconsistent abstention behavior depending on whether reranking is on or off, and leaves dead config (`abstention.mode: "threshold"`) that no production deployment uses.

## What Changes

- **BREAKING**: Remove the `abstention.mode` config option and the legacy `"threshold"` mode in `search.ts` (OP-131 search-level path). The classifier is now the only abstention strategy.
- **BREAKING**: Remove the `reranker.abstentionThreshold` config field and its check in `reranker.ts`. The reranker no longer performs its own abstention.
- Run the classifier as a unified post-filter in `search.ts` on **both** the reranker and non-reranker paths, after reranking completes but before delivery.
- Preserve all existing classifier skip conditions: graph-only results bypass abstention on both paths.
- Preserve the temporal query skip: the classifier should not run on temporal/LLM-reranked results (same reasoning as the current reranker threshold skip).

## Capabilities

### New Capabilities

- `unified-abstention`: Single abstention classifier that runs post-retrieval on both reranker and non-reranker paths, replacing the dual threshold/classifier system.

### Modified Capabilities

None — no existing specs are affected.

## Impact

- **Code**: `extensions/memory-neo4j/reranker.ts` (remove lines 132–165), `extensions/memory-neo4j/search.ts` (restructure lines 562–615 to run classifier unconditionally), `extensions/memory-neo4j/config.ts` (remove abstention mode parsing), `extensions/memory-neo4j/schema.ts` (remove `AbstentionConfig` type or simplify it).
- **Config**: `reranker.abstentionThreshold` and `abstention.mode` become unrecognized config keys. Any deployment setting these will see no effect (safe degradation — classifier runs by default anyway).
- **Eval**: `eval/variants.ts` references `abstentionThreshold: 0.95` in the `with-reranker-local` variant; needs updating.
- **Tests**: `abstention-classifier.test.ts` is unaffected (tests the classifier directly). No existing tests cover the threshold path.
