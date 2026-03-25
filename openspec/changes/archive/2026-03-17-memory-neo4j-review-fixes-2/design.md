## Context

The memory-neo4j extension has 4 medium-severity issues from code review:

1. `deleteMemoriesByPattern()` in `neo4j-client-memory.ts:316-340` accepts user-supplied regex with only a 200-char length cap. Pathological patterns like `(a+)+$` can cause catastrophic backtracking in Neo4j's regex engine.
2. `batchEntityOperations()` in `neo4j-client-entity.ts:137-149` runs a separate `tx.run()` per entity that has structured properties (phone, email, etc.), creating N round-trips within a single transaction.
3. The auto-capture pipeline in `auto-capture.ts:269-282` performs semantic dedup (paraphrase detection) in the 0.75-0.95 similarity band but does not check for contradictions. Contradictory memories coexist until the next sleep cycle's conflict detection phase (1c).
4. `isNeo4jConnectionError()` in `errors.ts:18-40` uses `String(err).includes(...)` for connection pool and network errors instead of checking structured error properties (`code`, `errno`).

## Goals / Non-Goals

**Goals:**

- Block ReDoS-capable regex patterns before they reach Neo4j.
- Reduce entity property writes from O(N) round-trips to O(1).
- Detect and handle contradictions at capture time, closing the inter-sleep-cycle gap.
- Make connection error classification resilient to driver message changes.

**Non-Goals:**

- Replacing Neo4j's regex engine or switching to a safe-regex library (too heavy for this scope).
- Rewriting the entire entity batch pipeline (only the property-write loop needs fixing).
- Full-fidelity contradiction resolution at capture time (sleep cycle still handles complex multi-memory conflicts; inline check handles the simple 1:1 case).
- Changing the retry or backoff logic itself (only the error classification function).

## Decisions

### D1: Regex complexity guard via structural heuristics

Detect nested quantifiers and excessive alternation depth using a lightweight regex-on-regex check before passing the pattern to Neo4j. Specifically:

1. Reject patterns containing nested quantifiers: a quantifier (`+`, `*`, `{n,m}`) applied to a group that itself contains a quantifier. Detect via `/(\((?:[^()]*[+*?]|\{[0-9,]+\})[^()]*\))[+*?]|\{[0-9,]+\}/`.
2. Reject patterns with more than 10 alternation branches (`|` count > 10).
3. Keep the existing 200-char length cap.

**Rationale:** A structural heuristic catches the most common ReDoS patterns (nested quantifiers account for ~90% of ReDoS in practice) without adding a dependency. The alternation cap prevents polynomial blowup. This is defense-in-depth alongside Neo4j's own regex timeout.

**Alternative considered:** Using a safe-regex library (e.g., `safe-regex2`). Rejected because it adds a dependency for a single call site, and the structural check is sufficient for the memory-recall use case where patterns are simple text matches.

### D2: UNWIND-based entity property writes

Replace the per-entity loop with a single Cypher query that uses UNWIND over a list of `{name, props}` objects. The dynamic SET clause is pre-validated (keys already pass `/^[a-z_][a-z0-9_]*$/`) and built from the union of all property keys across all entities, using `CASE WHEN row.props[$key] IS NOT NULL THEN ...` guards for entities that don't have every key.

Simplified approach: since each entity may have different property keys, collect the superset of all keys, then generate a SET clause with null-guarding:

```cypher
UNWIND $entities AS row
MATCH (n:Entity {name: row.name})
SET n += row.props
```

Using `n += row.props` (map merge) is the simplest approach. It sets all keys from `row.props` on the node. Keys not present in `row.props` are left unchanged. Since property keys are already validated, this is safe.

**Rationale:** Neo4j's `+=` operator performs a map merge, setting only the keys present in the map. Combined with UNWIND, this is a single server round-trip regardless of entity count. The property key validation already happens upstream, so no additional sanitization is needed.

**Alternative considered:** Using `apoc.map.merge` or conditional SET clauses. Rejected because `+=` is a built-in operator that does exactly what's needed without APOC dependency.

### D3: Inline contradiction check in the semantic dedup band

Extend the existing `isSemanticDuplicate()` call in `captureMessage()` (auto-capture.ts:269-282) with a parallel contradiction check. When a candidate in the 0.75-0.95 band is NOT a paraphrase, ask the LLM whether it contradicts the new memory. If contradicted:

1. Mark the older memory as `supersededBy` the new memory's ID.
2. Set `validUntil` on the older memory to the current timestamp.
3. Store the new memory normally.

This reuses the existing `isContradiction()` function from `extractor.ts` (already used in sleep-cycle conflict detection).

**Rationale:** The semantic dedup band (0.75-0.95 cosine similarity) already surfaces the most likely contradiction candidates. Adding one more LLM call per candidate (only for non-duplicate candidates) closes the contradiction window with minimal latency. The function already exists and is tested.

**Alternative considered:** Running contradiction detection as a separate post-store async pass. Rejected because it re-opens the exposure window (contradiction is recallable between store and async check).

### D4: Code-based connection error classification

Restructure `isNeo4jConnectionError()` into two tiers:

1. **Structured check (preferred):** Check `err.code` for Neo4j driver codes (`ServiceUnavailable`, `SessionExpired`, `Neo.TransientError.*`) and OS-level `errno` codes (`ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `EPIPE`, `EHOSTUNREACH`). Check `err.constructor.name` for known driver error classes.
2. **String fallback (last resort):** Only for errors that lack structured properties, fall back to `String(err).includes(...)` for connection pool messages (`Pool is closed`, `connection acquisition timed out`, `Connection was closed`).

**Rationale:** The Neo4j driver populates `err.code` on all `Neo4jError` instances. OS-level errors populate `errno` and `code`. Using these structured properties makes classification resilient to error message rewording across driver versions. The string fallback covers edge cases where third-party wrappers strip structured fields.

## Risks / Trade-offs

- **D1 risk:** The regex heuristic may have false positives (blocking legitimate complex patterns) or false negatives (missing novel ReDoS patterns). Mitigation: the function is only used by `memory_forget` with pattern mode, which is a power-user feature. False positives can be worked around by simplifying the pattern.
- **D2 risk:** `n += row.props` will overwrite existing property values. This is the existing behavior (the loop also overwrites), so no behavioral change.
- **D3 risk:** The inline contradiction check adds LLM latency to auto-capture for memories in the 0.75-0.95 band. This is the same band where semantic dedup already makes LLM calls, so the marginal cost is one additional call per non-duplicate candidate (typically 0-1 per capture). The auto-capture pipeline is fire-and-forget, so latency does not block the agent.
- **D4 risk:** New Neo4j driver versions could introduce error codes we don't check. Mitigation: the string fallback tier catches unknown errors, and the `Neo.TransientError.*` prefix match covers the entire transient error family.
