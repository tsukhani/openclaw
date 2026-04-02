## ADDED Requirements

### Requirement: Causal model storage

The system SHALL store structural causal models (SCMs) as subgraphs in Neo4j with `CausalModel` nodes (id, name, description, agentId), `CausalVariable` nodes (id, name, type: endogenous|exogenous, domain: binary|categorical|continuous|ordinal, observedValue, agentId), `CAUSES` relationships between variables (coefficient, mechanism, functional_form), and `PART_OF_MODEL` relationships from variables to their model. Models SHALL be scoped by `agentId`.

#### Scenario: Create a causal model

- **WHEN** `discoverStructure({method: "llm-assisted", entityScope: ["project-alpha"]})` is called
- **THEN** the system creates a `CausalModel` node, `CausalVariable` nodes for identified variables, and `CAUSES` edges with extracted mechanisms, all scoped to the agent's ID

#### Scenario: Model is a DAG

- **WHEN** causal structure discovery produces cycles
- **THEN** the system resolves cycles using temporal ordering (earlier events cause later events) and logs any unresolvable cycles as warnings

### Requirement: Association queries (Pearl Level 1)

The system SHALL support association queries by delegating to the existing hybrid search pipeline with causal-edge-aware graph traversal.

#### Scenario: Association query

- **WHEN** `causal_query({query: "Is project delay related to team changes?", level: "association"})` is called
- **THEN** the system returns correlated memories with causal path information and a confidence score, without making causal claims

### Requirement: Intervention queries (Pearl Level 2)

The system SHALL support interventional queries by implementing the do-operator as graph surgery on virtual subgraphs. The engine SHALL create a virtual copy of the relevant causal subgraph using APOC, remove all incoming edges to the intervened variable, set the intervention value, and forward-propagate through remaining causal edges to compute P(Y|do(X)).

#### Scenario: Simple intervention

- **WHEN** `causal_query({query: "What would happen to project timeline if we add two engineers?", level: "intervention", intervention: {variable: "team_size", value: "increased_by_2"}})` is called
- **THEN** the system performs graph surgery on the causal model, propagates effects through `CAUSES` edges, and returns the predicted outcome with confidence and the causal path traversed

#### Scenario: No causal model available

- **WHEN** an intervention query is issued but no `CausalModel` exists for the relevant domain
- **THEN** the system returns an error indicating no causal model is available and suggests running `memory_rules({action: "learn"})` or building a model from existing causal edges

#### Scenario: Adjustment set computation

- **WHEN** an intervention query is issued without an explicit `adjustmentSet`
- **THEN** the system auto-computes the minimal adjustment set using the back-door criterion on the causal DAG

### Requirement: Counterfactual queries (Pearl Level 3)

The system SHALL support counterfactual queries via the three-step abduction-action-prediction process: (1) abduction — infer exogenous variable values from observed evidence using structural equations, (2) action — apply the intervention via graph surgery, (3) prediction — forward-propagate through the modified SCM with inferred exogenous values.

#### Scenario: Counterfactual query

- **WHEN** `causal_query({query: "If we hadn't delayed the release, would the client have renewed?", level: "counterfactual", evidence: {release: "delayed", client_renewal: "no"}, intervention: {variable: "release", value: "on_time"}})` is called
- **THEN** the system performs abduction to infer background factors, applies the intervention, propagates through the modified model, and returns the counterfactual outcome with confidence and explicit assumptions

#### Scenario: Insufficient model specification

- **WHEN** a counterfactual query requires structural equations that are not defined in the causal model
- **THEN** the system returns a partial result with the available inference and lists which equations are missing, along with confidence reflecting the incompleteness

### Requirement: Causal structure discovery

The system SHALL support building causal models from the existing knowledge graph via three methods: `temporal` (mine temporal precedence patterns from `TEMPORAL_NEXT` chains), `llm-assisted` (LLM proposes causal hypotheses from memory text, validated against temporal graph), and `hybrid` (both methods combined with cross-validation).

#### Scenario: Temporal discovery

- **WHEN** `discoverStructure({method: "temporal", minSupport: 3})` is called
- **THEN** the system identifies variable pairs where A's state changes consistently precede B's state changes (at least `minSupport` occurrences), proposes them as causal edges, and stores the resulting model

#### Scenario: LLM-assisted discovery

- **WHEN** `discoverStructure({method: "llm-assisted", entityScope: ["hiring"]})` is called
- **THEN** the LLM reviews memories related to the specified scope, proposes causal relationships with mechanism descriptions, and the system validates each against temporal data before storing

### Requirement: Causal query output

Every causal query response SHALL include: the answer (human-readable), the causal level used, a confidence score, the causal path (chain of variables), and explicit assumptions the model makes.

#### Scenario: Output includes assumptions

- **WHEN** any causal query returns a result
- **THEN** the result includes an `assumptions` array listing causal model assumptions (e.g., "no unobserved confounders between X and Y", "linear relationship assumed")

### Requirement: Sleep Phase 17 — causal model update

The system SHALL update causal models during sleep Phase 17 by incorporating new causal edges extracted since the last sleep cycle, re-validating existing edges against updated temporal data, and adjusting confidence scores on `CAUSES` relationships.

#### Scenario: New causal edges incorporated

- **WHEN** new `CAUSED_BY` relationships have been extracted since the last sleep cycle
- **THEN** Phase 17 evaluates whether they strengthen, weaken, or contradict existing causal model edges, and updates the model accordingly
