## Why

Extraction queries (33% MRR, 282 cases) ask for specific facts: "what did X say about Y?". These are currently routed to the LLM-temporal reranker, which is slow (~4–9s) and optimised for temporal relevance — not factual precision. The local cross-encoder reranker is faster (~50ms GPU) and better suited for fact retrieval. Routing extraction queries to the wrong reranker is a systematic precision loss.

## What Changes

- Add query-type detection at search entry point: classify incoming queries as `temporal | graph | extraction | updates | long`
- Route `extraction`-type queries to the local cross-encoder reranker (port 4124) instead of the LLM-temporal reranker
- Update `reranker-local.ts` to handle extraction scoring (currently tuned for general similarity — add extraction-specific prompt/scoring)
- Expose `reranker.extractionModel` config key for overriding the cross-encoder model for extraction use cases

## Capabilities

### Modified Capabilities

- `query-type-routing`: Extend existing type detection to explicitly handle extraction routing
- `reranker-local`: Add extraction-optimised scoring path

## Impact

- **Files:** `neo4j-client-search.ts` (routing logic), `reranker-local.ts` (extraction scoring)
- **Risk:** Low — additive routing change, existing paths unchanged
- **Expected gain:** +8–12pp MRR on extraction queries; significant latency improvement (9s → ~200ms)
- **Eval target:** ≥50% extraction MRR after fix
