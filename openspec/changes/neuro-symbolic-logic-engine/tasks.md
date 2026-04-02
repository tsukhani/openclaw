## 1. Schema & Infrastructure

- [x] 1.1 Add `Rule`, `InferredFact`, `CausalModel`, `CausalVariable` node type definitions to `extensions/memory-neo4j/schema.ts`
- [x] 1.2 Add `CAUSES`, `PART_OF_MODEL`, `INFERRED_BY`, `GROUNDED_IN`, `CONTRADICTS` relationship type definitions to `extensions/memory-neo4j/schema.ts`
- [x] 1.3 Create Neo4j migration for new indexes (Rule id uniqueness, CausalModel id uniqueness, InferredFact id uniqueness, CausalVariable composite index)
- [x] 1.4 Add new configuration keys to `extensions/memory-neo4j/config.ts` (rule cap, confidence floor, decay factor, phase time limits, minSupport, minConfidence)
- [x] 1.5 Create `extensions/memory-neo4j/neo4j-client-rules.ts` with Cypher templates for Rule and InferredFact CRUD operations
- [x] 1.6 Create `extensions/memory-neo4j/neo4j-client-causal.ts` with Cypher templates for CausalModel and CausalVariable CRUD operations

## 2. Rule Engine

- [x] 2.1 Create `extensions/memory-neo4j/rule-engine.ts` with `RuleEngine` class implementing `addRule`, `evaluateRule`, `materialize`, `retract`
- [x] 2.2 Implement single rule evaluation: execute antecedent Cypher pattern, filter quarantined/superseded, produce bindings
- [x] 2.3 Implement confidence propagation with configurable aggregation (`min`, `product`, `mean`) and depth decay
- [x] 2.4 Implement fixed-point materialization loop with cycle detection (seen-set of ruleId+binding), maxIterations cap, and convergence check
- [x] 2.5 Implement InferredFact creation with embedding generation, `INFERRED_BY` and `GROUNDED_IN` relationships
- [x] 2.6 Implement truth maintenance: retract InferredFacts when grounding memories are deleted/quarantined/superseded
- [x] 2.7 Implement dry-run mode that returns InferredFact previews without writing to the graph
- [x] 2.8 Write tests for rule evaluation, confidence propagation, fixed-point convergence, cycle detection, and retraction

## 3. Consistency Checker

- [x] 3.1 Create `extensions/memory-neo4j/consistency-checker.ts` with constraint type enum and validation logic
- [x] 3.2 Implement uniqueness constraint validation (Cypher query checking duplicate relationships)
- [x] 3.3 Implement mutual exclusion constraint validation
- [x] 3.4 Implement temporal ordering constraint validation (compare `validFrom` values)
- [x] 3.5 Implement cardinality and type constraint validation
- [x] 3.6 Integrate capture-time validation into the memory storage pipeline (check before `storeMemory`)
- [x] 3.7 Implement constraint violation reporting with structured output (type, constraintName, severity, offendingEntityId, conflictingMemoryId, message)
- [x] 3.8 Write tests for each constraint type, capture-time blocking, and violation reporting

## 4. Causal Inference Engine

- [x] 4.1 Create `extensions/memory-neo4j/causal-engine.ts` with `CausalEngine` class implementing `associate`, `intervene`, `counterfactual`, `discoverStructure`
- [x] 4.2 Create `extensions/memory-neo4j/causal-store.ts` with CausalModel and CausalVariable CRUD operations
- [x] 4.3 Implement association queries by delegating to existing hybrid search with causal-edge-aware traversal
- [x] 4.4 Implement intervention queries: virtual graph copy via APOC, graph surgery (remove incoming edges to intervened variable), forward propagation
- [x] 4.5 Implement adjustment set auto-computation using back-door criterion on the causal DAG
- [x] 4.6 Implement counterfactual queries: abduction (infer exogenous values), action (graph surgery), prediction (forward propagation)
- [x] 4.7 Implement causal structure discovery — temporal method (mine precedence patterns from TEMPORAL_NEXT chains)
- [x] 4.8 Implement causal structure discovery — LLM-assisted method (LLM proposes hypotheses, validate against temporal graph)
- [x] 4.9 Implement DAG cycle resolution using temporal ordering
- [x] 4.10 Write tests for intervention graph surgery, counterfactual three-step process, structure discovery, and DAG validation

## 5. Rule Learner

- [x] 5.1 Create `extensions/memory-neo4j/rule-learner.ts` with `RuleLearner` class implementing `learnRules`, `proposeAndValidate`
- [x] 5.2 Implement path-based mining: random edge sampling, random walks, path generalization into Cypher-pattern rules
- [x] 5.3 Implement PCA confidence and support computation for candidate rules
- [x] 5.4 Implement anytime behavior (time-bounded execution, partial results)
- [x] 5.5 Implement candidate rule deduplication (merge identical generalized patterns)
- [x] 5.6 Create `extensions/memory-neo4j/rule-validator.ts` with validation gate (minSupport, minConfidence, contradiction check, Cypher syntax validation)
- [x] 5.7 Implement LLM-assisted rule proposal: schema summary generation, structured proposal parsing, graph-based validation
- [x] 5.8 Implement active rule cap enforcement with lowest-support pruning
- [x] 5.9 Write tests for path mining, rule generalization, validation gate, LLM proposal flow, and cap enforcement

## 6. Agent Tools

- [x] 6.1 Register `logic_query` tool in `extensions/memory-neo4j/plugin-tools.ts` with parameters (query, mode, maxDepth)
- [x] 6.2 Implement `logic_query` infer mode: run rule evaluation at query time, return inference chain with provenance
- [x] 6.3 Implement `logic_query` check mode: delegate to consistency checker, return violations
- [x] 6.4 Implement `logic_query` explain mode: trace existing InferredFact back through rule chain to grounding memories
- [x] 6.5 Register `causal_query` tool in `extensions/memory-neo4j/plugin-tools.ts` with parameters (query, level, intervention, evidence)
- [x] 6.6 Implement `causal_query` routing: association → hybrid search, intervention → causal engine, counterfactual → causal engine
- [x] 6.7 Register `memory_rules` tool in `extensions/memory-neo4j/plugin-tools.ts` with parameters (action, rule, learnOptions)
- [x] 6.8 Implement `memory_rules` actions: list, add, remove, learn, validate
- [x] 6.9 Implement graceful degradation for all three tools (no rules available, Neo4j unreachable, no causal model)
- [x] 6.10 Write tests for each tool mode/action, provenance output, and graceful degradation

## 7. Sleep Cycle Integration

- [x] 7.1 Add Phase 14 (rule learning) to `extensions/memory-neo4j/sleep-cycle.ts` — call `RuleLearner.learnRules` with time bound, skip if <10 entities
- [x] 7.2 Add Phase 15 (rule materialization) to `extensions/memory-neo4j/sleep-cycle.ts` — call `RuleEngine.materialize` for all active rules
- [x] 7.3 Add Phase 16 (consistency audit) to `extensions/memory-neo4j/sleep-cycle.ts` — run batch consistency check, quarantine violations
- [x] 7.4 Add Phase 17 (causal model update) to `extensions/memory-neo4j/sleep-cycle.ts` — incorporate new causal edges, re-validate existing models
- [x] 7.5 Implement rule pruning (deactivate rules with support < 3) as part of Phase 14 cleanup
- [x] 7.6 Add Phase 14-17 metrics to `SleepCycleResult` (rules learned, facts materialized, violations found, models updated)
- [x] 7.7 Write tests for sleep phase ordering, time-bounding, skip conditions, and metric reporting

## 8. Integration & Polish

- [x] 8.1 Ensure InferredFact nodes participate in hybrid search (vector + BM25 signals) with `source: "inferred"` distinction
- [x] 8.2 Integrate provenance from reasoning tools with existing OP-200 search provenance system
- [x] 8.3 Add CLI commands to `extensions/memory-neo4j/cli-commands.ts`: `openclaw memory neo4j rules {list, add, remove, learn}` and `openclaw memory neo4j causal {list, discover}`
- [x] 8.4 Run full test suite (`pnpm test`) and verify no regressions in existing memory operations
- [x] 8.5 Run `pnpm check` and `pnpm build` to verify lint, types, and build output
