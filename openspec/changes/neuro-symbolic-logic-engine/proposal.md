## Why

The memory-neo4j plugin stores rich entity graphs with causal edges, temporal relationships, and opinion/belief nodes, but treats them as navigational data — it can traverse `CAUSED_BY` chains and synthesize opinions, but cannot perform formal logical inference, compute interventional/counterfactual causal queries, enforce ontological constraints, or discover new logical rules autonomously. When agents encounter "why did X happen?", "what if X hadn't occurred?", or "does this contradict what we know?" questions, they fall back to LLM soft reasoning with no formal grounding. A neuro-symbolic logic engine closes this gap by adding hard reasoning layers that the LLM orchestrates but cannot override.

## What Changes

- **Rule engine**: Forward-chaining rule evaluation over the entity graph using Cypher-pattern rules with confidence propagation and fixed-point materialization. Rules can be manually defined, LLM-proposed, or automatically learned.
- **Consistency checker**: Ontological constraint enforcement (uniqueness, mutual exclusion, temporal ordering, cardinality, type constraints) that runs at memory capture time, during sleep consolidation, and on-demand.
- **Causal inference engine**: Structural Causal Model (SCM) representation in Neo4j, interventional queries via graph surgery (APOC virtual nodes implementing Pearl's do-operator), and counterfactual reasoning via abduction-action-prediction.
- **Rule learner**: Path-based rule mining (AnyBURL-inspired random walks + generalization) combined with LLM-assisted rule proposal and statistical validation against the knowledge graph.
- **New agent tools**: `logic_query` (multi-step inference with provenance), `causal_query` (association/intervention/counterfactual), `memory_rules` (rule CRUD + learning triggers).
- **New sleep cycle phases**: Phase 14 (rule learning), Phase 15 (rule materialization), Phase 16 (consistency audit), Phase 17 (causal model update).
- **New graph schema**: `Rule`, `InferredFact`, `CausalModel`, `CausalVariable` node types; `CAUSES`, `PART_OF_MODEL`, `INFERRED_BY`, `GROUNDED_IN`, `CONTRADICTS` relationship types.

## Capabilities

### New Capabilities

- `rule-engine`: Forward-chaining rule evaluation with Cypher-pattern rules, fixed-point materialization, confidence propagation through inference chains, and truth maintenance (retraction when supporting evidence is removed)
- `consistency-checker`: Ontological constraint definition and enforcement across memory capture, sleep consolidation, and rule materialization — covering uniqueness, mutual exclusion, temporal ordering, cardinality, and type constraints
- `causal-inference`: SCM storage in Neo4j, interventional query computation via graph surgery, counterfactual reasoning via abduction-action-prediction, and causal structure discovery from temporal patterns and LLM-assisted extraction
- `rule-learner`: Automated path-based rule mining from the entity graph, LLM-assisted rule proposal with statistical validation (support, PCA confidence), and integration with the rule engine for storage and activation
- `reasoning-tools`: Three new agent tools (`logic_query`, `causal_query`, `memory_rules`) that expose the rule engine and causal inference engine to the agent with full provenance tracking

### Modified Capabilities

_(No existing specs to modify — this is a net-new reasoning layer.)_

## Impact

- **Code**: New modules in `extensions/memory-neo4j/` — approximately 6-8 new TypeScript files (~2000-3000 LOC). Modifications to `schema.ts` (new node/relationship types), `plugin-tools.ts` (new tools), `sleep-cycle.ts` (new phases), and `config.ts` (new configuration keys).
- **Graph schema**: 4 new node labels, 5 new relationship types, new indexes on Rule and CausalModel nodes. Requires a schema migration for existing Neo4j databases.
- **Sleep cycle**: 4 additional phases extending the existing 13-phase consolidation. Time-bounded to keep overhead under 30% of current cycle duration.
- **Agent behavior**: Agents gain access to formal reasoning tools. The `logic_query` tool surfaces inference chains with per-step confidence. The `causal_query` tool surfaces causal assumptions explicitly. Both integrate with the existing hybrid search provenance system.
- **Dependencies**: No new external dependencies. Uses existing Neo4j driver, APOC procedures, GDS library, and LLM client infrastructure already present in the plugin.
- **Compatibility**: Additive change — existing memory operations are unaffected. New tools are opt-in. Sleep phases are skipped when no rules or causal models exist.
