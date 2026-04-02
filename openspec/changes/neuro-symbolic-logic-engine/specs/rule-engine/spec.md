## ADDED Requirements

### Requirement: Rule storage and lifecycle

The system SHALL store rules as `Rule` nodes in Neo4j with properties: `id` (UUID), `name`, `antecedent` (Cypher MATCH pattern), `consequent` (Cypher CREATE/MERGE pattern with `{inferred: true}`), `confidence` (0-1), `confidenceFormula` ("min" | "product" | "mean"), `source` ("manual" | "learned" | "llm-proposed"), `support` (int), `headCoverage` (float), `active` (boolean), `agentId`, `validFrom`, `validUntil`, `createdAt`. Rules SHALL be scoped by `agentId`.

#### Scenario: Add a manual rule

- **WHEN** a rule is added with `source: "manual"`, a valid antecedent Cypher pattern, and a valid consequent pattern
- **THEN** the system creates a `Rule` node with `active: true`, `confidence` as specified (default 1.0), `support: 0`, and `validFrom` set to the current timestamp

#### Scenario: Deactivate a rule

- **WHEN** a rule is deactivated via `active: false`
- **THEN** the rule remains in the graph but is excluded from evaluation and materialization

#### Scenario: Temporal retirement

- **WHEN** a rule's `validUntil` is set to a past datetime
- **THEN** the rule is excluded from evaluation and materialization but preserved for provenance

### Requirement: Rule evaluation

The system SHALL evaluate a rule by executing its `antecedent` as a Cypher MATCH query scoped to the rule's `agentId`, filtering out quarantined memories and superseded facts (`validUntil IS NULL`), and producing bindings for each match.

#### Scenario: Single rule evaluation

- **WHEN** `evaluateRule(ruleId)` is called for an active rule with antecedent `(x:Entity)-[:WORKS_AT]->(y:Entity)-[:LOCATED_IN]->(z:Entity)`
- **THEN** the system returns one `InferredFact` per binding where the consequent does not already exist, with confidence computed as `rule.confidence × aggregation(edge_confidences)`

#### Scenario: Excluded facts

- **WHEN** a memory referenced in the antecedent is quarantined or has `validUntil` set
- **THEN** that memory is excluded from rule evaluation bindings

### Requirement: Fixed-point materialization

The system SHALL run all active rules iteratively until no new facts are produced or `maxIterations` (default 10) is reached. Each iteration evaluates all active rules against the current graph state including previously inferred facts.

#### Scenario: Multi-rule chain

- **WHEN** Rule A infers fact X, and Rule B's antecedent matches fact X
- **THEN** Rule B fires in the next iteration, producing fact Y, with confidence decayed by `decay^depth` (default decay=0.9)

#### Scenario: Fixed-point convergence

- **WHEN** no new facts are produced in an iteration
- **THEN** materialization terminates and returns the total count of inferred facts

#### Scenario: Iteration cap

- **WHEN** `maxIterations` is reached before convergence
- **THEN** materialization terminates, returns results so far, and logs a warning

#### Scenario: Cycle detection

- **WHEN** the same (ruleId, binding) pair is encountered in the same materialization run
- **THEN** that binding is skipped to prevent infinite loops

### Requirement: Confidence propagation

The system SHALL compute inferred fact confidence as `rule.confidence × aggregation(antecedent_edge_confidences) × decay^depth`, where `aggregation` is the rule's `confidenceFormula` and `depth` is the number of inference steps from grounding facts.

#### Scenario: Min aggregation

- **WHEN** a rule with `confidenceFormula: "min"` matches edges with confidences 0.9 and 0.7
- **THEN** the aggregated confidence is 0.7

#### Scenario: Product aggregation

- **WHEN** a rule with `confidenceFormula: "product"` matches edges with confidences 0.9 and 0.7
- **THEN** the aggregated confidence is 0.63

#### Scenario: Confidence floor

- **WHEN** an inferred fact's computed confidence is below 0.3
- **THEN** the fact is logged but NOT stored as an `InferredFact` node

### Requirement: InferredFact storage

The system SHALL store materialized inferences as `InferredFact` nodes with properties: `id` (UUID), `text` (human-readable), `confidence`, `ruleId`, `groundingMemoryIds`, `materialized` (boolean), `embedding`, `agentId`, `validFrom`, `validUntil`, `createdAt`. Each `InferredFact` SHALL have an `INFERRED_BY` relationship to its `Rule` and `GROUNDED_IN` relationships to its source `Memory` nodes.

#### Scenario: InferredFact participates in search

- **WHEN** a hybrid search query matches an `InferredFact` node's embedding or text
- **THEN** the `InferredFact` is included in search results with `source: "inferred"` and its provenance (rule name, grounding memories)

#### Scenario: InferredFact retraction

- **WHEN** a grounding memory is deleted, quarantined, or superseded
- **THEN** the system recomputes the `InferredFact`'s confidence; if no valid grounding remains, the `InferredFact` is removed

### Requirement: Dry-run mode

The system SHALL support a `dryRun` option on materialization that returns the list of inferred facts that would be created without writing them to the graph.

#### Scenario: Dry run

- **WHEN** `materialize({dryRun: true})` is called
- **THEN** the system returns `InferredFact[]` with computed confidences but does not create any nodes or relationships
