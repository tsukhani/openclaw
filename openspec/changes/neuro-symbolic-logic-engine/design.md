## Context

The memory-neo4j plugin implements CARA (Cognitive Architecture for Reflective Agents) with 7 node types, 10+ relationship types, a 13-phase sleep consolidation cycle, and a hybrid search pipeline combining vector, BM25, graph traversal, MPFP meta-path, and community signals. It already extracts causal edges (`CAUSED_BY`, `LED_TO`, etc.), synthesizes opinions with Bayesian confidence updates, and supports bi-temporal validity.

The knowledge graph stores rich structural information but uses it only for retrieval — there is no formal inference layer. Causal edges are navigational breadcrumbs, not components of a structural causal model. Consistency checking is limited to semantic dedup and temporal supersession; there are no ontological constraints.

This design adds a neuro-symbolic reasoning layer that keeps the LLM as orchestrator while delegating formal reasoning to symbolic engines operating over the Neo4j graph.

**Constraints:**

- Must run in-process (TypeScript + Cypher) — no external reasoning service dependencies
- Must integrate with existing plugin lifecycle (service start/stop, sleep cycle, tool registration)
- Must not break existing memory operations — all new capabilities are additive
- Must respect existing `agentId` scoping, `trustScore`, quarantine, and supersession semantics
- APOC and GDS are already available in the Neo4j deployment

## Goals / Non-Goals

**Goals:**

- Enable the agent to answer "why" and "what if" questions with formal inference chains and provenance
- Enforce ontological constraints that prevent contradictory facts from entering the knowledge graph
- Discover new logical patterns from the entity graph autonomously during sleep consolidation
- Support all three levels of Pearl's causal hierarchy (association, intervention, counterfactual) over explicitly modeled causal structures
- Provide full provenance for every inferred fact (which rule, which grounding memories, confidence at each step)
- Keep sleep cycle overhead under 30% of current duration

**Non-Goals:**

- Full OWL/SWRL reasoning or RDF compatibility (too heavy; n10s available if needed later)
- External reasoner integration (Z3, Clingo, RDFox) in v1 — interface is designed for pluggability but ships with Cypher-native only
- Cross-agent reasoning or shared causal models (per-agent scoping in v1)
- Real-time streaming inference (batch during sleep + on-demand via tools)
- Probabilistic programming or Bayesian network computation (we use confidence scores, not full probability distributions)
- Learning causal structure from statistical data (we learn from graph structure + LLM extraction, not from numerical datasets)

## Decisions

### D1: Rule representation — Cypher-pattern rules

**Decision:** Rules are stored as Cypher MATCH patterns (antecedent) and CREATE/MERGE patterns (consequent).

**Alternatives considered:**

- _Datalog_: More expressive (built-in recursion, stratified negation), but requires a translation layer to Cypher and a separate evaluation engine. Overhead not justified for v1.
- _OWL/SWRL via n10s_: Rich ontological reasoning, but n10s only supports RDFS inference natively — full OWL requires external reasoners, adding a deployment dependency.
- _Custom DSL_: Maximum flexibility, but requires parser/evaluator infrastructure and LLMs would need training to generate it.

**Rationale:** Cypher patterns are directly executable, readable by both developers and LLMs, and integrate with existing Neo4j infrastructure. The expressiveness gap (no negation-as-failure, no recursive aggregation) is addressed by `NOT EXISTS` subqueries in Cypher and fixed-point iteration at the application layer.

**Rule storage schema:**

```
(:Rule {
  id, name, antecedent, consequent, confidenceFormula,
  confidence, source, support, headCoverage,
  active, agentId, validFrom, validUntil, createdAt
})
```

Rules are scoped by `agentId` and support temporal validity (`validFrom`/`validUntil`) so learned rules can be retired without deletion.

### D2: Materialization strategy — hybrid eager/lazy

**Decision:** High-confidence rules materialize during sleep (Phase 15); the `logic_query` tool also evaluates rules at query time for fresh data.

**Alternatives considered:**

- _Eager-only (full materialization)_: Simpler query path, but sleep cycle becomes the bottleneck and stale inferred facts accumulate.
- _Lazy-only (query-time)_: Always fresh, but complex multi-rule chains are too slow for interactive queries (each rule fires a Cypher MATCH).

**Rationale:** Hybrid gives the best of both. Sleep materialization pre-computes stable inferences as `InferredFact` nodes with embeddings, so they participate in regular hybrid search. Query-time evaluation handles facts added since the last sleep cycle, with a depth cap to bound latency.

**InferredFact schema:**

```
(:InferredFact {
  id, text, confidence, ruleId, groundingMemoryIds,
  materialized, embedding, agentId, validFrom, validUntil, createdAt
})
-[:INFERRED_BY]->(:Rule)
-[:GROUNDED_IN]->(:Memory)
```

### D3: Confidence propagation model

**Decision:** Per-rule configurable aggregation (`min`, `product`, `mean`) with depth decay.

For rule `A ∧ B → C`:

```
conf(C) = rule.confidence × aggregation(conf(A), conf(B)) × decay^depth
```

- `decay` default: 0.9 per inference step
- Materialization floor: 0.3 (below this, inferred facts are logged but not stored)
- Quarantined and superseded memories are excluded from grounding

**Rationale:** `min` is conservative (chain as weak as weakest link), `product` assumes independence, `mean` is balanced. Letting rule authors choose per-rule matches the diversity of real inference patterns. Depth decay prevents runaway chains from producing confident results.

### D4: Causal model representation

**Decision:** SCMs stored as a subgraph within Neo4j using dedicated node types.

```
(:CausalModel {id, name, description, agentId, ...})
(:CausalVariable {id, name, type, domain, observedValue, agentId})
(:CausalVariable)-[:CAUSES {coefficient, mechanism, functional_form}]->(:CausalVariable)
(:CausalVariable)-[:PART_OF_MODEL]->(:CausalModel)
```

**Intervention (do-operator):** Implemented via APOC virtual nodes/relationships. The engine creates a virtual copy of the causal subgraph, removes incoming edges to the intervened variable (graph surgery), sets the intervention value, and forward-propagates through remaining edges. No physical graph modification occurs.

**Counterfactual:** Three-step abduction-action-prediction:

1. _Abduction_: Given evidence, infer exogenous variable values using the structural equations
2. _Action_: Apply intervention to the SCM (same graph surgery as Level 2)
3. _Prediction_: Forward-propagate through modified SCM with inferred exogenous values

**Alternative considered:**

- _External causal library (DoWhy/CausalNex via Python subprocess)_: More mature causal inference, but adds a Python runtime dependency and IPC overhead. Deferred to future work if the in-process engine proves insufficient.

### D5: Rule learning approach — path-based mining + LLM validation

**Decision:** AnyBURL-inspired random-walk rule mining combined with LLM-assisted proposal.

**Mining algorithm:**

1. Sample random edges `(s, r, t)` from the entity graph
2. Random walk from `s` (up to 3 hops); if walk reaches `t`, extract candidate rule body
3. Generalize by replacing specific entities with variables
4. Compute support (grounding instance count) and PCA confidence
5. LLM validates top candidates for semantic plausibility
6. Store rules meeting thresholds (`minSupport`, `minConfidence`)

**LLM-assisted proposal:**

1. LLM receives schema summary + sample relationship patterns
2. Proposes candidate rules in structured format
3. Each candidate is statistically validated against the graph
4. Rules meeting thresholds are activated; others are logged

**Rationale:** Path-based mining is fast (anytime algorithm), interpretable, and competitive with neural methods on standard KG benchmarks. LLM validation adds a semantic plausibility check that pure statistical methods miss. The combination catches both structurally supported and semantically meaningful rules.

**Cap:** 100 active rules per agent by default (configurable). Low-support rules are pruned during sleep.

### D6: Consistency checker design

**Decision:** Constraint types are defined as a typed enum, each with a Cypher validation query pattern.

| Constraint Type     | Validation                                                                 |
| ------------------- | -------------------------------------------------------------------------- |
| `uniqueness`        | `MATCH (e:Entity)-[r1:$rel]->(t1), (e)-[r2:$rel]->(t2) WHERE t1 <> t2 ...` |
| `mutual_exclusion`  | `MATCH (e)-[:$rel1]->(), (e)-[:$rel2]->() ...`                             |
| `temporal_ordering` | Compare `validFrom` values on ordered relationships                        |
| `cardinality`       | Count relationships of given type, compare to max                          |
| `type_constraint`   | Verify entity types match expected domain/range                            |

Constraints run at three points:

1. **Capture-time** (inline): Fast check before storing a new memory — only the constraint types relevant to the extracted entities/relationships
2. **Sleep Phase 16** (batch): Full audit of all constraints against all active facts + inferred facts
3. **On-demand**: Via the `logic_query` tool in `check` mode

Violations are flagged with severity (`error` blocks storage, `warning` allows with flag). Batch violations during sleep quarantine the offending memory/inferred fact.

### D7: Tool surface design

**Decision:** Three dedicated tools rather than modes on `memory_recall`.

- `logic_query(query, mode, maxDepth)` — inference, consistency checking, explanation
- `causal_query(query, level, intervention, evidence)` — causal reasoning at all three Pearl levels
- `memory_rules(action, rule, learnOptions)` — rule CRUD and learning triggers

**Rationale:** Separate tools give the LLM clearer intent signals and simpler parameter schemas. The existing `memory_recall` tool is already complex (7 parameters); adding reasoning modes would make it unwieldy. Separate tools also allow independent rate limiting and monitoring.

### D8: Sleep cycle phase ordering

**Decision:** Phases 14-17 run sequentially after Phase 13 (reclassification), in the order: learn → materialize → audit → causal update.

**Rationale:**

- Phase 14 (learn) depends on a stable, deduplicated, extracted entity graph (Phases 1-2, 13)
- Phase 15 (materialize) depends on the latest rule set (Phase 14)
- Phase 16 (audit) checks both stored facts and newly materialized inferred facts (Phase 15)
- Phase 17 (causal update) depends on stable link structure (Phase 10) and audited facts (Phase 16)

Each phase is time-bounded (configurable, default 60s per phase) and skips entirely if no rules/models exist for the agent.

## Risks / Trade-offs

**[Rule explosion]** → Learned rules accumulate and slow materialization. _Mitigation:_ Cap at 100 active rules per agent; prune low-support rules (support < 3) during each sleep cycle; time-bound Phase 15 materialization.

**[Circular inference]** → Rule A infers fact X, which triggers Rule B, which infers fact Y, which triggers Rule A again. _Mitigation:_ Fixed-point loop with `maxIterations` cap (default 10); explicit cycle detection via seen-set of (ruleId, binding) pairs; depth decay makes deep chains low-confidence.

**[Causal model misspecification]** → Wrong causal structure produces misleading interventional/counterfactual answers. _Mitigation:_ Always surface model assumptions in tool output; prefix causal answers with "Given this model..."; allow user review/override via `memory_rules`; confidence scores reflect model uncertainty.

**[LLM-generated rules are nonsensical]** → LLM proposes rules that are syntactically valid but semantically wrong. _Mitigation:_ Statistical validation gate (minSupport=5, minConfidence=0.6) before activation; LLM-proposed rules start with `source: "llm-proposed"` and lower initial confidence.

**[Performance: sleep cycle overhead]** → Four new phases add latency. _Mitigation:_ Each phase is time-bounded (60s default); phases skip when no rules/models exist; rule learning is anytime (produces partial results within time limit).

**[Complexity: debugging inference chains]** → Users and developers struggle to understand why an inferred fact exists. _Mitigation:_ Full provenance on every InferredFact (ruleId, groundingMemoryIds, confidence chain); `logic_query` in `explain` mode returns step-by-step inference trace; inferred facts are visually distinct in search results (`source: "inferred"`).

**[Graph schema migration]** → Existing Neo4j databases need new node labels and indexes. _Mitigation:_ Migration is additive (new labels/indexes only, no modifications to existing schema); migration runs automatically on plugin start via existing migration infrastructure in `neo4j-client.ts`.

## Open Questions

1. Should the rule learner run every sleep cycle, or only on a separate (less frequent) schedule?
2. Should InferredFact nodes participate in the existing decay model (Phase 3), or have their own lifecycle tied to rule validity?
3. What is the right UX for surfacing constraint violations to the user — tool response, system message injection, or both?
4. Should causal models be editable via a dedicated CLI command (`openclaw memory neo4j causal ...`), or only via the agent tool?
