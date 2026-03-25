## ADDED Requirements

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
