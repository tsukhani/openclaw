## ADDED Requirements

### Requirement: Pipeline orchestrates 3 stages sequentially

The extraction pipeline SHALL execute Stage 0 (regex), Stage 1 (NER), and Stage 2 (LLM) in sequence. Stage 0 and Stage 1 results SHALL be merged before deciding whether Stage 2 is needed. The pipeline SHALL run inside the existing `extractEntities()` function, preserving its signature and return type.

#### Scenario: Full pipeline execution

- **WHEN** `extractEntities()` is called with a memory text
- **THEN** Stage 0 regex runs first, then Stage 1 NER, then Stage 2 LLM receives local results as context

#### Scenario: Local extraction finds entities

- **WHEN** Stage 0+1 find at least one entity
- **THEN** Stage 2 receives pre-extracted entities in its prompt context and uses a lighter prompt focused on relationships, tags, and category

#### Scenario: Local extraction finds nothing

- **WHEN** Stage 0+1 find zero entities
- **THEN** Stage 2 uses the full extraction prompt (current behavior)

#### Scenario: Extraction disabled

- **WHEN** `config.enabled` is false
- **THEN** pipeline returns null without running any stage

### Requirement: LLM prompt adapts to pre-extracted entities

When local extractors produce entities, the LLM prompt SHALL include the pre-extracted entities as context in the user message. The system prompt SHALL instruct the LLM to focus on relationships, tags, and category classification, and to add any entities the local extraction missed. Entity names and types from local extraction SHALL be listed explicitly.

#### Scenario: Pre-extracted context in prompt

- **WHEN** local extraction found "alice" (person) and "acme corp" (organization)
- **THEN** the user message sent to LLM includes "Previously extracted entities (verified): alice (person), acme corp (organization)" before the memory text

#### Scenario: No pre-extracted context

- **WHEN** local extraction found zero entities
- **THEN** the user message sent to LLM contains only the memory text (no pre-extracted context)

### Requirement: Confidence-based merge combines local and LLM results

The merge function SHALL combine entities from local extraction and LLM extraction. When both produce an entity with the same normalized name, the entity with higher confidence SHALL be kept. Local entities SHALL have a fixed confidence of 0.85. LLM entity confidence SHALL be inferred from the extraction output (default 0.8 when not specified). Relationships, tags, and category SHALL always come from the LLM result.

#### Scenario: Same entity from both stages

- **WHEN** local extraction produces `{ name: "alice", type: "person", confidence: 0.85 }` and LLM produces `{ name: "alice", type: "person", confidence: 0.9 }`
- **THEN** the LLM version is kept (0.9 > 0.85)

#### Scenario: Different entities from each stage

- **WHEN** local extraction produces "alice" (person) and LLM produces "project alpha" (concept)
- **THEN** both entities are included in the merged result

#### Scenario: Local properties merged into LLM entity

- **WHEN** local extraction produces `{ name: "alice", properties: { email: "a@b.com" } }` and LLM produces `{ name: "alice", type: "person", description: "team lead" }`
- **THEN** merged entity has both the LLM's description/type and the local properties

#### Scenario: LLM-only fields

- **WHEN** merge is called with local and LLM results
- **THEN** relationships, tags, and category are taken from the LLM result exclusively

### Requirement: Stage failures are non-fatal

If Stage 0 or Stage 1 fails, the pipeline SHALL log a warning and proceed to Stage 2 with no pre-extracted context. Stage 2 (LLM) failure handling SHALL remain unchanged (transient vs permanent failure classification).

#### Scenario: NER model load failure

- **WHEN** Stage 1 NER model fails to initialize
- **THEN** pipeline logs warning, skips Stage 1, proceeds to Stage 2 with only Stage 0 results

#### Scenario: Regex extractor throws

- **WHEN** Stage 0 regex throws an unexpected error
- **THEN** pipeline logs warning, skips Stage 0, proceeds to Stage 1 and Stage 2

### Requirement: Pipeline is configurable

The pipeline SHALL respect `extraction.localNer.enabled` (default: true). When disabled, Stage 0 and Stage 1 are skipped entirely and the pipeline behaves identically to the current LLM-only extraction.

#### Scenario: Local NER enabled (default)

- **WHEN** `extraction.localNer.enabled` is true or unset
- **THEN** all 3 stages execute

#### Scenario: Local NER disabled

- **WHEN** `extraction.localNer.enabled` is false
- **THEN** only Stage 2 (LLM) executes with the original full prompt
