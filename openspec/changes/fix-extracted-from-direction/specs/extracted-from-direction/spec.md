## ADDED Requirements

### Requirement: EXTRACTED_FROM queries SHALL follow canonical direction

All Cypher queries that traverse the `EXTRACTED_FROM` relationship MUST use the canonical direction `(Entity)-[:EXTRACTED_FROM]->(Memory)` or its equivalent reverse notation `(Memory)<-[:EXTRACTED_FROM]-(Entity)`. Queries MUST NOT use the opposite direction `(Memory)-[:EXTRACTED_FROM]->(Entity)` or `(Entity)<-[:EXTRACTED_FROM]-(Memory)`.

#### Scenario: Community search resolves entities to memories

- **WHEN** community search finds entities via community membership
- **THEN** the Cypher query SHALL traverse `(mem:Memory)<-[:EXTRACTED_FROM]-(entity)` to resolve those entities back to source Memory nodes

#### Scenario: MPFP bridge resolves entity hits to memories

- **WHEN** MPFP traversal reaches Entity nodes as terminal hits
- **THEN** the bridge query SHALL traverse `(m:Memory)<-[:EXTRACTED_FROM]-(e:Entity)` to return corresponding Memory nodes

#### Scenario: Observation stale-entity detection finds connected memories

- **WHEN** the observation system queries for entities with 3+ connected memories
- **THEN** the query SHALL traverse `(e:Entity)-[:EXTRACTED_FROM]->(m:Memory)` to count and collect connected memories

#### Scenario: Observation memory text collection retrieves memory content

- **WHEN** the observation system collects memory texts for an entity
- **THEN** the query SHALL traverse `(e:Entity)-[:EXTRACTED_FROM]->(m:Memory)` to retrieve memory text content

#### Scenario: Reflection candidate query finds entities for opinion generation

- **WHEN** the reflection system queries for entities eligible for opinion generation
- **THEN** the query SHALL traverse `(e:Entity)-[:EXTRACTED_FROM]->(m:Memory)` to count connected memories
