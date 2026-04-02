## ADDED Requirements

### Requirement: Path-based rule mining

The system SHALL discover rules by sampling random edges from the entity graph, performing random walks (up to `maxRuleLength` hops, default 3) from the source entity, and when a walk reaches the target entity, generalizing the path into a candidate rule by replacing specific entities with variables. Each candidate rule SHALL be scored by `support` (number of grounding instances) and `PCA confidence` (support / (support + counterexamples under partial completeness assumption)).

#### Scenario: Rule discovery from paths

- **WHEN** `learnRules({maxRuleLength: 3, minSupport: 5, minConfidence: 0.6, sampleSize: 1000, timeLimit: 30})` is called
- **THEN** the system samples edges, walks paths, generalizes into rules, computes support and confidence, and returns rules meeting the thresholds sorted by confidence descending

#### Scenario: Anytime behavior

- **WHEN** `timeLimit` is reached before all samples are processed
- **THEN** the system stops sampling and returns the rules discovered so far, with a flag indicating the run was time-limited

#### Scenario: Deduplication

- **WHEN** multiple random walks produce the same generalized rule pattern
- **THEN** the system merges them into a single rule candidate with aggregated support count

### Requirement: LLM-assisted rule proposal

The system SHALL support LLM-assisted rule proposal where the LLM receives a schema summary (entity types, relationship types, sample patterns) and proposes candidate rules in structured format (antecedent pattern, consequent pattern, natural language explanation). Each proposed rule SHALL be validated against the graph before activation.

#### Scenario: LLM proposes a valid rule

- **WHEN** `proposeAndValidate({domain: "employment"})` is called and the LLM proposes "if X works at Y and Y is in Z, then X is located in Z"
- **THEN** the system translates the proposal into a Cypher-pattern rule, computes support and PCA confidence against the graph, and if both meet thresholds, stores the rule with `source: "llm-proposed"`

#### Scenario: LLM proposes an invalid rule

- **WHEN** the LLM proposes a rule that has support < `minSupport` or confidence < `minConfidence`
- **THEN** the rule is NOT activated, is logged with its computed statistics, and the system returns it in the response with `status: "rejected"` and the reason

#### Scenario: LLM proposes a syntactically invalid rule

- **WHEN** the LLM proposes a rule whose Cypher pattern fails to parse
- **THEN** the system reports a syntax error and does not store the rule

### Requirement: Rule validation gate

Every learned or LLM-proposed rule SHALL pass through a validation gate before activation. The gate checks: (1) `support >= minSupport` (default 5), (2) `PCA confidence >= minConfidence` (default 0.6), (3) no contradiction with existing active rules, and (4) the consequent pattern is syntactically valid Cypher.

#### Scenario: Rule passes validation

- **WHEN** a candidate rule has support=12, confidence=0.78, no contradictions, and valid Cypher
- **THEN** the rule is stored with `active: true` and `source` reflecting its origin

#### Scenario: Rule fails on support

- **WHEN** a candidate rule has support=2 (below minSupport=5)
- **THEN** the rule is rejected with reason "insufficient support"

#### Scenario: Rule contradicts existing rule

- **WHEN** a candidate rule's consequent contradicts an existing active rule's consequent (produces a fact that violates a consistency constraint)
- **THEN** the rule is rejected with reason "contradicts rule: <existing_rule_name>" and a `CONTRADICTS` relationship is created between the two rules

### Requirement: Active rule cap

The system SHALL enforce a configurable maximum number of active rules per agent (default 100). When the cap is reached, the system SHALL prune the lowest-support active rules to make room for new higher-quality rules.

#### Scenario: Cap enforcement

- **WHEN** an agent has 100 active rules and a new rule with support=20 passes validation
- **THEN** the system deactivates the active rule with the lowest support (if its support < 20) and activates the new rule

#### Scenario: Cap not reached

- **WHEN** an agent has fewer than 100 active rules
- **THEN** new validated rules are activated without pruning

### Requirement: Sleep Phase 14 — rule learning

The system SHALL run path-based rule mining during sleep Phase 14, after entity extraction and reclassification are complete (Phases 2, 13). Phase 14 SHALL be time-bounded (configurable, default 60 seconds) and skip entirely if the entity graph has fewer than 10 entities.

#### Scenario: Phase 14 runs successfully

- **WHEN** sleep Phase 14 executes with an entity graph of 50+ entities
- **THEN** the system runs path-based mining within the time limit, validates candidates, and stores new rules, reporting counts in the sleep cycle result

#### Scenario: Phase 14 skips on small graph

- **WHEN** the entity graph has fewer than 10 entities
- **THEN** Phase 14 is skipped with a log message "graph too small for rule learning"

### Requirement: Rule pruning during sleep

The system SHALL prune rules with `support < 3` during sleep consolidation. Pruned rules have `active` set to `false` and `validUntil` set to the current timestamp, preserving them for provenance.

#### Scenario: Low-support rule pruned

- **WHEN** a rule has `support: 1` after re-evaluation during sleep
- **THEN** the rule is deactivated with `active: false` and `validUntil` set to current timestamp
