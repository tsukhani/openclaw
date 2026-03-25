## Why

Graph retrieval scores 48.1% MRR — the strongest signal — but still misses ~52% of graph-type queries. Two improvements can close this gap: (1) deeper traversal for entity-relationship queries (currently depth=2, missing second-degree connections), and (2) co-occurrence edges between entities that frequently appear together in memories, creating a denser graph that improves recall for associative queries.

## What Changes

### Graph Depth

- Add per-query-type depth override: `extraction` → depth=2, `graph` → depth=3, `long` → depth=2
- Expose `search.graphSearch.depthByQueryType` config map
- Cap max depth at 4 to prevent runaway traversal

### Entity Co-occurrence Edges

- During memory store/capture, detect entities that co-appear in the same memory
- Create `CO_OCCURS_WITH` relationship between co-occurring entity nodes with a `weight` property (incremented on each co-occurrence)
- Include `CO_OCCURS_WITH` edges in graph traversal with lower weight than `RELATED_TO`/`MENTIONS`
- Add a nightly job to prune weak co-occurrence edges (weight < 2)

## Capabilities

### New Capabilities

- `entity-cooccurrence-edges`: Track and traverse entity co-occurrence relationships in the graph

### Modified Capabilities

- `graph-search`: Per-query-type depth configuration

## Impact

- **Files:** `neo4j-client-search.ts` (depth config), `neo4j-client.ts` (co-occurrence on store), new migration for `CO_OCCURS_WITH` index
- **Risk:** Medium — co-occurrence edges increase graph size; pruning job prevents unbounded growth
- **Expected gain:** +5–10pp graph MRR
- **Eval target:** ≥60% graph MRR after fix
