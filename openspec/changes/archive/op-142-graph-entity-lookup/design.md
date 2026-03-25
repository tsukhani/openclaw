## Context

The memory-neo4j extension uses a three-signal hybrid search with RRF fusion:

- Signal 1 (vector): HNSW cosine similarity on `Memory` node embeddings
- Signal 2 (BM25): Fulltext keyword search on `Memory` node text
- Signal 3 (graph): Entity fulltext lookup → `MENTIONS` → `Memory` nodes

All three signals currently return `Memory` node text. Signal 3's graph traversal is used for navigation only — the output always resolves to Memory blobs. Structured nodes (person, organization, location, etc.) with rich properties exist in the graph but are unreachable by the recall pipeline.

Current graph search flow (`neo4j-client-search.ts` → `graphSearch()`):

1. Fulltext lookup on `entity_fulltext_index` → find `Entity` nodes
2. `MATCH (entity)<-[:MENTIONS]-(m:Memory)` → collect Memory nodes
3. N-hop spreading: `(entity)-[rels*1..N]-(e2:Entity)` → `(e2)<-[:MENTIONS]-(m2:Memory)`
4. Return Memory text with graph-derived confidence scores

The `entity_fulltext_index` currently covers only nodes with the `Entity` label. Structured nodes like `person`, `organization`, `location` are not indexed.

## Goals / Non-Goals

**Goals:**

- Signal 3 returns text synthesized from structured node properties, not Memory text
- Schema-agnostic: any node label works without code changes
- Fulltext index covers all structured node labels
- Same `SearchSignalResult` interface so RRF fusion code is unchanged
- Graph signal becomes independently testable without Memory nodes

**Non-Goals:**

- Changing Signals 1 or 2 (vector/BM25 still query Memory nodes)
- Removing existing Entity→MENTIONS→Memory relationships (kept for backward compat)
- Auto-extracting structured nodes from Memory text (that's a separate concern)
- Changing the RRF fusion algorithm or weights

## Decisions

### D1: Schema-agnostic property synthesis over type-specific templates

**Choice:** Enumerate `keys(n)` on traversed nodes, exclude a blocklist of internal fields, format as `{label} {name} — key: value, key: value`.

**Alternative:** Type-specific formatters (PersonFormatter, OrgFormatter, etc.)

**Rationale:** Type-specific formatters require code changes every time a new node type is added. The graph already has 30+ label types. Generic enumeration is future-proof and zero-maintenance.

**Internal fields blocklist:** `embedding`, `updatedAt`, `createdAt`, `agentId`, `id` — these are system metadata, not user-facing properties.

### D2: Composite fulltext index across all structured labels

**Choice:** Create a new fulltext index (`structured_entity_fulltext_index`) that covers the `name` property across all structured node labels (person, organization, location, event, tool, etc.), in addition to the existing `entity_fulltext_index`.

**Alternative:** Expand the existing `entity_fulltext_index` to cover additional labels.

**Rationale:** Keeping indexes separate avoids breaking existing Entity-based graph search during migration. The new index can be added alongside the old one. The graph search function tries the structured index first, falls back to the entity index.

### D3: Graph score for structured results

**Choice:** Structured node results get a base score of 1.0 for direct fulltext matches, decayed by `confidence * 0.7^hops` for multi-hop results (same decay formula as current MENTIONS-based graph search).

**Rationale:** Maintains consistent scoring semantics with the existing graph signal. Direct matches (e.g. querying "Renu" and finding the person node directly) score highest. Indirect matches (e.g. finding "Aaditya" via Renu→KNOWS→Aaditya) are appropriately discounted.

### D4: Dual-path graph search (structured + legacy)

**Choice:** `graphSearch()` runs both the structured entity lookup AND the legacy Entity→MENTIONS→Memory path, merges results, deduplicates by content similarity.

**Alternative:** Fully replace legacy path.

**Rationale:** Gradual migration. Not all facts are in structured nodes yet. Many entity relationships still only exist as Entity→MENTIONS→Memory. Running both paths ensures no recall regression. The legacy path can be deprecated once structured coverage is sufficient.

### D5: Relationship traversal includes all typed relationships

**Choice:** Traversal follows the existing `ALLOWED_RELATIONSHIP_TYPES` constant (KNOWS, MARRIED_TO, WORKS_AT, FOUNDED, LOCATED_IN, etc.) when hopping from structured nodes.

**Rationale:** Re-uses the existing safety-validated relationship type pattern. No new relationship types needed.

## Risks / Trade-offs

- **[Fulltext index on many labels]** → Index size increases. Mitigation: Only index the `name` property, which is small. Monitor index creation time.
- **[Generic property enumeration may surface noisy fields]** → Mitigation: Blocklist of internal fields. Can be extended if needed.
- **[Dual-path search adds latency]** → Mitigation: Both paths already run in parallel. Merging is O(n). Benchmark to verify overhead is <10ms.
- **[Score calibration between structured and Memory results]** → Structured results may score higher/lower than Memory results for the same concept. Mitigation: RRF uses ranks, not raw scores, so calibration is less critical. Monitor via eval harness.

## Migration Plan

1. Create the composite fulltext index (`structured_entity_fulltext_index`) via `neo4j-client-indexes.ts` — additive, no impact on existing indexes
2. Add `structuredGraphSearch()` function to `neo4j-client-search.ts`
3. Update `graphSearch()` to call both legacy and structured paths, merge results
4. Add tests for structured entity lookup
5. Deploy — no config changes needed, feature is automatically active if structured nodes exist
6. Rollback: Revert to pre-change code. No data migration involved.

## Open Questions

- Should the property blocklist be configurable or hardcoded? (Recommendation: hardcoded initially, configurable later if needed)
- Should structured results include the node's relationships in the synthesized text? (e.g. "person Renu Sukhani — birthday: 1978-06-16, whatsapp: +60102550716, MARRIED_TO: Tarun Sukhani") This would add context but increase text length.
