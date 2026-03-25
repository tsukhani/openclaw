## ADDED Requirements

### Requirement: Raw conversation segments are stored as Episode nodes

The memory-neo4j extension SHALL support storing raw conversation segments as Episode nodes in Neo4j. An Episode SHALL contain the unmodified message text, role (user/assistant), timestamp, sessionKey, and agentId. Episodes SHALL preserve the full conversational context without any extraction, summarization, or filtering applied.

#### Scenario: User message is stored as an episode

- **WHEN** `episodicMemory.enabled` is true
- **AND** the agent_end hook fires with a user message
- **THEN** an Episode node SHALL be created with the raw message text, role "user", and the current session key
- **AND** the Episode SHALL be stored regardless of whether the attention gate passes or rejects the message for semantic memory

#### Scenario: Assistant message is stored as an episode

- **WHEN** `episodicMemory.enabled` is true and `episodicMemory.captureAssistant` is true
- **AND** the agent_end hook fires with an assistant response
- **THEN** an Episode node SHALL be created with the raw assistant text and role "assistant"

#### Scenario: Episodes are stored independently of semantic memories

- **WHEN** a message is rejected by the attention gate (noise filtered)
- **THEN** the Episode node SHALL still be created
- **AND** no semantic Memory node SHALL be created for the rejected message

### Requirement: Episodes link to extracted semantic memories

When a message produces both an Episode and a semantic Memory (via auto-capture), the Memory SHALL be linked to its source Episode via an `EPISODE_SOURCE` relationship. This enables tracing from a distilled fact back to its original conversational context.

#### Scenario: Auto-captured memory links to its episode

- **WHEN** a user message passes the attention gate and is auto-captured as a semantic Memory
- **AND** episodic memory is enabled
- **THEN** the Memory node SHALL have an `EPISODE_SOURCE` relationship pointing to the corresponding Episode node

#### Scenario: Manually stored memory has no episode link

- **WHEN** a memory is stored via the `memory_store` tool (not auto-captured)
- **THEN** the Memory node SHALL NOT have an `EPISODE_SOURCE` relationship
- **AND** no Episode node SHALL be created for the tool call

### Requirement: Episodes are excluded from semantic search

Episode nodes SHALL NOT appear in the results of `memory_recall` searches. The vector, BM25, and graph signals SHALL query only Memory nodes. Episodes are a preservation layer, not a retrieval layer.

#### Scenario: memory_recall does not return episodes

- **WHEN** a hybrid search is executed via `memory_recall`
- **THEN** the results SHALL contain only Memory nodes
- **AND** no Episode nodes SHALL appear in the result set

### Requirement: Episodes are queryable via dedicated tool

The extension SHALL register a `memory_episodes` tool that retrieves episodes for a given session or time range. This tool SHALL support filtering by sessionKey, agentId, and time range (from/to). Results SHALL be ordered by timestamp ascending.

#### Scenario: Retrieve episodes for a session

- **WHEN** `memory_episodes` is called with a specific sessionKey
- **THEN** the tool SHALL return all Episode nodes for that session in chronological order
- **AND** each result SHALL include the raw text, role, and timestamp

#### Scenario: Retrieve episodes for a time range

- **WHEN** `memory_episodes` is called with from and to timestamps
- **THEN** the tool SHALL return all Episode nodes within that time range for the calling agent

### Requirement: Episode storage has configurable retention

Episodes SHALL have a configurable retention period (`episodicMemory.retentionDays`, default 30). Episodes older than the retention period SHALL be deleted during the sleep cycle cleanup phase. The retention policy SHALL be independent of semantic memory decay curves.

#### Scenario: Old episodes are cleaned up

- **WHEN** the sleep cycle runs and episodes older than 30 days exist (default retention)
- **THEN** the cleanup phase SHALL delete Episode nodes older than the retention period
- **AND** `EPISODE_SOURCE` relationships from linked Memory nodes SHALL be removed

#### Scenario: Custom retention period is respected

- **WHEN** `episodicMemory.retentionDays` is configured to 90
- **THEN** episodes older than 90 days SHALL be deleted during cleanup
- **AND** episodes younger than 90 days SHALL be preserved

### Requirement: Episodic memory is disabled by default

Episodic memory capture SHALL be disabled by default (`episodicMemory.enabled: false`). When disabled, no Episode nodes SHALL be created and no `memory_episodes` tool SHALL be registered.

#### Scenario: Default config skips episode capture

- **WHEN** no `episodicMemory` config section is provided
- **THEN** no Episode nodes SHALL be created during agent_end processing
- **AND** the `memory_episodes` tool SHALL NOT appear in the tool registry

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
