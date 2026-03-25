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
