## ADDED Requirements

### Requirement: Schema-agnostic structured entity property lookup

The system SHALL traverse structured graph nodes (any label: person, organization, location, event, tool, etc.) and synthesize text results from their properties for RRF fusion — independent of Memory nodes.

#### Scenario: Direct property lookup on a person node

- **WHEN** a query "What is Renu's WhatsApp?" is processed by the graph search signal
- **THEN** the system MUST find the `person` node matching "Renu" via fulltext index
- **AND** enumerate its properties (excluding internal fields: embedding, updatedAt, createdAt, agentId, id)
- **AND** return a `SearchSignalResult` with synthesized text: `person Renu Sukhani — birthday: 1978-06-16, whatsapp: +60102550716, ...`

#### Scenario: Direct property lookup on a non-person node

- **WHEN** a query "What port does Chatterbox run on?" is processed
- **THEN** the system MUST find any matching structured node (e.g. `tool` with name "Chatterbox") via fulltext index
- **AND** return synthesized text from its properties (e.g. `tool Chatterbox — port: 4123, service: chatterbox.service`)
- **AND** require zero type-specific code for the `tool` label

### Requirement: Composite fulltext index for structured nodes

The system SHALL maintain a fulltext index (`structured_entity_fulltext_index`) covering the `name` property across all structured node labels used in the graph.

#### Scenario: Index creation on startup

- **WHEN** the memory-neo4j extension initializes
- **THEN** it MUST ensure the `structured_entity_fulltext_index` exists covering at minimum labels: person, organization, location, event, tool, software
- **AND** the index MUST be additive — the existing `entity_fulltext_index` for `Entity` nodes MUST remain unchanged

#### Scenario: New node label added to graph

- **WHEN** a new structured node is created with a label not currently in the fulltext index (e.g. `project`)
- **THEN** the node's `name` property MUST still be findable via generic property enumeration during graph traversal
- **AND** the index MAY be extended to include the new label in a future initialization

### Requirement: Internal property blocklist

The system SHALL exclude internal/system properties from synthesized text output.

#### Scenario: Internal fields excluded from synthesis

- **WHEN** a structured node has properties `{name: "Renu Sukhani", birthday: "1978-06-16", embedding: [...], updatedAt: "2026-...", createdAt: "2026-...", agentId: "default", id: "uuid"}`
- **THEN** the synthesized text MUST include `name`, `birthday` and other user-facing fields
- **AND** MUST NOT include `embedding`, `updatedAt`, `createdAt`, `agentId`, or `id`

### Requirement: Multi-hop structured traversal

The system SHALL support N-hop traversal across structured nodes following typed relationships.

#### Scenario: One-hop family relationship traversal

- **WHEN** a query "Who are Tarun's sons?" is processed
- **THEN** the system MUST find the `person` node "Tarun Sukhani"
- **AND** traverse `KNOWS {relationship: "father"}` relationships to connected `person` nodes
- **AND** return synthesized text for each connected node (Kheshav Sukhani, Aaditya Sukhani)
- **AND** apply confidence decay per hop (score × 0.7 per hop)

### Requirement: SearchSignalResult interface compliance

All structured entity lookup results MUST conform to the existing `SearchSignalResult` interface used by RRF fusion.

#### Scenario: Result format compatibility

- **WHEN** structured entity results are returned from graph search
- **THEN** each result MUST have: `id` (node element id or generated), `text` (synthesized), `category` (node label), `importance` (default 0.8), `createdAt` (from node or current time), `score` (graph confidence score)
- **AND** these results MUST be fuseable with vector and BM25 results in `fuseWithConfidenceRRF()` without any interface changes
