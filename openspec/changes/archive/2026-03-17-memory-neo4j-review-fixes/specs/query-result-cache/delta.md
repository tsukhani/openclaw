## CHANGED Requirements

### Requirement: Cache is invalidated on memory writes

**Change:** Replace full-cache clear with agent-scoped invalidation using a secondary index.

The cache SHALL maintain a secondary index mapping `agentId` to the set of cache keys belonging to that agent. When `invalidateAgent(agentId)` is called, only cache entries belonging to that agent SHALL be removed. Other agents' cached entries SHALL remain unaffected.

#### Scenario: memory_store clears cache only for the storing agent

- **WHEN** agent A and agent B both have cached search results
- **AND** agent A stores a new memory via `memory_store`
- **THEN** all cache entries for agent A SHALL be invalidated
- **AND** agent B's cache entries SHALL remain intact and return hits on subsequent queries

#### Scenario: memory_forget clears cache only for the forgetting agent

- **WHEN** agent A and agent B both have cached search results
- **AND** agent A deletes a memory via `memory_forget`
- **THEN** all cache entries for agent A SHALL be invalidated
- **AND** agent B's cache entries SHALL remain intact

#### Scenario: LRU eviction keeps secondary index in sync

- **WHEN** the cache is at maximum capacity
- **AND** a new query for agent A triggers LRU eviction of an entry belonging to agent B
- **THEN** the evicted key SHALL be removed from agent B's secondary index set
- **AND** agent B's remaining entries SHALL still be correctly invalidated on subsequent writes

#### Scenario: clear() resets both primary cache and secondary index

- **WHEN** `clear()` is called on the cache
- **THEN** all entries in the primary Map SHALL be removed
- **AND** all entries in the secondary index SHALL be removed

## ADDED Requirements

### Requirement: BM25 search escapes Lucene special characters

The `bm25Search()` function SHALL apply `escapeLucene()` to the query string before passing it to Neo4j's fulltext index. This prevents Lucene syntax errors from special characters in natural-language queries.

#### Scenario: Query with parentheses does not cause Lucene parse error

- **WHEN** `memory_recall` is called with query "error (timeout)"
- **THEN** the BM25 signal SHALL execute without error
- **AND** results SHALL match memories containing the literal words "error" and "timeout"

#### Scenario: Query with plus/minus operators is treated as literal text

- **WHEN** `memory_recall` is called with query "C++ vs C#"
- **THEN** the BM25 signal SHALL treat "+" and "#" as literal characters
- **AND** results SHALL match memories mentioning "C++" or "C#"
