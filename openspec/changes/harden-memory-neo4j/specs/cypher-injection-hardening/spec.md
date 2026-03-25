## ADDED Requirements

### Requirement: Centralized safe Cypher relationship type interpolation

The extension SHALL provide a `safeCypherRelType(type: string): string` function in `schema.ts` that validates a relationship type against `^[A-Z][A-Z0-9_]*$` (max 50 chars, no trailing underscore) and returns it. If validation fails, the function SHALL throw an error. All Cypher queries that interpolate relationship types SHALL use this function instead of inline regex guards.

#### Scenario: Valid relationship type passes through

- **WHEN** `safeCypherRelType("KNOWS")` is called
- **THEN** it SHALL return `"KNOWS"`

#### Scenario: Invalid relationship type throws

- **WHEN** `safeCypherRelType("knows")` is called (lowercase)
- **THEN** it SHALL throw an error with a message indicating the type is invalid

#### Scenario: Injection attempt throws

- **WHEN** `safeCypherRelType("KNOWS]->(x) DETACH DELETE x//")` is called
- **THEN** it SHALL throw an error (contains characters outside `[A-Z0-9_]`)

#### Scenario: All entity operation interpolation sites use safeCypherRelType

- **WHEN** `batchEntityOperations`, `mergeEntityPair`, `batchMergeEntityPairsChunk`, or `migrateEntityRelationshipTemporalFields` interpolate a relationship type into Cypher
- **THEN** they SHALL call `safeCypherRelType()` on the type before interpolation

### Requirement: Lucene query escaping in causalChainSearch

The `causalChainSearch` function SHALL escape its `query` parameter using `escapeLucene()` before passing it to the Neo4j fulltext index query, consistent with `structuredGraphSearch`.

#### Scenario: Special characters in causal chain query are escaped

- **WHEN** `causalChainSearch` is called with query `"what is foo:bar?"`
- **THEN** the query passed to `db.index.fulltext.queryNodes` SHALL have `:` and `?` escaped

#### Scenario: causalChainSearch called directly is safe

- **WHEN** `causalChainSearch` is called directly (not through the `graphSearch` dispatcher)
- **THEN** Lucene special characters SHALL still be escaped (function is self-contained)

### Requirement: HTTPS enforcement warning for LLM base URLs

The LLM client SHALL log a warning when `baseUrl` uses `http://` scheme and the host is not a loopback address (`localhost`, `127.0.0.1`, `::1`). The warning SHALL be emitted once at client initialization, not per request.

#### Scenario: HTTP to remote host logs warning

- **WHEN** LLM client is initialized with `baseUrl: "http://api.example.com/v1"`
- **THEN** a warning SHALL be logged indicating the API key will be sent over an unencrypted connection

#### Scenario: HTTP to localhost does not warn

- **WHEN** LLM client is initialized with `baseUrl: "http://localhost:11434/v1"`
- **THEN** no HTTPS warning SHALL be logged

#### Scenario: HTTPS to any host does not warn

- **WHEN** LLM client is initialized with `baseUrl: "https://api.openai.com/v1"`
- **THEN** no HTTPS warning SHALL be logged

### Requirement: Batched UNWIND for dedup text fetch

The dedup text fetch in the sleep cycle SHALL batch `UNWIND $ids` queries into chunks of at most 5000 IDs per query. Results from all chunks SHALL be merged before proceeding with dedup logic.

#### Scenario: Small ID set uses single query

- **WHEN** dedup has 3000 clustered memory IDs to fetch text for
- **THEN** a single UNWIND query SHALL be issued with all 3000 IDs

#### Scenario: Large ID set is chunked

- **WHEN** dedup has 12000 clustered memory IDs to fetch text for
- **THEN** 3 UNWIND queries SHALL be issued (5000 + 5000 + 2000)
- **AND** results SHALL be merged into a single map before proceeding
