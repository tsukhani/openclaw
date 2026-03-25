## Context

The memory-neo4j extension has 4 High-severity findings (all currently mitigated) and several Medium findings from a comprehensive code review. The fixes are localized — no architectural changes, no new dependencies, no data model migrations. Each fix strengthens an existing defense rather than adding new functionality.

## Goals / Non-Goals

**Goals:**

- Eliminate all 4 High-severity review findings
- Fix the 3 highest-impact Medium findings (decompose cap, UNWIND batching, sanitization unification)
- Keep changes minimal and contained within the extension

**Non-Goals:**

- Refactoring the overall extraction or search architecture
- Adding new features or capabilities
- Changing any public tool schemas or user-facing behavior
- Addressing Low-severity findings (acceptable risk)

## Decisions

### D1: Centralized `safeCypherRelType()` in schema.ts

**Choice:** Add a single function to `schema.ts` that validates and returns a relationship type string, throwing on invalid input. All Cypher interpolation sites call this instead of inline regex.
**Why not inline validation:** The current pattern (regex guard 5-15 lines before interpolation) is fragile. A centralized function makes the safety contract explicit and grep-able.
**Why schema.ts:** It already exports `sanitizeRelationshipType()` and `escapeLucene()` — this is the natural home for query-safety helpers.

### D2: Escape Lucene inside `causalChainSearch`

**Choice:** Call `escapeLucene(query)` at the top of `causalChainSearch`, matching what `structuredGraphSearch` already does.
**Why not rely on caller escaping:** Defense-in-depth — functions should be safe to call directly.

### D3: Pin GLiNER SHA-256 and log warning on mismatch

**Choice:** Compute and hardcode the SHA-256 of the current model file. On mismatch, log a warning and refuse to load the model (fall back to regex-only extraction).
**Why not fail hard:** Local extraction is a nice-to-have; regex extraction is the fallback. A hard failure would block all entity extraction on model updates until the hash is updated.

### D4: HTTPS warning via `log.warn` on LLM client init

**Choice:** When `baseUrl` uses `http://` and the host is not `localhost`/`127.0.0.1`/`::1`, emit a warning at client creation. Do not block the request.
**Why not block:** Some users legitimately run LLM providers on private networks over HTTP. A warning respects their agency while flagging the risk.

### D5: Cap decomposed facts at 20

**Choice:** After LLM decomposition, take only the first 20 facts. Log a debug message when truncating.
**Why 20:** A single memory text (capped at 4000 chars by `sanitizeMemoryText`) rarely contains more than 10-15 independent facts. 20 gives headroom while preventing runaway.

### D6: Batch UNWIND in dedup text fetch at 5K chunks

**Choice:** Split the `clusteredIds` array into chunks of 5000 and issue one UNWIND query per chunk, merging results.
**Why 5K:** Neo4j handles UNWIND of 5K IDs comfortably. The current worst case is 50K (DEDUP_MAX_MEMORIES), which means at most 10 queries — acceptable for a background sleep cycle.

### D7: Reuse `sanitizeMemoryText` in reranker-llm.ts

**Choice:** Export `sanitizeMemoryText` from `extractor.ts` (it is already a standalone function) and import it in `reranker-llm.ts`, replacing the inline regex sanitization.
**Why not a shared utils file:** `sanitizeMemoryText` is defined in `extractor.ts` and is already the canonical sanitizer. Moving it to a new file adds unnecessary churn. A direct import keeps the change minimal.

## Risks / Trade-offs

- **[D3] Model hash becomes stale on upstream updates** → Mitigation: Fall back to regex extraction on mismatch; document that the hash must be updated when upgrading the model.
- **[D6] Multiple queries slightly slower than single UNWIND** → Mitigation: Sleep cycle is a background process; 10 queries vs 1 is negligible.
- **[D7] Creates an import dependency from reranker to extractor** → Mitigation: Both are internal to the extension; the function has no side effects.
