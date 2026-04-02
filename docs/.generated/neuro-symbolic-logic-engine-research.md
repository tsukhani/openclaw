# Neuro-Symbolic Logic Engine for OpenClaw Memory

**Research Report — April 2, 2026**
**Purpose:** Inform an OpenSpec proposal for building a causal and logical reasoning layer on top of the `memory-neo4j` plugin.

---

## 1. Executive Summary

The `memory-neo4j` plugin already implements a sophisticated cognitive architecture (CARA) with episodic memory, entity extraction, opinion synthesis, causal relationship edges, temporal reasoning, and multi-signal hybrid search. However, it lacks **formal logical inference**, **structured causal reasoning** (Pearl's do-calculus), **counterfactual analysis**, and **automated rule learning**. A neuro-symbolic logic engine layered on top of the existing graph would close these gaps, enabling the agent to answer "why" and "what if" questions with formal backing rather than LLM guesswork.

The proposed architecture follows the **LLM-as-controller + symbolic tools** pattern — the most practical and proven approach in 2024-2026 — where the LLM orchestrates specialized reasoning tools that operate over the Neo4j knowledge graph.

---

## 2. Current Capabilities (Baseline)

### What memory-neo4j already has

| Capability | Implementation | Location |
|---|---|---|
| **Causal edges** | `CAUSED_BY`, `LED_TO`, `RESULTED_IN`, `ENABLED_BY`, `PREVENTED_BY` extracted by LLM | `extensions/memory-neo4j/extractor*.ts` |
| **Causal chain traversal** | MPFP meta-path: `CAUSED_BY→CAUSED_BY` pattern with decay | `extensions/memory-neo4j/mpfp-search.ts` |
| **Temporal model** | Bi-temporal validity (`validFrom`/`validUntil`), `TEMPORAL_NEXT` edges, point-in-time queries | `extensions/memory-neo4j/schema.ts`, `neo4j-client-search.ts` |
| **Belief/opinion synthesis** | CARA Phase 12 reflection with Bayesian confidence updates, supporting/contradicting evidence | `extensions/memory-neo4j/sleep-phases-reflect.ts` |
| **Conflict detection** | Inline + batch dedup, supersession with `supersededBy` pointers | `extensions/memory-neo4j/sleep-phases-dedup.ts` |
| **Entity graph** | 7 node types, 10+ relationship types, dynamic entity-entity relations with temporal properties | `extensions/memory-neo4j/schema.ts` |
| **Community detection** | Louvain clustering via GDS, LLM-generated community summaries | `extensions/memory-neo4j/sleep-phases-community.ts` |
| **Spreading activation** | N-hop traversal with confidence decay (0.7/hop), 1s timeout | `extensions/memory-neo4j/search.ts` |

### What is missing

| Gap | Impact |
|---|---|
| **Formal logical rules** | No way to define or enforce hard constraints (e.g., "if X works at Y and Y is in Z, then X is located in Z") |
| **Rule materialization** | No forward-chaining engine to derive new facts from existing edges + rules |
| **Causal inference (Pearl L2/L3)** | Cannot compute interventional P(Y\|do(X)) or counterfactual queries; causal edges are navigational only |
| **Counterfactual reasoning** | Cannot answer "what would have happened if X hadn't occurred?" |
| **Automated rule learning** | Cannot discover new logical patterns from the graph autonomously |
| **Consistency checking** | No ontological constraint enforcement (e.g., a person cannot work at two companies simultaneously without an explicit qualifier) |
| **Confidence propagation** | Trust/confidence on individual edges, but no formal propagation through inference chains |

---

## 3. Architecture Proposal

### 3.1 Layered Reasoning Stack

```
┌────────────────────────────────────────────────────────────┐
│  Layer 4: LLM Agent (existing openclaw agent)              │
│  - Intent classification (factual / causal / counterfactual│
│    / rule-based / constraint-check)                        │
│  - NLU, NLG, orchestration                                 │
│  - Soft reasoning (analogies, commonsense)                 │
├────────────────────────────────────────────────────────────┤
│  Layer 3: Causal Inference Engine (NEW)                    │
│  - SCM representation in Neo4j                             │
│  - do-calculus (graph surgery on virtual subgraphs)        │
│  - Counterfactual abduction-action-prediction              │
│  - Causal discovery from temporal patterns                 │
├────────────────────────────────────────────────────────────┤
│  Layer 2: Logic & Rule Engine (NEW)                        │
│  - Forward-chaining rule materialization                   │
│  - Rule learning (AnyBURL-style path generalization)       │
│  - Ontological constraint enforcement                      │
│  - Confidence-weighted inference                           │
├────────────────────────────────────────────────────────────┤
│  Layer 1: Knowledge Graph (existing memory-neo4j)          │
│  - Memory, Entity, Tag, Episode, Community, Observation,   │
│    Opinion nodes                                           │
│  - HNSW vector + BM25 fulltext + graph traversal           │
│  - CARA sleep cycle consolidation                          │
│  - Bi-temporal validity model                              │
├────────────────────────────────────────────────────────────┤
│  Layer 0: Neo4j + GDS + APOC                               │
│  - Property graph storage, Cypher, indexes                 │
│  - Graph algorithms (community, centrality, paths)         │
│  - Virtual nodes/rels for hypothetical reasoning           │
└────────────────────────────────────────────────────────────┘
```

**Key principle:** Hard constraints (Layer 2) override soft reasoning (Layer 4). If the rule engine says an inference is inconsistent, the LLM cannot override it.

### 3.2 New Node and Relationship Types

```
Rule {
  id: UUID
  name: string                    // "employment_implies_location"
  antecedent: string              // Cypher pattern or structured rule body
  consequent: string              // Cypher pattern or structured rule head
  confidence: float               // [0, 1] — learned or specified
  source: "manual" | "learned" | "llm-proposed"
  support: int                    // number of grounding instances in KG
  headCoverage: float             // fraction of consequent instances explained
  active: boolean                 // can be disabled without deletion
  validFrom: datetime
  validUntil: datetime | null
  agentId: string
  createdAt: datetime
}

CausalModel {
  id: UUID
  name: string                    // "project_outcome_model"
  description: string
  variables: string[]             // endogenous variable names
  exogenousVariables: string[]    // background variable names
  agentId: string
  createdAt: datetime
  updatedAt: datetime
}

CausalVariable {
  id: UUID
  name: string
  type: "endogenous" | "exogenous"
  domain: "binary" | "categorical" | "continuous" | "ordinal"
  observedValue: string | null    // last observed
  agentId: string
}

InferredFact {
  id: UUID
  text: string                    // human-readable statement
  confidence: float               // propagated through inference chain
  ruleId: string                  // which rule produced this
  groundingMemoryIds: string[]    // source memories
  materialized: boolean           // written to KG as a Memory node?
  validFrom: datetime
  validUntil: datetime | null
  agentId: string
  createdAt: datetime
}

// New relationship types
CAUSES           CausalVariable → CausalVariable  { coefficient, mechanism, functional_form }
PART_OF_MODEL    CausalVariable → CausalModel      {}
INFERRED_BY      InferredFact → Rule                {}
GROUNDED_IN      InferredFact → Memory              {}
GROUNDED_IN      Rule → Memory                      {} // evidence for learned rules
CONTRADICTS      Rule → Rule                        {} // detected rule conflicts
```

### 3.3 Component Design

#### 3.3.1 Rule Engine (`rule-engine.ts`)

**Forward chaining with confidence propagation:**

```
RuleEngine {
  // Define rules manually or from LLM proposals
  addRule(rule: RuleDefinition): Promise<Rule>

  // Evaluate a single rule against current graph state
  evaluateRule(ruleId: string): Promise<InferredFact[]>

  // Run all active rules to fixed point (with cycle detection)
  materialize(options: {
    maxIterations: number       // default 10
    minConfidence: number       // default 0.5
    dryRun: boolean             // preview without writing
  }): Promise<MaterializationResult>

  // Check a candidate fact against all constraints
  checkConsistency(fact: CandidateFact): Promise<ConsistencyResult>

  // Remove inferred facts when supporting evidence is retracted
  retract(memoryId: string): Promise<RetractResult>
}
```

**Rule format (Cypher-pattern based):**

```typescript
interface RuleDefinition {
  name: string
  // Antecedent: Cypher MATCH pattern
  antecedent: string  // e.g., "(x:Entity)-[:WORKS_AT]->(y:Entity)-[:LOCATED_IN]->(z:Entity)"
  // Consequent: relationship or property to create
  consequent: {
    type: "relationship" | "property" | "node"
    pattern: string   // e.g., "(x)-[:LOCATED_IN {inferred: true}]->(z)"
  }
  constraints?: string[]  // additional WHERE clauses
  confidenceFormula?: "min" | "product" | "mean"  // how to combine edge confidences
}
```

**Why Cypher-pattern rules over Datalog/OWL:**
- Directly executable against Neo4j without translation layer
- Developers and LLMs can read/write them
- Property graph patterns map naturally to the existing schema
- Confidence propagation integrates with existing `trustScore` semantics

**Fixed-point materialization:**

```
repeat:
  for each active rule R:
    match R.antecedent against current graph
    for each binding:
      compute confidence = R.confidenceFormula(edge_confidences) * R.confidence
      if confidence >= threshold AND consequent not already present:
        create InferredFact node
        create consequent edge/property (marked inferred=true)
  until no new facts produced OR maxIterations reached
```

#### 3.3.2 Causal Inference Engine (`causal-engine.ts`)

**Three levels of causal query:**

```
CausalEngine {
  // Level 1: Association — delegates to existing hybrid search
  associate(query: string): Promise<AssociationResult>

  // Level 2: Intervention — graph surgery + adjustment formula
  intervene(options: {
    modelId: string
    intervention: { variable: string, value: string }
    outcome: string
    adjustmentSet?: string[]     // auto-computed if omitted
  }): Promise<InterventionResult>

  // Level 3: Counterfactual — abduction + action + prediction
  counterfactual(options: {
    modelId: string
    evidence: Record<string, string>     // what was observed
    intervention: { variable: string, value: string }  // what we change
    outcome: string                       // what we want to know
  }): Promise<CounterfactualResult>

  // Build/update causal model from memory graph
  discoverStructure(options: {
    entityScope?: string[]      // limit to specific entities/topics
    method: "temporal" | "llm-assisted" | "hybrid"
    minSupport: number
  }): Promise<CausalModel>
}
```

**Intervention implementation using APOC virtual nodes:**

```cypher
// 1. Create virtual copy of causal subgraph
MATCH (v:CausalVariable)-[r:CAUSES]->(w:CausalVariable)
WHERE (v)-[:PART_OF_MODEL]->(:CausalModel {id: $modelId})
WITH collect({from: v, to: w, rel: r}) AS edges
// 2. Delete incoming edges to intervention target (do-operator)
WITH [e IN edges WHERE e.to.name <> $interventionVar] AS kept
// 3. Set intervention value
// 4. Forward-propagate through remaining edges
// 5. Read outcome variable
```

**Causal discovery from temporal patterns:**

The existing `TEMPORAL_NEXT` and `CAUSED_BY` edges provide a foundation. The engine can:
1. Identify temporal precedence patterns (A consistently precedes B)
2. Use the LLM to propose causal hypotheses from memory text
3. Validate hypotheses against the temporal graph (does the proposed cause always precede the effect? Are there confounders?)
4. Store validated causal relationships in a `CausalModel`

#### 3.3.3 Rule Learning (`rule-learner.ts`)

**Approach: Path-based rule mining (inspired by AnyBURL)**

```
RuleLearner {
  // Mine rules from observed graph patterns
  learnRules(options: {
    maxRuleLength: number       // max hops in rule body (default 3)
    minSupport: number          // minimum grounding instances
    minConfidence: number       // minimum PCA confidence
    sampleSize: number          // random walks per iteration
    timeLimit: number           // anytime: stop after N seconds
  }): Promise<LearnedRule[]>

  // LLM-assisted: propose rules from domain knowledge, validate against graph
  proposeAndValidate(domain: string): Promise<ValidatedRule[]>
}
```

**Algorithm sketch:**

```
1. Sample random edges (s, r, t) from entity graph
2. For each sampled edge:
   a. Random walk from s (up to maxRuleLength hops)
   b. If walk reaches t → candidate rule body found
   c. Generalize: replace specific entities with variables
   d. Compute support (how many entity pairs satisfy rule body)
   e. Compute PCA confidence (support / (support + counterexamples))
3. Deduplicate and rank rules
4. LLM validates top candidates for semantic plausibility
5. Store as Rule nodes
```

**LLM-assisted rule proposal:**

```
1. LLM is given a schema summary and sample entity-relationship patterns
2. LLM proposes candidate rules in structured format
3. Each candidate is validated against the graph:
   a. Count supporting instances
   b. Count counterexamples
   c. Check consistency with existing rules
4. Rules meeting thresholds are stored; others are logged for review
```

#### 3.3.4 Consistency Checker (`consistency-checker.ts`)

**Constraint types:**

| Type | Example | Enforcement |
|---|---|---|
| **Uniqueness** | A person has at most one birthdate | Check before storing conflicting memory |
| **Mutual exclusion** | Cannot be both alive and deceased | Block contradictory facts |
| **Temporal ordering** | Birth must precede death | Validate `validFrom` ordering |
| **Cardinality** | A person works at at most N companies simultaneously | Warn or block based on qualifier |
| **Type constraints** | Only persons can work at organizations | Validate entity types in relationships |
| **Domain rules** | User-defined constraints per agent | Configurable |

**Integration point:** Runs during:
- Memory capture (inline check before storage)
- Sleep Phase 1c (batch conflict detection — already exists, extend with formal rules)
- Rule materialization (before writing inferred facts)
- On explicit `checkConsistency` tool call

### 3.4 Agent Tool Interface

Three new tools exposed to the agent:

```typescript
// Tool: logic_query
// Purpose: Answer questions requiring multi-step logical reasoning
{
  name: "logic_query",
  parameters: {
    query: string,           // NL question
    mode: "infer" | "check" | "explain",
    maxDepth: number,        // max inference chain length (default 3)
  },
  returns: {
    answer: string,
    confidence: number,
    inferenceChain: { rule: string, bindings: Record<string, string>, confidence: number }[],
    supportingMemories: string[],
  }
}

// Tool: causal_query
// Purpose: Answer causal/counterfactual questions
{
  name: "causal_query",
  parameters: {
    query: string,           // NL question
    level: "association" | "intervention" | "counterfactual",
    intervention?: { variable: string, value: string },
    evidence?: Record<string, string>,
  },
  returns: {
    answer: string,
    level: string,
    confidence: number,
    causalPath: string[],     // chain of causal variables
    assumptions: string[],    // what the model assumes
  }
}

// Tool: memory_rules
// Purpose: Manage logical rules
{
  name: "memory_rules",
  parameters: {
    action: "list" | "add" | "remove" | "learn" | "validate",
    rule?: RuleDefinition,
    learnOptions?: { domain: string, method: string },
  }
}
```

### 3.5 Sleep Cycle Integration

New phases added to the existing 13-phase sleep consolidation:

| Phase | Name | Depends On | Purpose |
|---|---|---|---|
| **14** | Rule Learning | Phase 2 (extraction complete) | Mine new rules from updated entity graph |
| **15** | Rule Materialization | Phase 14 | Forward-chain all active rules, create InferredFact nodes |
| **16** | Consistency Audit | Phase 15 | Check all inferred + stored facts against constraints, quarantine violations |
| **17** | Causal Model Update | Phase 10 (links complete) | Update causal models from new temporal/causal edges |

Phases 14-17 run in the sequential stage after Phase 13 (reclassification), since they depend on a stable entity graph.

---

## 4. Confidence Propagation Model

Inference chains must propagate uncertainty honestly.

### Chain confidence

For a rule `A ∧ B → C` applied to edges with confidences `conf(A)` and `conf(B)`:

```
conf(C) = rule.confidence × aggregation(conf(A), conf(B))
```

Where `aggregation` is configurable per rule:
- **min**: `min(conf(A), conf(B))` — conservative, chain is as weak as weakest link
- **product**: `conf(A) × conf(B)` — standard probabilistic independence assumption
- **mean**: `(conf(A) + conf(B)) / 2` — balanced

### Decay through chains

Multi-step inference chains apply a depth penalty:

```
final_confidence = chain_confidence × decay^depth
```

Where `decay` is configurable (default 0.9), preventing infinite-depth chains from producing high-confidence results.

### Integration with existing trust model

- `trustScore` on Memory nodes feeds into rule grounding confidence
- Quarantined memories are excluded from rule evaluation
- `supersededBy` pointers ensure only current facts participate in inference
- InferredFact confidence is recomputed when supporting memories are updated/retracted

---

## 5. Causal Discovery Strategy

### Phase 1: LLM-Assisted Extraction (extension of existing extractor)

The existing entity/relationship extractor already recognizes causal patterns (`CAUSED_BY`, `LED_TO`, etc.). Extend it to:

1. Extract **causal direction** explicitly (not just relationship type)
2. Extract **mechanism** descriptions ("X caused Y *because* Z")
3. Assign **causal strength** estimates (strong/moderate/weak → 0.9/0.6/0.3)
4. Detect **temporal precedence** from narrative structure

### Phase 2: Temporal Pattern Mining

Use the existing `TEMPORAL_NEXT` chain to identify:
- **Granger-style precedence**: Entity A's state changes consistently precede Entity B's state changes
- **Repeated sequences**: The same sequence of events occurs multiple times (suggests causal mechanism)
- **Intervention detection**: User explicitly changed something and observed a result ("I tried X and then Y happened")

### Phase 3: SCM Construction

For domains with sufficient causal edges:
1. Aggregate causal relationships into a DAG per topic/domain
2. Resolve cycles (temporal ordering breaks ties)
3. LLM proposes structural equations based on relationship descriptions
4. Store as `CausalModel` + `CausalVariable` + `CAUSES` edges

### Phase 4: Validation

- Cross-check discovered causal structure against temporal data
- LLM reviews proposed models for semantic plausibility
- User can approve/reject/modify via `memory_rules` tool

---

## 6. Implementation Strategy

### Phase A: Rule Engine Foundation

**Scope:** Rule storage, evaluation, materialization, consistency checking.

**Files to create:**
- `extensions/memory-neo4j/rule-engine.ts` — core engine
- `extensions/memory-neo4j/rule-store.ts` — Neo4j CRUD for Rule nodes
- `extensions/memory-neo4j/consistency-checker.ts` — constraint enforcement
- `extensions/memory-neo4j/neo4j-client-rules.ts` — Cypher templates for rule operations

**Integration points:**
- Add `Rule`, `InferredFact` node types to `schema.ts`
- Add `logic_query` and `memory_rules` tools to `plugin-tools.ts`
- Extend sleep cycle in `sleep-cycle.ts` with Phases 14-16

**Estimated complexity:** Medium-high. The rule evaluation loop and fixed-point computation are the core challenges. Cypher-pattern rules keep the implementation grounded in existing Neo4j capabilities.

### Phase B: Causal Inference

**Scope:** Causal model storage, intervention queries, counterfactual queries.

**Files to create:**
- `extensions/memory-neo4j/causal-engine.ts` — inference engine
- `extensions/memory-neo4j/causal-store.ts` — Neo4j CRUD for CausalModel/CausalVariable
- `extensions/memory-neo4j/causal-discovery.ts` — structure learning

**Integration points:**
- Add `CausalModel`, `CausalVariable` node types to `schema.ts`
- Add `causal_query` tool to `plugin-tools.ts`
- Extend sleep cycle with Phase 17
- Extend extractor to capture causal strength and mechanisms

**Estimated complexity:** High. Causal inference (especially counterfactuals) requires careful implementation. APOC virtual nodes for graph surgery are the key enabler.

**Dependency:** Phase A (rules are used for constraint checking within causal models).

### Phase C: Rule Learning

**Scope:** Automated path-based rule mining, LLM-assisted rule proposal.

**Files to create:**
- `extensions/memory-neo4j/rule-learner.ts` — mining algorithm
- `extensions/memory-neo4j/rule-validator.ts` — LLM + statistical validation

**Integration points:**
- Extend `memory_rules` tool with `learn` action
- Add Phase 14 to sleep cycle

**Estimated complexity:** Medium. Path-based mining is well-understood; the LLM validation loop is the novel piece.

**Dependency:** Phase A (rule storage and evaluation infrastructure).

### Phasing Summary

```
Phase A (Rule Engine)  ──→  Phase B (Causal Inference)
         │                          │
         └──→  Phase C (Rule Learning)
                        │
                        └──→  Phase D (integration testing, eval benchmarks)
```

---

## 7. Key Design Decisions

### D1: Cypher-pattern rules vs. Datalog/OWL

**Decision: Cypher-pattern rules.**

- Pro: No translation layer, directly executable, readable by LLMs, property-graph native.
- Con: Less expressive than full Datalog (no negation-as-failure, no recursive aggregation).
- Mitigation: Support stratified negation via explicit `NOT EXISTS` patterns in Cypher. For complex recursive rules, use fixed-point iteration at the application layer.

### D2: In-process vs. external reasoning engine

**Decision: In-process (TypeScript + Cypher).**

- Pro: No external service dependency, simpler deployment, integrates with existing plugin lifecycle.
- Con: Less powerful than dedicated reasoners (RDFox, Clingo, Z3).
- Mitigation: Design the `RuleEngine` interface to allow pluggable backends. Start with Cypher-native; add an optional Z3/ASP backend later if needed.

### D3: Eager materialization vs. lazy query-time inference

**Decision: Hybrid — materialize during sleep, query-time for fresh data.**

- Sleep cycle materializes high-confidence rules (Phase 15), creating `InferredFact` nodes.
- `logic_query` tool can also run rules at query time for data added since last sleep.
- InferredFact nodes participate in regular hybrid search (they have embeddings).

### D4: Causal models per-agent vs. shared

**Decision: Per-agent, with optional sharing.**

- Each agent maintains its own causal models (scoped by `agentId`).
- A future "shared knowledge" feature could merge models across agents.

### D5: Confidence floor for inferred facts

**Decision: Inferred facts below 0.3 confidence are not materialized.**

- They are logged but not stored as InferredFact nodes.
- Prevents low-quality inferences from polluting the knowledge graph.
- Threshold is configurable per agent.

---

## 8. Evaluation Plan

### Benchmarks

| Metric | Measurement | Target |
|---|---|---|
| **Rule precision** | Fraction of inferred facts that are correct (human eval) | > 0.85 |
| **Rule recall** | Fraction of inferable facts that are inferred | > 0.60 |
| **Causal query accuracy** | Correct interventional/counterfactual answers on test set | > 0.70 |
| **Consistency violations** | Number of contradictions introduced by rule materialization | 0 |
| **Latency: logic_query** | p95 response time | < 2s |
| **Latency: causal_query** | p95 response time | < 5s |
| **Sleep cycle overhead** | Additional time from Phases 14-17 | < 30% of current cycle |
| **False positive rate** | Inferred facts that are wrong and surfaced to user | < 5% |

### Test scenarios

1. **Employment chain reasoning**: "X works at Y, Y is in Z → X is in Z"
2. **Temporal constraint validation**: "X was born in 1990, X died in 1985" → flag inconsistency
3. **Causal intervention**: "What would happen if X left company Y?" → trace downstream effects
4. **Counterfactual**: "If X hadn't introduced Y to Z, would Z still work at W?"
5. **Rule learning**: Given 50+ entity relationships, can the system discover "people who work at the same company tend to know each other"?

### Integration with existing eval framework

The `extensions/memory-neo4j/eval/` directory already has benchmarking infrastructure. Extend it with:
- Logic reasoning test datasets
- Causal query test cases
- Rule learning precision/recall metrics

---

## 9. Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **Rule explosion** — too many rules learned, slow materialization | Medium | High | Cap active rules per agent (default 100), prune low-support rules during sleep |
| **Circular inference** — rules produce facts that trigger more rules indefinitely | Medium | High | Cycle detection in fixed-point loop, depth limit, `maxIterations` cap |
| **Causal model misspecification** — wrong causal structure leads to wrong conclusions | High | Medium | Always surface assumptions and confidence; mark causal answers as "given this model"; allow user override |
| **LLM-generated rules are nonsensical** | Medium | Low | Require statistical validation (minSupport, minConfidence) before activation; human review for high-impact rules |
| **Performance degradation** — additional sleep phases slow consolidation | Low | Medium | Phases 14-17 are time-bounded; skip if graph is small; parallelize where possible |
| **Complexity creep** — reasoning system becomes hard to debug | Medium | High | Full provenance on every inferred fact (rule ID, grounding memories, confidence chain); `explain` mode in logic_query tool |

---

## 10. Prior Art and References

### Neuro-symbolic systems
- **Scallop** (Li et al., 2023) — Differentiable Datalog with provenance semirings
- **Logic-LM** (Pan et al., 2023) — LLM → symbolic formulation → solver → LLM
- **LINC** (Olausson et al., 2023) — LLM-generated FOL + theorem prover
- **NeurASP** (Yang et al., 2020) — Neural networks + Answer Set Programming

### Causal reasoning
- **Pearl's Causality** (2009) — SCMs, do-calculus, causal hierarchy
- **DoWhy** (Microsoft) — Python causal inference framework
- **CLadder** (Jin et al., 2024) — LLM causal reasoning benchmark

### Rule learning
- **AnyBURL** (Meilicke et al., 2019) — Fast bottom-up rule learning from KGs
- **AMIE+** (Galárraga et al., 2015) — Rule mining with PCA confidence
- **Neural LP** (Yang et al., 2017) — Differentiable rule learning

### Knowledge graph reasoning
- **GraphRAG** (Microsoft, 2024) — KG-structured retrieval for LLMs
- **RotatE** (Sun et al., 2019) — KG embeddings modeling relation patterns
- **RDFox** — High-performance materialization-based reasoner

### Neo4j ecosystem
- **n10s (neosemantics)** — RDF/OWL import and basic RDFS inference
- **GDS** — Graph algorithms (community, centrality, embeddings, link prediction)
- **APOC** — Virtual nodes/rels for hypothetical reasoning, path expansion

---

## 11. Open Questions for Proposal

1. **Scope for v1:** Should Phase A (rule engine) ship independently, or should we bundle A+C (rules + learning)?
2. **Causal model authoring UX:** Should agents build causal models autonomously, or should this be user-guided (or both)?
3. **Rule language expressiveness:** Is Cypher-pattern sufficient, or do we need Datalog-style negation/aggregation from day one?
4. **External reasoner integration:** Should we plan the interface for optional Z3/ASP backends now, or defer?
5. **Cross-agent reasoning:** Should inferred facts be scoped per-agent or available to all agents on a gateway?
6. **Tool naming:** Are `logic_query`, `causal_query`, `memory_rules` the right surface, or should these be modes of the existing `memory_recall` tool?
