## ADDED Requirements

### Requirement: Episodic memory has dedicated unit tests

The episodic memory capability SHALL have dedicated unit test files covering all CRUD operations in `neo4j-client-episode.ts`. Tests SHALL verify episode creation, memory-episode linking, time-range querying, and TTL-based cleanup. Tests SHALL use mocked Neo4j sessions to isolate the module's logic.

#### Scenario: Unit tests cover episode merge idempotency

- **WHEN** `mergeEpisode()` is called twice with the same episode ID
- **THEN** only one Episode node SHALL exist
- **AND** its properties SHALL reflect the most recent call

#### Scenario: Unit tests cover episode linking and unlinking

- **WHEN** the episodic memory unit tests execute
- **THEN** there SHALL be tests verifying that `linkMemoryToEpisode()` creates an EPISODE_SOURCE relationship
- **AND** tests verifying that deleting an episode removes EPISODE_SOURCE relationships from linked memories

#### Scenario: Unit tests cover query filtering

- **WHEN** the episodic memory unit tests execute
- **THEN** there SHALL be tests for filtering by sessionKey only, by time range only, and by both sessionKey and time range simultaneously
- **AND** tests verifying the limit parameter caps results
