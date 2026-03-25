## 1. Centralized Cypher Safety

- [ ] 1.1 Add `safeCypherRelType()` to `schema.ts` that validates and returns relationship type string, throwing on invalid input
- [ ] 1.2 Replace all inline regex-then-interpolate sites in `neo4j-client-entity.ts` with `safeCypherRelType()` calls
- [ ] 1.3 Replace all inline regex-then-interpolate sites in `neo4j-client-sleep-conflict.ts` with `safeCypherRelType()` calls
- [ ] 1.4 Add `escapeLucene()` call inside `causalChainSearch` in `neo4j-client-search.ts`

## 2. Supply Chain and Transport Security

- [ ] 2.1 Pin GLiNER ONNX model SHA-256 hash in `extractor-local.ts` and add verification logic with fallback to regex-only on mismatch
- [ ] 2.2 Add HTTPS enforcement warning in `llm-client.ts` for non-localhost HTTP base URLs

## 3. Bounds and Sanitization

- [ ] 3.1 Cap decomposed fact count at 20 in `extractor-decompose.ts`
- [ ] 3.2 Batch the dedup UNWIND query in `neo4j-client-sleep.ts` into 5K chunks
- [ ] 3.3 Export `sanitizeMemoryText` from `extractor.ts` and use it in `reranker-llm.ts` replacing inline regex sanitization

## 4. Verification

- [ ] 4.1 Run existing tests to confirm no regressions (`pnpm test -- extensions/memory-neo4j/`)
- [ ] 4.2 Run format and lint checks (`pnpm check`)
