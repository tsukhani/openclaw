## ADDED Requirements

### Requirement: E2E plugin lifecycle test exists

An end-to-end test SHALL exercise the full plugin lifecycle: registration, service start, tool execution (recall, store, forget), and service stop. The test SHALL use a real or mocked Neo4j instance and verify that all lifecycle stages complete without errors.

#### Scenario: Plugin registers and starts successfully

- **WHEN** the plugin's `register()` function is called with valid config
- **AND** the registered service's `start()` callback is invoked
- **THEN** the Neo4j indexes SHALL be initialized
- **AND** the service start SHALL complete without error
- **AND** memory tools (memory_recall, memory_store, memory_forget) SHALL be registered

#### Scenario: Tool calls work after service start

- **WHEN** the service has started successfully
- **AND** `memory_store` is called with text "E2E test memory"
- **THEN** the tool SHALL return a success result with an ID
- **AND** a subsequent `memory_recall` call with query "E2E test" SHALL return the stored memory
- **AND** a subsequent `memory_forget` call with the returned ID SHALL delete the memory

#### Scenario: Service stop drains captures and closes connection

- **WHEN** the service's `stop()` callback is invoked
- **THEN** outstanding auto-capture promises SHALL be drained (or timeout after 10s)
- **AND** the Neo4j driver SHALL be closed
- **AND** the cron job (if any) SHALL be stopped
- **AND** the metrics collector SHALL be flushed

#### Scenario: Service handles Neo4j unavailability gracefully

- **WHEN** the plugin's service starts but Neo4j is unreachable
- **THEN** the service start SHALL complete without throwing (graceful degradation)
- **AND** a warning SHALL be logged
- **AND** tool calls SHALL return user-facing error messages (not throw)

### Requirement: Community detection has dedicated unit tests

Dedicated unit tests SHALL exist for `neo4j-client-community.ts` and `sleep-phases-community.ts` covering the label propagation algorithm, community node management, and stale link cleanup.

#### Scenario: Label propagation clusters connected entities

- **WHEN** `runLabelPropagation()` is called with entities forming two connected groups of 3+ and one isolated entity
- **THEN** it SHALL return two clusters (one per group)
- **AND** the isolated entity SHALL not appear in any cluster

#### Scenario: Label propagation respects minCommunitySize

- **WHEN** `runLabelPropagation()` is called with minCommunitySize=4
- **AND** the largest connected group has 3 entities
- **THEN** it SHALL return an empty array (no clusters meet minimum)

#### Scenario: mergeCommunity creates node with BELONGS_TO edges

- **WHEN** `mergeCommunity()` is called with a community and 3 member entity IDs
- **THEN** a Community node SHALL exist with the given properties
- **AND** each member entity SHALL have a BELONGS_TO relationship to the Community

#### Scenario: cleanStaleCommunityLinks removes orphaned edges

- **WHEN** `cleanStaleCommunityLinks()` is called with a list of active community IDs
- **THEN** BELONGS_TO relationships to communities NOT in the active list SHALL be deleted
- **AND** Community nodes with no remaining BELONGS_TO relationships SHALL be deleted

### Requirement: Episodic memory has dedicated unit tests

Dedicated unit tests SHALL exist for `neo4j-client-episode.ts` covering episode creation, linking, querying, and TTL cleanup.

#### Scenario: mergeEpisode creates Episode node

- **WHEN** `mergeEpisode()` is called with episode data
- **THEN** an Episode node SHALL be created with the provided text, role, timestamp, sessionKey, and agentId

#### Scenario: linkMemoryToEpisode creates EPISODE_SOURCE edge

- **WHEN** `linkMemoryToEpisode()` is called with a memoryId and episodeId
- **THEN** the Memory node SHALL have an EPISODE_SOURCE relationship to the Episode node

#### Scenario: queryEpisodes filters by session and time range

- **WHEN** `queryEpisodes()` is called with a sessionKey and from/to timestamps
- **THEN** only episodes matching the session key within the time range SHALL be returned
- **AND** results SHALL be ordered by timestamp ascending

#### Scenario: deleteExpiredEpisodes removes old episodes

- **WHEN** `deleteExpiredEpisodes()` is called with a cutoff date
- **THEN** Episode nodes older than the cutoff SHALL be deleted
- **AND** the count of deleted episodes SHALL be returned
