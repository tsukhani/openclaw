## ADDED Requirements

### Requirement: validFrom field preserved during memory ingestion

The eval harness SHALL use the `validFrom` value from test fixture memories when storing them in Neo4j. When `validFrom` is not present, the harness SHALL fall back to `createdAt`.

#### Scenario: Fixture memory with explicit validFrom

- **WHEN** a test memory has `validFrom: "2025-03-01T08:00:00Z"` and `createdAt: "2025-01-15T08:00:00Z"`
- **THEN** the stored memory node MUST have `validFrom = "2025-03-01T08:00:00Z"`

#### Scenario: Fixture memory without validFrom

- **WHEN** a test memory has `createdAt: "2025-01-15T08:00:00Z"` and no `validFrom` field
- **THEN** the stored memory node MUST have `validFrom = "2025-01-15T08:00:00Z"` (falls back to createdAt)

### Requirement: Context completeness judge receives golden answer

The context completeness evaluation SHALL pass the test case's `golden_answer` to the LLM judge as a reference for assessing context sufficiency.

#### Scenario: Judge prompt includes golden answer

- **WHEN** evaluating context completeness for a test case with `golden_answer: "Tioman Island"`
- **THEN** the LLM judge prompt MUST include the golden answer as an evaluator reference

#### Scenario: Abstention case with empty retrieval

- **WHEN** evaluating context completeness for an abstention case that retrieved zero memories
- **THEN** the system SHALL return COMPLETE without calling the LLM judge (existing behavior preserved)

### Requirement: Empty gold set cases excluded from retrieval metric averages

Cases with empty `gold_memory_ids` (LongMemEval, abstention) SHALL be excluded from retrieval metric averages (precision, recall, F1, MRR, NDCG, hitRate) to prevent vacuous values from distorting aggregates.

#### Scenario: Mixed dataset with empty and non-empty gold sets

- **WHEN** aggregating metrics across 3 cases where 1 has `gold_memory_ids: []` and 2 have actual gold IDs
- **THEN** retrieval metric averages MUST be computed over the 2 non-empty cases only
- **THEN** `caseCount` MUST reflect the total count (3)

#### Scenario: All cases have empty gold sets

- **WHEN** aggregating metrics for a pure LongMemEval run where all cases have `gold_memory_ids: []`
- **THEN** retrieval metric averages MUST be 0
- **THEN** `caseCount` MUST reflect the actual number of cases

### Requirement: Entity cleanup scoped to eval namespace

The eval harness SHALL NOT call `findOrphanEntities()` during cleanup, to prevent deletion of entities belonging to other agents sharing the same Neo4j instance.

#### Scenario: Eval cleanup after test group

- **WHEN** the harness completes a test group and runs cleanup
- **THEN** stored test memories MUST be deleted by their IDs
- **THEN** the harness MUST NOT scan for or delete orphan Entity nodes

#### Scenario: Production mode cleanup skipped

- **WHEN** the harness runs in production mode
- **THEN** no cleanup of any kind SHALL occur (existing behavior preserved)
