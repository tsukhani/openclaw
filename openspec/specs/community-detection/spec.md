## ADDED Requirements

### Requirement: Entities are clustered into communities via label propagation

The sleep cycle SHALL include a community detection phase that clusters strongly-connected entities into communities using a label propagation algorithm. Entities SHALL be scoped to an agent via the `agentId` property on Entity nodes (`e.agentId = $agentId`), not via MENTIONS traversal from agent-scoped Memory nodes. Entities SHALL be clustered based on their inter-entity relationships (WORKS_AT, PARENT_OF, CAUSED_BY, RELATED_TO, etc.), with MENTIONS relationships excluded from the clustering graph. Each community SHALL be represented as a `Community` node in Neo4j.

#### Scenario: Connected entities form a community

- **WHEN** entities A, B, and C are connected via WORKS_AT and RELATED_TO relationships forming a clique
- **AND** entity D has no relationships to A, B, or C
- **THEN** the community detection phase SHALL create a Community containing A, B, and C
- **AND** entity D SHALL NOT be assigned to that community

#### Scenario: Isolated entities are not assigned to communities

- **WHEN** an entity has no inter-entity relationships
- **THEN** the entity SHALL NOT be assigned to any community

#### Scenario: Agent scoping uses agentId property

- **WHEN** community detection loads entities for agent "agent-1"
- **THEN** entities are filtered by `e.agentId = "agent-1"`
- **THEN** no MENTIONS traversal from Memory nodes is used for scoping

#### Scenario: Community detection runs as a sleep cycle phase

- **WHEN** the sleep cycle executes
- **AND** `communityDetection.enabled` is true in config
- **THEN** the community detection phase SHALL run after entity extraction (Phase 2) and before decay (Phase 3)

### Requirement: Communities have LLM-generated summaries

Each detected community SHALL have an LLM-generated summary describing the theme, key entities, and relationships within the community. Summaries SHALL be stored on the Community node and refreshed when community membership changes.

#### Scenario: New community gets a summary

- **WHEN** a new community is detected with entities "Acme Corp", "John Smith", and "VP of Engineering"
- **THEN** the Community node SHALL have a `summary` property describing the relationship cluster
- **AND** the summary SHALL mention the key entities and their connections

#### Scenario: Community summary is refreshed when membership changes

- **WHEN** a community's entity membership changes (entity added or removed)
- **THEN** the community summary SHALL be regenerated on the next sleep cycle
- **AND** the `updatedAt` timestamp on the Community node SHALL be updated

#### Scenario: Summary generation failure does not block the phase

- **WHEN** the LLM call for summary generation fails
- **THEN** the Community node SHALL be created with an empty summary
- **AND** the phase SHALL continue processing remaining communities
- **AND** a warning SHALL be logged

### Requirement: Community node schema

Community nodes SHALL have the following properties: `id` (unique string), `name` (derived from top entity names), `summary` (LLM-generated text), `entityCount` (integer), `embedding` (vector for community-level search), `createdAt` (ISO timestamp), `updatedAt` (ISO timestamp). Entities SHALL link to their community via a `BELONGS_TO` relationship.

#### Scenario: Community node has required properties

- **WHEN** a community is created with 5 member entities
- **THEN** the Community node SHALL have all required properties populated
- **AND** `entityCount` SHALL equal 5
- **AND** each member entity SHALL have a `BELONGS_TO` relationship to the Community node

#### Scenario: Community embedding is generated from summary

- **WHEN** a community summary is generated
- **THEN** the summary text SHALL be embedded using the configured embedding provider
- **AND** the resulting vector SHALL be stored in the Community node's `embedding` property

### Requirement: Community-aware search signal in RRF pipeline

The hybrid search SHALL include an optional community search signal that queries Community nodes by embedding similarity and returns member entities' connected memories. This signal SHALL be weighted in the RRF fusion alongside vector, BM25, and graph signals when `communityDetection.enabled` is true.

#### Scenario: Community signal contributes to search results

- **WHEN** a query matches a community about "machine learning infrastructure"
- **AND** that community contains entities mentioned in memories about ML pipelines
- **THEN** the community signal SHALL contribute those memories to the RRF fusion
- **AND** the result signal attribution SHALL include a `community` field

#### Scenario: Community signal disabled when feature is off

- **WHEN** `communityDetection.enabled` is false (default)
- **THEN** the RRF pipeline SHALL operate with only vector, BM25, and graph signals
- **AND** no community queries SHALL be executed

### Requirement: Community detection is disabled by default

Community detection SHALL be disabled by default (`communityDetection.enabled: false`). When disabled, no Community nodes SHALL be created, no community search signal SHALL be used, and no community-related processing SHALL occur during the sleep cycle.

#### Scenario: Default config skips community processing

- **WHEN** no `communityDetection` config section is provided
- **THEN** the sleep cycle SHALL skip the community detection phase
- **AND** the search pipeline SHALL not include a community signal

### Requirement: Community detection has dedicated unit tests

The community detection capability SHALL have dedicated unit test files covering the label propagation algorithm in `neo4j-client-community.ts` and the sleep-phase orchestration in `sleep-phases-community.ts`. Tests SHALL verify clustering behavior, community CRUD operations, stale link cleanup, and edge cases (convergence, empty graph, single entity).

#### Scenario: Unit tests cover label propagation convergence

- **WHEN** the community detection unit tests execute
- **THEN** there SHALL be tests verifying that label propagation converges when no labels change between iterations
- **AND** tests verifying that propagation stops at maxIterations even if not converged

#### Scenario: Unit tests cover community search signal

- **WHEN** the community detection unit tests execute
- **THEN** there SHALL be tests verifying that `communitySearch()` returns memories linked to community members
- **AND** tests verifying that the community signal contributes to RRF fusion with the configured weight

#### Scenario: Unit tests cover edge cases

- **WHEN** the community detection unit tests execute
- **THEN** there SHALL be tests for: empty entity graph (no crash), single entity (no community), entities with no inter-entity relationships, and community with exactly minCommunitySize entities
