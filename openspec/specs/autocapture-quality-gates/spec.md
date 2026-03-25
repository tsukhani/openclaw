## MODIFIED Requirements

### Requirement: Importance thresholds allow moderately useful content

The autocapture pipeline SHALL use an importance threshold of 0.6 for user messages and 0.7 for assistant messages (when extraction is enabled). Additionally, the pipeline SHALL run instruction-pattern detection after importance rating but before storage. Memories flagged as instruction-like SHALL be stored with `trustScore: 0.0` and `quarantined: true` instead of being silently captured at their rated importance.

#### Scenario: User message rated 6/10 is stored

- **WHEN** a user message receives an importance score of 6 from the LLM rater (normalized to 0.6)
- **THEN** the pipeline SHALL store it (0.6 meets the 0.6 threshold)

#### Scenario: User message rated 5/10 is rejected

- **WHEN** a user message receives an importance score of 5 from the LLM rater (normalized to 0.5)
- **THEN** the pipeline SHALL reject it (0.5 is below the 0.6 threshold)

#### Scenario: Assistant message rated 7/10 is stored

- **WHEN** an assistant message receives an importance score of 7 from the LLM rater (normalized to 0.7)
- **THEN** the pipeline SHALL store it (0.7 meets the 0.7 threshold)

#### Scenario: Assistant message rated 6/10 is rejected

- **WHEN** an assistant message receives an importance score of 6 from the LLM rater (normalized to 0.6)
- **THEN** the pipeline SHALL reject it (0.6 is below the 0.7 threshold)

#### Scenario: High-importance instruction-like content is quarantined

- **WHEN** a user message receives importance score 9/10
- **AND** the instruction-pattern detector flags it as instruction-like
- **THEN** the pipeline SHALL store the memory with `trustScore: 0.0` and `quarantined: true`
- **AND** the memory SHALL NOT appear in default `memory_recall` results

#### Scenario: Instruction detection does not apply when disabled

- **WHEN** `instructionDetection.enabled` is false
- **AND** a user message receives importance score 8/10
- **THEN** the pipeline SHALL store the memory normally with default trust score
- **AND** no instruction-pattern check SHALL be performed

### Requirement: Auto-capture detects credentials at capture time

The auto-capture pipeline SHALL check message text for credential patterns (API keys, tokens, passwords, private keys) before storing a memory. When a credential is detected, the memory SHALL be stored with `quarantined: true` and `trustScore: 0.0`. This check SHALL use the same `detectCredential()` function used by the sleep cycle credential scan phase.

#### Scenario: API key in user message is quarantined immediately

- **WHEN** a user message containing "my key is sk-ant-api03-abc123..." passes the attention gate
- **AND** auto-capture processes the message
- **THEN** the memory SHALL be stored with `quarantined: true` and `trustScore: 0.0`
- **AND** the memory SHALL NOT appear in default `memory_recall` results
- **AND** a warning SHALL be logged indicating credential detection

#### Scenario: Bearer token in message is quarantined immediately

- **WHEN** a user message containing "Authorization: Bearer eyJhbGci..." passes the attention gate
- **AND** auto-capture processes the message
- **THEN** the memory SHALL be stored with `quarantined: true` and `trustScore: 0.0`

#### Scenario: Normal message without credentials is stored normally

- **WHEN** a user message containing "The deployment went well and we hit our latency targets" passes the attention gate
- **AND** auto-capture processes the message
- **THEN** the memory SHALL be stored with default `trustScore: 1.0` and no `quarantined` flag

#### Scenario: Credential detection does not block auto-capture pipeline

- **WHEN** the `detectCredential()` function throws an unexpected error
- **THEN** the auto-capture pipeline SHALL continue and store the memory normally
- **AND** the error SHALL be logged at debug level

### Requirement: Inline contradiction detection in semantic dedup band

The autocapture pipeline SHALL check for contradictions against existing memories in the 0.75-0.95 vector similarity band. When a candidate is not a semantic duplicate but contradicts the new memory, the pipeline SHALL mark the older memory as superseded and store the new memory normally.

#### Scenario: Contradicting memory supersedes the older one

- **WHEN** a new memory "Alice works at Acme Corp" has a vector similarity of 0.85 with existing memory "Alice works at Beta Inc"
- **AND** semantic dedup determines they are NOT paraphrases
- **AND** contradiction detection determines they ARE contradictory
- **THEN** the pipeline SHALL set `supersededBy` on the older memory to the new memory's ID
- **AND** the pipeline SHALL set `validUntil` on the older memory to the current timestamp
- **AND** the pipeline SHALL store the new memory normally

#### Scenario: Non-contradicting memory in the dedup band is stored normally

- **WHEN** a new memory "Alice likes coffee" has a vector similarity of 0.80 with existing memory "Alice enjoys morning walks"
- **AND** semantic dedup determines they are NOT paraphrases
- **AND** contradiction detection determines they are NOT contradictory
- **THEN** the pipeline SHALL store the new memory normally
- **AND** the existing memory SHALL NOT be modified

#### Scenario: Contradiction check is skipped when extraction is disabled

- **WHEN** `extraction.enabled` is false
- **AND** a new memory enters the 0.75-0.95 similarity band
- **THEN** no contradiction check SHALL be performed (no LLM available)
- **AND** the pipeline SHALL proceed to store the memory normally

### Requirement: Regex pattern complexity guard

The `deleteMemoriesByPattern()` function SHALL reject regex patterns that contain structural indicators of catastrophic backtracking, in addition to the existing 200-character length cap.

#### Scenario: Nested quantifier pattern is rejected

- **WHEN** a caller passes the pattern `(a+)+$` to `deleteMemoriesByPattern()`
- **THEN** the function SHALL throw an error indicating the pattern contains nested quantifiers
- **AND** no Neo4j query SHALL be executed

#### Scenario: Excessive alternation is rejected

- **WHEN** a caller passes a pattern with more than 10 alternation branches (pipe characters)
- **THEN** the function SHALL throw an error indicating excessive alternation
- **AND** no Neo4j query SHALL be executed

#### Scenario: Simple valid pattern is accepted

- **WHEN** a caller passes the pattern `old project.*2024`
- **THEN** the function SHALL execute the delete query normally

### Requirement: Batched entity property writes

The `batchEntityOperations()` function SHALL write entity properties for all entities in a single Neo4j round-trip using UNWIND, rather than issuing one query per entity.

#### Scenario: Multiple entities with properties are written in one query

- **WHEN** entity extraction produces 5 entities, each with structured properties
- **THEN** the function SHALL execute a single UNWIND-based Cypher query to set all properties
- **AND** all 5 entities SHALL have their properties correctly set on their nodes

#### Scenario: Entities without properties are unaffected

- **WHEN** entity extraction produces 3 entities with properties and 2 without
- **THEN** only the 3 entities with properties SHALL be included in the UNWIND batch
- **AND** the 2 entities without properties SHALL not be included in the property-write query

### Requirement: Robust connection error classification

The `isNeo4jConnectionError()` function SHALL prefer structured error properties (code, errno) over string matching for error classification.

#### Scenario: Neo4j driver error with code property

- **WHEN** an error has `code: "ServiceUnavailable"`
- **THEN** the function SHALL return true based on the code property
- **AND** SHALL NOT rely on string matching the error message

#### Scenario: OS-level network error with errno

- **WHEN** an error has `code: "ECONNREFUSED"` (Node.js system error)
- **THEN** the function SHALL return true based on the code property

#### Scenario: Unknown error with connection message but no code

- **WHEN** an error has no `code` or `errno` property
- **AND** the error message contains "connection acquisition timed out"
- **THEN** the function SHALL return true via string fallback

#### Scenario: Non-connection error is correctly rejected

- **WHEN** an error has `code: "Neo.ClientError.Statement.SyntaxError"`
- **THEN** the function SHALL return false (not a connection error)
