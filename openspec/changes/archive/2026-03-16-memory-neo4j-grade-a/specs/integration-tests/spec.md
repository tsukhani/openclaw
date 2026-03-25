## ADDED Requirements

### Requirement: Integration tests validate Cypher queries against real Neo4j

The memory-neo4j extension SHALL include an integration test suite that runs core Cypher queries against a real Neo4j 5.x instance provisioned via Docker. The test suite SHALL validate query syntax, index behavior, constraint enforcement, and result correctness for at least the following operations: memory storage (MERGE idempotency), vector search, BM25 fulltext search, graph traversal (structured search), entity batch operations, entity merge/dedup, memory invalidation (single and batch), and retrieval tracking.

#### Scenario: Memory MERGE idempotency verified against real Neo4j

- **WHEN** `storeMemory()` is called twice with the same memory ID
- **THEN** the database SHALL contain exactly one Memory node with that ID
- **AND** the second call SHALL not create a duplicate

#### Scenario: Vector index query returns correct similarity ordering

- **WHEN** three memories are stored with known embeddings and a vector search is executed with a query embedding closest to memory B
- **THEN** the results SHALL return memory B with the highest similarity score
- **AND** the score SHALL be a valid cosine similarity value between 0 and 1

#### Scenario: BM25 fulltext search returns keyword matches

- **WHEN** memories containing "Kubernetes deployment" and "React component" are stored and a BM25 search for "Kubernetes" is executed
- **THEN** the results SHALL include the Kubernetes memory
- **AND** SHALL NOT include the React memory

#### Scenario: Graph traversal follows entity relationships

- **WHEN** Memory A mentions Entity X, Entity X has a WORKS_AT relationship to Entity Y, and Memory B mentions Entity Y
- **THEN** a graph search seeded from Entity X with depth 2 SHALL discover Memory B
- **AND** the result SHALL include hop-decay scoring

#### Scenario: Entity batch operations are atomic

- **WHEN** `batchEntityOperations()` is called with 5 entities, 3 relationships, and 2 tags
- **THEN** all entities, relationships, and tags SHALL be created in a single transaction
- **AND** if the transaction fails, none of the entities SHALL exist in the database

#### Scenario: Uniqueness constraints prevent duplicate entities

- **WHEN** two concurrent calls attempt to create an Entity with the same ID
- **THEN** exactly one Entity node SHALL exist
- **AND** the second call SHALL merge into the existing node without error

### Requirement: Integration tests verify index creation and readiness

The integration test suite SHALL verify that all indexes defined in `neo4j-client-indexes.ts` are created successfully and reach an ONLINE state before queries depend on them.

#### Scenario: All 13+ indexes reach ONLINE state

- **WHEN** `ensureIndexes()` completes against a fresh Neo4j instance
- **THEN** all vector, fulltext, property, and composite indexes SHALL report status ONLINE
- **AND** the test SHALL fail if any index remains in POPULATING state after a reasonable timeout (30 seconds)

### Requirement: Concurrent write tests verify multi-agent consistency

The integration test suite SHALL include tests where multiple simulated agents write memories concurrently, verifying that entity mention counts, relationship integrity, and uniqueness constraints remain consistent under contention.

#### Scenario: Two agents store memories mentioning the same entity concurrently

- **WHEN** Agent A and Agent B simultaneously store memories that both mention entity "acme-corp"
- **THEN** the entity "acme-corp" SHALL have `mentionCount` equal to the sum of mentions from both agents
- **AND** both agents' MENTIONS relationships SHALL exist

#### Scenario: Concurrent entity merge does not lose relationships

- **WHEN** an entity merge operation runs while a new memory referencing the merge target is being stored
- **THEN** the MENTIONS relationship from the new memory SHALL point to the surviving entity after merge
- **AND** no orphaned relationships SHALL exist

### Requirement: Signal degradation tests verify graceful partial results

The integration test suite SHALL include tests that simulate individual search signal failures and verify that the hybrid search returns useful results from the remaining signals.

#### Scenario: BM25 index unavailable returns vector-only results

- **WHEN** a hybrid search is executed and the BM25 fulltext index query throws a transient error
- **THEN** the search SHALL return results from the vector and graph signals
- **AND** the results SHALL NOT include an error response to the caller

#### Scenario: Graph search returns empty but vector and BM25 succeed

- **WHEN** a hybrid search is executed and graph search returns zero results (no entity matches)
- **THEN** the search SHALL return results fused from vector and BM25 signals only
- **AND** result scores SHALL be computed correctly without the graph signal contribution

#### Scenario: All signals fail returns empty results with connection error

- **WHEN** a hybrid search is executed and all three signals fail with connection errors
- **THEN** the search SHALL propagate a connection error to the caller
- **AND** SHALL NOT return partial or stale results

### Requirement: Integration test infrastructure uses Docker

The integration tests SHALL provision a Neo4j 5.x instance using Docker (via testcontainers, Docker Compose, or equivalent). Tests SHALL be gated behind an environment variable (`MEMORY_NEO4J_INTEGRATION=1`) so they do not run in standard `pnpm test` but are included in CI.

#### Scenario: Tests skip when Docker is unavailable

- **WHEN** `MEMORY_NEO4J_INTEGRATION` is not set or Docker is not available
- **THEN** all integration tests SHALL be skipped with a descriptive message
- **AND** standard unit tests SHALL continue to pass

#### Scenario: Each test suite gets a clean database

- **WHEN** an integration test suite starts
- **THEN** the Neo4j database SHALL be empty (no leftover data from previous test suites)
- **AND** indexes SHALL be freshly created via `ensureIndexes()`
