## ADDED Requirements

### Requirement: logic_query tool

The system SHALL expose a `logic_query` tool to the agent with parameters: `query` (string, required), `mode` ("infer" | "check" | "explain", required), and `maxDepth` (number, optional, default 3). The tool SHALL be registered via the plugin's `registerTool` interface with `agentId` injected from context.

#### Scenario: Infer mode

- **WHEN** `logic_query({query: "Where does John live?", mode: "infer"})` is called and a rule can infer John's location from his employment and company location
- **THEN** the tool returns `{answer, confidence, inferenceChain: [{rule, bindings, confidence}...], supportingMemories: [memoryId...]}`

#### Scenario: Check mode

- **WHEN** `logic_query({query: "John was born in 1995", mode: "check"})` is called
- **THEN** the tool delegates to the consistency checker and returns any constraint violations or a clean result

#### Scenario: Explain mode

- **WHEN** `logic_query({query: "Why do we think John lives in Berlin?", mode: "explain"})` is called
- **THEN** the tool returns the full inference chain from grounding facts through each rule application, with confidence at each step and the grounding memory texts

#### Scenario: No inference possible

- **WHEN** `logic_query({query: "What is John's favorite color?", mode: "infer"})` is called and no rules can infer the answer
- **THEN** the tool returns `{answer: null, confidence: 0, inferenceChain: [], supportingMemories: []}` indicating no formal inference was possible

#### Scenario: maxDepth limits chain

- **WHEN** `logic_query` is called with `maxDepth: 1` and the answer requires a 2-step inference chain
- **THEN** the tool returns no result (the chain is too deep for the specified limit)

### Requirement: causal_query tool

The system SHALL expose a `causal_query` tool to the agent with parameters: `query` (string, required), `level` ("association" | "intervention" | "counterfactual", required), `intervention` ({variable, value}, optional, required for intervention/counterfactual levels), and `evidence` (Record<string, string>, optional, used for counterfactual level). The tool SHALL return `{answer, level, confidence, causalPath: [variable...], assumptions: [string...]}`.

#### Scenario: Association level

- **WHEN** `causal_query({query: "Are team changes related to project delays?", level: "association"})` is called
- **THEN** the tool delegates to hybrid search with causal-edge-aware traversal and returns correlated findings without causal claims

#### Scenario: Intervention level

- **WHEN** `causal_query({query: "What if we hire two more engineers?", level: "intervention", intervention: {variable: "team_size", value: "increased_by_2"}})` is called
- **THEN** the tool performs graph surgery on the relevant causal model and returns the predicted effect on downstream variables with confidence and assumptions

#### Scenario: Counterfactual level

- **WHEN** `causal_query({query: "Would the client have renewed if we shipped on time?", level: "counterfactual", evidence: {release: "delayed", renewal: "no"}, intervention: {variable: "release", value: "on_time"}})` is called
- **THEN** the tool performs abduction-action-prediction and returns the counterfactual outcome with confidence and assumptions

#### Scenario: Missing intervention parameter

- **WHEN** `causal_query` is called with `level: "intervention"` but no `intervention` parameter
- **THEN** the tool returns an error indicating that `intervention` is required for this level

### Requirement: memory_rules tool

The system SHALL expose a `memory_rules` tool to the agent with parameters: `action` ("list" | "add" | "remove" | "learn" | "validate", required), `rule` (RuleDefinition, required for "add"), and `learnOptions` ({domain, method}, optional, used for "learn" action).

#### Scenario: List rules

- **WHEN** `memory_rules({action: "list"})` is called
- **THEN** the tool returns all active rules for the agent, sorted by confidence descending, with support and source for each

#### Scenario: Add a rule

- **WHEN** `memory_rules({action: "add", rule: {name: "co-location", antecedent: "...", consequent: "..."}})` is called with a valid rule definition
- **THEN** the tool creates the rule with `source: "manual"` and returns the created rule's ID and initial statistics

#### Scenario: Remove a rule

- **WHEN** `memory_rules({action: "remove", rule: {name: "co-location"}})` is called
- **THEN** the tool deactivates the rule (sets `active: false`, `validUntil: now`) and returns confirmation

#### Scenario: Learn rules

- **WHEN** `memory_rules({action: "learn", learnOptions: {domain: "employment", method: "hybrid"}})` is called
- **THEN** the tool triggers rule learning (path-based mining + LLM proposal) scoped to the specified domain and returns the discovered rules with their statistics

#### Scenario: Validate existing rules

- **WHEN** `memory_rules({action: "validate"})` is called
- **THEN** the tool re-evaluates all active rules against the current graph state, updates support and confidence scores, and deactivates rules that no longer meet thresholds

### Requirement: Provenance in tool responses

All reasoning tool responses that include inferred facts SHALL include provenance information: the rule that produced the inference, the grounding memory IDs, and the confidence at each step. This provenance SHALL integrate with the existing search provenance system (OP-200).

#### Scenario: Provenance in logic_query infer mode

- **WHEN** `logic_query` returns an inferred answer
- **THEN** each element in `inferenceChain` includes `{ruleName, ruleId, bindings: {variable: entityName}, stepConfidence, groundingMemoryIds}`

#### Scenario: Provenance in causal_query

- **WHEN** `causal_query` returns a result
- **THEN** the result includes `causalPath` listing each variable in the causal chain and `assumptions` listing each modeling assumption

### Requirement: Tool graceful degradation

All reasoning tools SHALL degrade gracefully when the reasoning infrastructure is unavailable or insufficient. Tools SHALL NOT throw errors that terminate the agent's reasoning loop.

#### Scenario: No rules defined

- **WHEN** `logic_query` is called in `infer` mode but no rules exist for the agent
- **THEN** the tool returns a message indicating no rules are available and suggests using `memory_rules({action: "learn"})` to discover rules

#### Scenario: Neo4j unreachable

- **WHEN** any reasoning tool is called but the Neo4j connection is down
- **THEN** the tool returns a fallback response indicating the reasoning backend is unavailable, consistent with existing memory tool fallback behavior
