/**
 * Neuro-symbolic rule engine with forward-chaining materialization,
 * confidence propagation, cycle detection, and truth maintenance.
 */

import { randomUUID } from "node:crypto";
import type { Session } from "neo4j-driver";
import type { MemoryNeo4jConfig } from "./config.js";
import type { Embeddings } from "./embeddings.js";
import * as Rules from "./neo4j-client-rules.js";
import type { ConfidenceFormula, Logger, RuleNode } from "./schema.js";
import { toJsNumber } from "./schema.js";

// ============================================================================
// Types
// ============================================================================

export type RuleDefinition = {
  name: string;
  antecedent: string;
  consequent: string;
  confidence?: number;
  confidenceFormula?: ConfidenceFormula;
  constraints?: string[];
};

export type InferredFactResult = {
  id: string;
  text: string;
  confidence: number;
  ruleId: string;
  ruleName: string;
  groundingMemoryIds: string[];
  depth: number;
};

export type MaterializationResult = {
  factsInferred: number;
  iterations: number;
  converged: boolean;
  facts: InferredFactResult[];
};

export type RetractResult = {
  factsRetracted: number;
  factsRecomputed: number;
};

export type EvaluationBinding = {
  memoryIds: string[];
  memoryTexts: string[];
  confidences: number[];
  /** Stringified binding key for cycle detection. */
  bindingKey: string;
};

// ============================================================================
// Confidence Propagation
// ============================================================================

/** Aggregate edge confidences using the rule's formula. */
export function aggregateConfidence(confidences: number[], formula: ConfidenceFormula): number {
  if (confidences.length === 0) return 1.0;
  switch (formula) {
    case "min":
      return Math.min(...confidences);
    case "product":
      return confidences.reduce((a, b) => a * b, 1.0);
    case "mean":
      return confidences.reduce((a, b) => a + b, 0) / confidences.length;
    default:
      return Math.min(...confidences);
  }
}

/** Compute final confidence with depth decay. */
export function computeChainConfidence(
  ruleConfidence: number,
  edgeConfidences: number[],
  formula: ConfidenceFormula,
  depth: number,
  depthDecay: number,
): number {
  const aggregated = aggregateConfidence(edgeConfidences, formula);
  return ruleConfidence * aggregated * Math.pow(depthDecay, depth);
}

// ============================================================================
// Rule Engine
// ============================================================================

export class RuleEngine {
  constructor(
    private readonly cfg: MemoryNeo4jConfig,
    private readonly embeddings: Embeddings,
    private readonly logger: Logger,
  ) {}

  private get reasoningCfg() {
    return {
      confidenceFloor: this.cfg.reasoning?.confidenceFloor ?? 0.3,
      depthDecay: this.cfg.reasoning?.depthDecay ?? 0.9,
      maxIterations: this.cfg.reasoning?.maxMaterializationIterations ?? 10,
      ruleCapPerAgent: this.cfg.reasoning?.ruleCapPerAgent ?? 100,
    };
  }

  /** Add a new rule to the graph. */
  async addRule(
    session: Session,
    definition: RuleDefinition,
    source: "manual" | "learned" | "llm-proposed",
    agentId: string,
  ): Promise<RuleNode> {
    const id = randomUUID();
    await Rules.storeRule(session, {
      id,
      name: definition.name,
      antecedent: definition.antecedent,
      consequent: definition.consequent,
      confidence: definition.confidence ?? 1.0,
      confidenceFormula: definition.confidenceFormula ?? "min",
      source,
      agentId,
    });
    const rules = await Rules.listActiveRules(session, agentId);
    return rules.find((r) => r.id === id)!;
  }

  /** Evaluate a single rule against the current graph state and return bindings. */
  async evaluateRule(session: Session, rule: RuleNode): Promise<EvaluationBinding[]> {
    // Build a Cypher query from the antecedent pattern.
    // The antecedent is a Cypher MATCH pattern like:
    //   (x:Entity)-[:WORKS_AT]->(y:Entity)-[:LOCATED_IN]->(z:Entity)
    // We wrap it in a MATCH clause with filters for quarantine and validity.
    const query = `
      MATCH ${rule.antecedent}
      WHERE ALL(n IN nodes(path) WHERE
        CASE
          WHEN n:Memory THEN n.agentId = $agentId
            AND n.quarantined <> true
            AND n.validUntil IS NULL
          WHEN n:Entity THEN n.agentId = $agentId
          ELSE true
        END
      )
      WITH *, relationships(path) AS rels
      RETURN
        [n IN nodes(path) WHERE n:Memory | n.id] AS memoryIds,
        [n IN nodes(path) WHERE n:Memory | n.text] AS memoryTexts,
        [r IN rels WHERE r.confidence IS NOT NULL | r.confidence] AS confidences
    `;

    try {
      const result = await session.executeRead((tx) => tx.run(query, { agentId: rule.agentId }));

      return result.records.map((rec) => {
        const memoryIds = (rec.get("memoryIds") as string[]) ?? [];
        const memoryTexts = (rec.get("memoryTexts") as string[]) ?? [];
        const confidences = (rec.get("confidences") as number[]) ?? [];
        const bindingKey = `${rule.id}:${[...memoryIds].sort().join(",")}`;
        return { memoryIds, memoryTexts, confidences, bindingKey };
      });
    } catch (err) {
      // Antecedent pattern may be invalid Cypher — log and skip
      this.logger.warn(
        `memory-neo4j: [rule-engine] Failed to evaluate rule "${rule.name}": ${String(err)}`,
      );
      return [];
    }
  }

  /**
   * Run all active rules to fixed point, materializing inferred facts.
   * Returns the materialization result with all inferred facts.
   */
  async materialize(
    session: Session,
    agentId: string,
    options: { dryRun?: boolean; maxDepth?: number } = {},
  ): Promise<MaterializationResult> {
    const { confidenceFloor, depthDecay, maxIterations } = this.reasoningCfg;
    const dryRun = options.dryRun ?? false;
    const maxDepth = options.maxDepth ?? maxIterations;

    const rules = await Rules.listActiveRules(session, agentId);
    if (rules.length === 0) {
      return { factsInferred: 0, iterations: 0, converged: true, facts: [] };
    }

    const seenBindings = new Set<string>();
    const allFacts: InferredFactResult[] = [];
    let converged = false;

    for (let iteration = 0; iteration < maxDepth; iteration++) {
      let newFactsThisIteration = 0;

      for (const rule of rules) {
        const bindings = await this.evaluateRule(session, rule);

        for (const binding of bindings) {
          // Cycle detection: skip if we've seen this exact (rule, binding) pair
          if (seenBindings.has(binding.bindingKey)) continue;
          seenBindings.add(binding.bindingKey);

          // Check if consequent already exists
          if (binding.memoryIds.length > 0) {
            const exists = await Rules.inferredFactExists(
              session,
              rule.id,
              binding.memoryIds,
              agentId,
            );
            if (exists) continue;
          }

          // Compute confidence
          const confidence = computeChainConfidence(
            rule.confidence,
            binding.confidences,
            rule.confidenceFormula as ConfidenceFormula,
            iteration,
            depthDecay,
          );

          // Skip below confidence floor
          if (confidence < confidenceFloor) {
            this.logger.debug?.(
              `memory-neo4j: [rule-engine] Skipping low-confidence inference (${confidence.toFixed(3)}) from rule "${rule.name}"`,
            );
            continue;
          }

          // Generate human-readable text for the inferred fact
          const text = `Inferred by rule "${rule.name}": Based on ${binding.memoryTexts.map((t) => `"${t.slice(0, 50)}"`).join(", ")}`;

          const fact: InferredFactResult = {
            id: randomUUID(),
            text,
            confidence,
            ruleId: rule.id,
            ruleName: rule.name,
            groundingMemoryIds: binding.memoryIds,
            depth: iteration,
          };

          if (!dryRun) {
            // Generate embedding for the inferred fact
            let embedding: number[] | undefined;
            try {
              embedding = await this.embeddings.embed(text);
            } catch {
              this.logger.warn(
                `memory-neo4j: [rule-engine] Failed to embed inferred fact, storing without embedding`,
              );
            }

            await Rules.storeInferredFact(session, {
              id: fact.id,
              text: fact.text,
              confidence: fact.confidence,
              ruleId: fact.ruleId,
              groundingMemoryIds: fact.groundingMemoryIds,
              embedding,
              agentId,
            });
          }

          allFacts.push(fact);
          newFactsThisIteration++;
        }
      }

      if (newFactsThisIteration === 0) {
        converged = true;
        this.logger.info(
          `memory-neo4j: [rule-engine] Materialization converged at iteration ${iteration + 1}`,
        );
        break;
      }
    }

    if (!converged) {
      this.logger.warn(
        `memory-neo4j: [rule-engine] Materialization hit maxIterations (${maxDepth}) without convergence`,
      );
    }

    return {
      factsInferred: allFacts.length,
      iterations: Math.min(maxDepth, seenBindings.size > 0 ? maxDepth : 1),
      converged,
      facts: allFacts,
    };
  }

  /**
   * Retract inferred facts when a grounding memory is deleted/quarantined/superseded.
   * Recomputes confidence for facts that still have some valid groundings;
   * removes facts with no remaining valid groundings.
   */
  async retract(session: Session, memoryId: string, agentId: string): Promise<RetractResult> {
    const affectedFacts = await Rules.findFactsGroundedIn(session, memoryId);
    let factsRetracted = 0;
    let factsRecomputed = 0;

    for (const fact of affectedFacts) {
      const remainingIds = fact.groundingMemoryIds.filter((id) => id !== memoryId);

      if (remainingIds.length === 0) {
        // No remaining groundings — retract the fact
        await Rules.deleteInferredFact(session, fact.id, agentId);
        factsRetracted++;
      } else {
        // Recompute confidence with remaining groundings
        // For simplicity, reduce confidence proportionally
        const ratio = remainingIds.length / fact.groundingMemoryIds.length;
        const newConfidence = fact.confidence * ratio;

        if (newConfidence < (this.cfg.reasoning?.confidenceFloor ?? 0.3)) {
          await Rules.deleteInferredFact(session, fact.id, agentId);
          factsRetracted++;
        } else {
          // Update the fact with new confidence and groundings
          await session.executeWrite((tx) =>
            tx.run(
              `MATCH (f:InferredFact {id: $factId, agentId: $agentId})
               SET f.confidence = $confidence, f.groundingMemoryIds = $groundingIds`,
              { factId: fact.id, agentId, confidence: newConfidence, groundingIds: remainingIds },
            ),
          );
          factsRecomputed++;
        }
      }
    }

    return { factsRetracted, factsRecomputed };
  }
}
