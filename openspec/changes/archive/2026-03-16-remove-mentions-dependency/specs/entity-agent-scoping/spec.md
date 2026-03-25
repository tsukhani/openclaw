## ADDED Requirements

### Requirement: Entity nodes carry agentId property

Entity nodes SHALL have an `agentId` string property set during extraction. The property SHALL be set ON CREATE only (first agent to create the entity owns it). ON MATCH SHALL NOT overwrite an existing `agentId`.

#### Scenario: New entity extraction sets agentId

- **WHEN** `batchEntityOperations` creates a new Entity node for agent "agent-1"
- **THEN** the Entity node has `agentId = "agent-1"`

#### Scenario: Re-extraction by same agent preserves agentId

- **WHEN** `batchEntityOperations` matches an existing Entity created by "agent-1"
- **THEN** `agentId` remains "agent-1" (not overwritten)

#### Scenario: Extraction by different agent preserves original agentId

- **WHEN** agent "agent-2" extracts an entity already created by "agent-1"
- **THEN** `agentId` remains "agent-1" (ON CREATE only)

### Requirement: Entity agentId index exists

The system SHALL create a property index on `Entity.agentId` during initialization, enabling fast agent-scoped queries.

#### Scenario: Index created on startup

- **WHEN** `ensureInitialized()` runs
- **THEN** a property index on `Entity(agentId)` exists

### Requirement: Agent scoping in search uses agentId property

`structuredGraphSearch` and `causalChainSearch` fulltext seed filters SHALL use `node.agentId = $agentId` instead of `EXISTS { MATCH (:Memory {agentId})-[:MENTIONS]->(node) }` for agent scoping.

#### Scenario: Fulltext search filters by entity agentId

- **WHEN** `structuredGraphSearch` runs with `agentId` and no embedding
- **THEN** the fulltext seed query filters entities by `node.agentId = $agentId`
- **THEN** no MENTIONS traversal is used for filtering

### Requirement: Community detection uses agentId property

Community detection entity loading SHALL use `e.agentId = $agentId` instead of `(:Memory {agentId})-[:MENTIONS]->(e)`.

#### Scenario: Label propagation loads agent-scoped entities

- **WHEN** `runLabelPropagation` runs for "agent-1"
- **THEN** entities are loaded via `MATCH (e:Entity {agentId: $agentId})`
- **THEN** no MENTIONS traversal is used

### Requirement: Entity dedup scoping uses agentId property

`findDuplicateEntityPairs` SHALL scope entities by `e1.agentId = $agentId` instead of `(:Memory {agentId})-[:MENTIONS]->(e1)`.

#### Scenario: Duplicate detection scoped by agentId

- **WHEN** `findDuplicateEntityPairs` runs with agentId
- **THEN** only entities with matching `agentId` are considered

### Requirement: Backfill migration for existing entities

A one-time migration SHALL backfill `agentId` on existing Entity nodes using their MENTIONS relationships: for each entity without `agentId`, set it from the first agent's Memory that mentions it.

#### Scenario: Migration backfills agentId from MENTIONS

- **WHEN** `ensureInitialized()` runs on an existing graph with entities lacking `agentId`
- **THEN** each entity gets `agentId` set from the first distinct `Memory.agentId` found via MENTIONS
- **THEN** entities already having `agentId` are not modified

### Requirement: Entity graph stats use agentId property

`getEntityGraphStats` SHALL use `e.agentId = $agentId` for agent-scoped entity counts instead of MENTIONS traversal.

#### Scenario: Stats count entities by agentId

- **WHEN** `getEntityGraphStats` runs with agentId
- **THEN** entityCount is based on `Entity {agentId}` match
- **THEN** no MENTIONS relationships are counted (relationshipCount replaces mentionCount in stats)
