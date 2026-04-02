## ADDED Requirements

### Requirement: Constraint definition

The system SHALL support defining ontological constraints with the following types: `uniqueness` (an entity has at most one value for a given relationship type), `mutual_exclusion` (two relationship types cannot coexist on the same entity simultaneously), `temporal_ordering` (relationship A's `validFrom` must precede relationship B's `validFrom`), `cardinality` (an entity has at most N relationships of a given type simultaneously), and `type_constraint` (only entities of specified types can participate in a given relationship type). Each constraint SHALL be scoped by `agentId`.

#### Scenario: Define a uniqueness constraint

- **WHEN** a uniqueness constraint is defined for relationship type `HAS_BIRTHDATE` on entity type `person`
- **THEN** the system stores the constraint and enforces that no person entity has more than one active `HAS_BIRTHDATE` relationship

#### Scenario: Define a mutual exclusion constraint

- **WHEN** a mutual exclusion constraint is defined for `IS_ALIVE` and `IS_DECEASED`
- **THEN** the system stores the constraint and enforces that no entity has both relationships active simultaneously

### Requirement: Capture-time validation

The system SHALL check relevant constraints before storing a new memory when entity extraction produces relationships that match a defined constraint. Violations with severity `error` SHALL block storage and return the violation details. Violations with severity `warning` SHALL allow storage but flag the memory.

#### Scenario: Blocked by uniqueness violation

- **WHEN** a new memory would create a second `HAS_BIRTHDATE` relationship for a person entity, and the uniqueness constraint has severity `error`
- **THEN** the memory is not stored and the system returns a violation message identifying the conflicting existing relationship

#### Scenario: Warning on cardinality

- **WHEN** a new memory would exceed a cardinality constraint with severity `warning`
- **THEN** the memory is stored but flagged with the constraint violation in its metadata

### Requirement: Batch consistency audit

The system SHALL run a full consistency audit during sleep Phase 16, checking all active facts and inferred facts against all defined constraints. Violations SHALL quarantine the offending memory or inferred fact.

#### Scenario: Batch audit quarantines violation

- **WHEN** the batch audit detects a temporal ordering violation (death date before birth date)
- **THEN** the newer memory is quarantined with a `quarantineReason` referencing the constraint and the conflicting memory

#### Scenario: No false positives on superseded facts

- **WHEN** a memory has been superseded (`validUntil` is set)
- **THEN** the superseded memory is excluded from constraint checking

### Requirement: On-demand consistency check

The system SHALL support checking a specific candidate fact against all constraints via the `logic_query` tool in `check` mode, without storing the fact.

#### Scenario: Check a candidate fact

- **WHEN** `logic_query({query: "John was born in 1995", mode: "check"})` is called and John already has a birth year of 1990
- **THEN** the system returns a violation result identifying the uniqueness conflict with the existing birth year

#### Scenario: No violations found

- **WHEN** a candidate fact is checked and no constraints are violated
- **THEN** the system returns a clean result with `violations: []`

### Requirement: Constraint violation reporting

Each constraint violation SHALL include: the constraint type, the constraint name, the offending entities/relationships, the conflicting existing fact, and the severity level.

#### Scenario: Violation report structure

- **WHEN** a constraint violation is detected
- **THEN** the violation includes `{type, constraintName, severity, offendingEntityId, conflictingMemoryId, message}`
