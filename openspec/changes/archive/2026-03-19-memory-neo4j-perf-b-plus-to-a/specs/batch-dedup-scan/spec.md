## ADDED Requirements

### Requirement: Batch vector dedup scan

The `findDuplicateClusters` function SHALL execute vector similarity lookups as batch Cypher statements (one statement per chunk) instead of individual per-memory network round-trips. Each batch SHALL process up to 500 memories in a single Cypher CALL subquery, reducing network round-trips from O(N) to O(N/500).

#### Scenario: Batch dedup with 1000 memories

- **WHEN** `findDuplicateClusters` is called with 1000 non-core memories
- **THEN** at most 2 Cypher statements are executed (ceil(1000/500)), each using UNWIND + CALL subquery server-side

#### Scenario: Union-find produces identical clusters

- **WHEN** `findDuplicateClusters` is called with the batch approach
- **THEN** the union-find clustering result SHALL be identical to the previous per-memory approach (same connected components, same pair detection at the same similarity threshold)

#### Scenario: Safety cap preserved

- **WHEN** the number of detected pairs exceeds 2000 during batch processing
- **THEN** processing SHALL stop early and log a warning, matching existing behavior

### Requirement: vectorSearch result set bounded

The `vectorSearch` function SHALL include a final `LIMIT` clause after post-filtering (agent filter, temporal filter, quarantine filter) to cap the result set at the caller's requested limit.

#### Scenario: Agent-filtered vector search respects limit

- **WHEN** `vectorSearch` is called with `limit=10` and `agentId` set
- **THEN** the Cypher query over-fetches (up to `limit * 3`) for filtering headroom but the final `RETURN` includes `LIMIT 10`

#### Scenario: Non-agent vector search respects limit

- **WHEN** `vectorSearch` is called with `limit=10` and no `agentId`
- **THEN** the final result set contains at most 10 entries

### Requirement: Core memory injection bounded

The `listCoreForInjection` function SHALL include a safety cap `LIMIT 200` to prevent unbounded context injection payloads.

#### Scenario: Core memory cap reached

- **WHEN** an agent has more than 200 core memories
- **THEN** `listCoreForInjection` returns at most 200 and a warning is logged

#### Scenario: Normal core memory count unaffected

- **WHEN** an agent has fewer than 200 core memories
- **THEN** all core memories are returned (no behavioral change)
