## Why

A comprehensive code review of the memory-neo4j extension identified 4 High-severity and 20 Medium-severity issues across security, correctness, and reliability dimensions. All High issues are currently mitigated by surrounding code, but are fragile under refactoring. Fixing them now prevents latent vulnerabilities from becoming exploitable as the codebase evolves.

## What Changes

- Centralize relationship type Cypher interpolation into a single `safeCypherRelType()` helper, replacing 6+ scattered regex-then-interpolate sites
- Add `escapeLucene()` inside `causalChainSearch` so it is safe when called directly
- Pin GLiNER ONNX model SHA-256 hash to prevent supply chain attacks via compromised CDN
- Add HTTPS enforcement warning for non-localhost LLM `baseUrl` values
- Cap decomposed fact count at 20 to bound unbounded LLM output
- Batch the dedup UNWIND query into chunks of 5K to prevent Neo4j memory pressure
- Unify memory text sanitization by reusing `sanitizeMemoryText()` in the LLM reranker

## Capabilities

### New Capabilities

- `cypher-injection-hardening`: Centralized Cypher interpolation safety for relationship types and Lucene queries

### Modified Capabilities

- `autocapture-quality-gates`: Add fact decomposition cap and unified sanitization
- `instruction-detection`: Strengthen supply chain integrity for local model downloads

## Impact

- `extensions/memory-neo4j/schema.ts` — new `safeCypherRelType()` export
- `extensions/memory-neo4j/neo4j-client-entity.ts` — refactor 3+ interpolation sites
- `extensions/memory-neo4j/neo4j-client-sleep-conflict.ts` — refactor 2+ interpolation sites
- `extensions/memory-neo4j/neo4j-client-search.ts` — add Lucene escaping in `causalChainSearch`
- `extensions/memory-neo4j/extractor-local.ts` — pin model SHA-256
- `extensions/memory-neo4j/llm-client.ts` — HTTPS enforcement warning
- `extensions/memory-neo4j/extractor-decompose.ts` — cap fact count
- `extensions/memory-neo4j/neo4j-client-sleep.ts` — batch UNWIND
- `extensions/memory-neo4j/reranker-llm.ts` — use shared sanitization
- `extensions/memory-neo4j/extractor.ts` — export `sanitizeMemoryText` for reuse
