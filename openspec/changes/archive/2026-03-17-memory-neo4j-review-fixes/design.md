## Context

The memory-neo4j extension has three high-priority gaps identified during code review:

1. `QueryResultCache.invalidateAgent()` clears the entire Map on any write, even though the method name and parameter suggest agent-scoped invalidation. With multiple agents sharing one cache, agent A's write trashes agent B's warm cache entries.
2. Credentials (API keys, tokens) are only detected during the sleep consolidation cycle. Between auto-capture and the next sleep run, leaked secrets sit unquarantined in the graph, retrievable by `memory_recall`.
3. `bm25Search()` passes the raw query string to Neo4j's fulltext index, while `communitySearch()` escapes it via `escapeLucene()`. Lucene special characters (`+`, `-`, `&&`, `||`, `!`, `(`, `)`, `{`, `}`, `[`, `]`, `^`, `"`, `~`, `*`, `?`, `:`, `\`, `/`) in user queries can cause parse errors or unexpected matches in BM25.

## Goals / Non-Goals

**Goals:**

- Agent-scoped cache invalidation: writes for one agent only evict that agent's entries.
- Real-time credential detection: quarantine credentials at capture time, before they ever become recallable.
- Consistent Lucene escaping: `bm25Search()` escapes queries the same way `communitySearch()` does.

**Non-Goals:**

- Changing the cache key hashing algorithm (MD5 is fine for this use case).
- Adding PII detection beyond credential patterns (separate effort).
- Changing BM25 scoring or normalization logic.

## Decisions

### D1: Secondary index for agent-scoped invalidation

Maintain a `Map<string, Set<string>>` mapping `agentId → Set<cacheKey>` alongside the primary cache Map. On `set()`, register the key under the agent. On `invalidateAgent(agentId)`, delete only the keys in that agent's Set, then delete the Set entry. On `clear()`, clear both maps.

**Rationale:** O(k) invalidation where k = entries for that agent. The secondary index adds negligible memory (one string reference per entry) and keeps the implementation simple. No need for a reverse index since the agent set directly contains the cache keys.

### D2: Credential check in auto-capture before store

Import `detectCredential` from `sleep-cycle-types.ts` and call it on the message text in `runAutoCapture()` after the attention gate passes and before `storeMemory()`. If a credential is detected, set `quarantined: true` and `trustScore: 0.0` on the stored memory, matching the existing instruction-detection quarantine path.

**Rationale:** `detectCredential()` is a pure regex function (sub-ms, no LLM call). It already exists and is battle-tested in the sleep cycle credential scan phase. Reusing it at capture time adds negligible latency and closes the exposure window completely.

### D3: Apply escapeLucene to BM25 query parameter

Call `escapeLucene(query)` on the query string before passing it to the Cypher `CALL db.index.fulltext.queryNodes()` in `bm25Search()`. This matches the existing pattern in `communitySearch()`.

**Rationale:** Neo4j's fulltext index uses Lucene syntax. Parameterization prevents Cypher injection but does NOT escape Lucene operators. A query like `"error (timeout)"` would be parsed as Lucene grouping rather than literal parentheses. `escapeLucene()` already handles this correctly.

## Risks / Trade-offs

- **D1 risk:** The secondary index must stay in sync with the primary Map. Bugs (e.g., forgetting to remove a key on eviction) could cause stale references. Mitigation: unit tests covering eviction + invalidation interplay.
- **D2 risk:** False positives from `detectCredential()` could quarantine legitimate memories containing patterns that look like tokens (e.g., discussing API key formats). This is acceptable — quarantined memories are still stored and auditable via `includeQuarantined: true`.
- **D3 risk:** Over-escaping could reduce BM25 recall for queries that intentionally use Lucene operators. This is acceptable — memory recall queries are natural language, not Lucene syntax. No user is writing `title:foo AND category:bar` as a memory_recall query.
