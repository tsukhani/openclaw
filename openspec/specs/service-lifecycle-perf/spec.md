## ADDED Requirements

### Requirement: Connection pool health check interval

The service SHALL run a periodic connection health check every 60 seconds using `verifyConnection()` to detect stale Neo4j connections before they cause hot-path retry latency. The timer SHALL use `.unref()` to avoid blocking process exit and SHALL be cleared on service stop.

#### Scenario: Health check runs periodically

- **WHEN** the memory-neo4j service is running
- **THEN** the system SHALL call `verifyConnection()` every 60 seconds

#### Scenario: Health check does not block shutdown

- **WHEN** the service stop is called
- **THEN** the health check interval SHALL be cleared and the timer SHALL have been `.unref()`'d so it does not prevent process exit

#### Scenario: Health check failure is non-fatal

- **WHEN** a periodic health check call to `verifyConnection()` fails
- **THEN** the system SHALL log at debug level and continue operation (the connection pool will reconnect on next use)

### Requirement: Embedding cache pre-warming on service start

The service SHALL pre-warm the embedding cache by embedding up to 10 core memories during service start, after successful Neo4j initialization. This eliminates cold-start embedding latency (~100-200ms) on the first auto-recall after gateway restart.

#### Scenario: Core memories embedded at startup

- **WHEN** the service starts successfully and `autoRecall` is enabled
- **THEN** the system SHALL load up to 10 core memories and call `embedBatch()` to populate the embedding cache

#### Scenario: Pre-warm failure is non-fatal

- **WHEN** embedding pre-warm fails (no core memories, embedding API error)
- **THEN** the service SHALL continue starting normally and log the failure at debug level

#### Scenario: Pre-warm skipped when autoRecall disabled

- **WHEN** the service starts with `autoRecall` disabled in config
- **THEN** the system SHALL skip embedding cache pre-warming
