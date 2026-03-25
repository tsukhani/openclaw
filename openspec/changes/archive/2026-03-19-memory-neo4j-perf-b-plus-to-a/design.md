## Context

The memory-neo4j sleep cycle Phase 1 (dedup) and Phase 1c (conflict detection) have scaling bottlenecks. `findDuplicateClusters` iterates all non-core memory IDs and issues one vector index query per memory in batches of 8 — O(N) network round-trips. `findConflictingMemories` fetches 200 memories then runs a vector sub-query per row (N+1 pattern inside Cypher). Additionally, `vectorSearch` over-fetches for agent filtering but lacks a final LIMIT, and `listCoreForInjection` has no cap.

## Goals / Non-Goals

**Goals:**

- Reduce `findDuplicateClusters` from O(N) round-trips to O(1) or O(N/batch) with large batch sizes
- Eliminate the N+1 sub-query pattern in `findConflictingMemories`
- Add safety LIMIT clauses to `vectorSearch` and `listCoreForInjection`
- Preserve existing dedup/conflict behavior (same similarity thresholds, same union-find clustering)

**Non-Goals:**

- Introducing Neo4j GDS (Graph Data Science) library dependency — requires plugin installation
- Changing dedup similarity thresholds or the union-find algorithm
- Rewriting the sleep cycle orchestrator or phase ordering

## Decisions

### D1: Batch dedup via Cypher self-join with UNWIND + vector index

**Choice**: Replace per-memory vector queries with a single Cypher statement that UNWINDs all memory IDs, fetches each one's embedding, and runs the vector index query inside a CALL subquery.

```cypher
MATCH (m:Memory)
WHERE m.category <> 'core' AND m.embedding IS NOT NULL AND size(m.embedding) > 0
  AND m.agentId = $agentId
WITH m
LIMIT $batchLimit
CALL db.index.vector.queryNodes('memory_embedding_index', $k, m.embedding)
YIELD node, score
WHERE node.id <> m.id AND score >= $threshold AND node.category <> 'core'
RETURN m.id AS sourceId, node.id AS matchId, score
```

**Why not GDS knn**: GDS requires an installed plugin and licensing. The Cypher CALL subquery approach works with vanilla Neo4j and keeps the same HNSW index.

**Why not pre-computed similarity matrix**: Would require storing N^2 pairs, excessive for large memory stores.

**Trade-off**: The CALL subquery still executes per-row inside Neo4j, but it's a single network round-trip with all computation server-side. This eliminates the per-memory network overhead which was the primary bottleneck.

**Batching**: Process in chunks of 500 memories per statement to avoid transaction timeouts, with the same 2000-pair safety cap.

### D2: Conflict detection batch approach

**Choice**: Pre-fetch all candidate memory embeddings in one query, then use the same CALL subquery pattern but with a higher similarity threshold (0.85) and smaller k (5).

The current pattern already does this in Cypher but with LIMIT 200 rows feeding into CALL. The issue isn't truly N+1 in the network sense (it's a single Cypher statement), but the Neo4j planner executes 200 vector index lookups. This is inherent to the problem — finding conflicting pairs requires comparing memories. The optimization is to ensure the LIMIT 200 is sufficient and add a final LIMIT on output pairs.

**Revised assessment**: The `findConflictingMemories` query is actually a single Cypher statement, not N+1 network round-trips. The 200 vector sub-queries happen server-side. The main fix is adding a LIMIT to the output to prevent excessive results, and ensuring the initial candidate selection is efficient.

### D3: vectorSearch LIMIT

**Choice**: Add `LIMIT $requestedLimit` after the ORDER BY in vectorSearch. The over-fetch (`limit * 3`) is intentional for agent filtering, but the final result set should be capped at the original requested limit.

### D4: listCoreForInjection safety cap

**Choice**: Add `LIMIT 200` to prevent unbounded context injection. 200 core memories is a generous upper bound — typical usage is 5-20. Log a warning if the cap is reached.

## Risks / Trade-offs

- [Risk] Batch CALL subquery may have different performance characteristics than individual queries under Neo4j's query planner → Mitigation: Benchmark with a test dataset of 1000+ memories before and after
- [Risk] Changing findDuplicateClusters to batch may alter the order of union-find operations → Mitigation: The union-find result is order-independent (same connected components regardless of edge insertion order)
- [Risk] The 500-memory batch size may be too large for Neo4j transactions with many embeddings → Mitigation: Configurable batch size, start with 500, reduce if transaction timeouts occur
