## MODIFIED Requirements

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

#### Scenario: Community detection runs as a sleep cycle phase

- **WHEN** the sleep cycle executes
- **AND** `communityDetection.enabled` is true in config
- **THEN** the community detection phase SHALL run after entity extraction (Phase 2) and before decay (Phase 3)

#### Scenario: Agent scoping uses agentId property

- **WHEN** community detection loads entities for agent "agent-1"
- **THEN** entities are filtered by `e.agentId = "agent-1"`
- **THEN** no MENTIONS traversal from Memory nodes is used for scoping
