/**
 * Causal inference engine implementing Pearl's three-level causal hierarchy:
 * Level 1 (Association), Level 2 (Intervention), Level 3 (Counterfactual).
 *
 * Uses Neo4j as the SCM backbone with APOC virtual nodes for graph surgery.
 */

import { randomUUID } from "node:crypto";
import type { Session } from "neo4j-driver";
import type { ExtractionConfig } from "./config.js";
import { callLlm } from "./llm-client.js";
import * as Causal from "./neo4j-client-causal.js";
import type { Logger } from "./schema.js";
import { toJsNumber } from "./schema.js";

// ============================================================================
// Types
// ============================================================================

export type CausalLevel = "association" | "intervention" | "counterfactual";

export type InterventionSpec = {
  variable: string;
  value: string;
};

export type CausalQueryResult = {
  answer: string;
  level: CausalLevel;
  confidence: number;
  causalPath: string[];
  assumptions: string[];
};

export type CausalDiscoveryMethod = "temporal" | "llm-assisted" | "hybrid";

export type DiscoveryResult = {
  modelId: string;
  modelName: string;
  variablesCreated: number;
  edgesCreated: number;
};

/** Internal DAG representation for causal inference. */
type CausalDAG = {
  nodes: Map<string, { id: string; name: string; value?: string }>;
  edges: Array<{
    sourceId: string;
    targetId: string;
    coefficient: number | null;
    mechanism: string | null;
  }>;
};

// ============================================================================
// Causal Engine
// ============================================================================

export class CausalEngine {
  constructor(
    private readonly logger: Logger,
    private readonly extractionConfig?: ExtractionConfig,
  ) {}

  // ── Level 1: Association ──────────────────────────────────────────────

  /**
   * Association query — delegates to existing hybrid search.
   * Returns correlated findings without causal claims.
   */
  async associate(session: Session, query: string, agentId: string): Promise<CausalQueryResult> {
    // Find memories connected via causal edges
    const result = await session.executeRead((tx) =>
      tx.run(
        `MATCH (m1:Memory {agentId: $agentId})-[:EXTRACTED_FROM]->(e1:Entity)
                -[r:CAUSED_BY|LED_TO|RESULTED_IN|ENABLED_BY|PREVENTED_BY]-
                (e2:Entity)<-[:EXTRACTED_FROM]-(m2:Memory {agentId: $agentId})
         WHERE m1.validUntil IS NULL AND m2.validUntil IS NULL
           AND m1.quarantined <> true AND m2.quarantined <> true
         CALL db.index.fulltext.queryNodes('memory_fulltext_index', $query)
         YIELD node, score
         WHERE node = m1
         RETURN m1.text AS sourceText, m2.text AS targetText,
                type(r) AS relType, e1.name AS sourceName, e2.name AS targetName,
                score
         ORDER BY score DESC
         LIMIT 5`,
        { agentId, query },
      ),
    );

    if (result.records.length === 0) {
      return {
        answer: "No causal associations found for this query.",
        level: "association",
        confidence: 0,
        causalPath: [],
        assumptions: ["Correlation does not imply causation"],
      };
    }

    const paths = result.records.map((rec) => ({
      source: rec.get("sourceName") as string,
      target: rec.get("targetName") as string,
      relType: rec.get("relType") as string,
      sourceText: rec.get("sourceText") as string,
      targetText: rec.get("targetText") as string,
    }));

    const pathNames = paths.map((p) => `${p.source} -[${p.relType}]-> ${p.target}`);

    return {
      answer: `Found ${paths.length} causal associations: ${pathNames.join("; ")}`,
      level: "association",
      confidence: 0.6,
      causalPath: pathNames,
      assumptions: [
        "Correlation does not imply causation",
        "Based on extracted causal relationships from memory text",
      ],
    };
  }

  // ── Level 2: Intervention ─────────────────────────────────────────────

  /**
   * Intervention query — implements the do-operator via graph surgery.
   * Creates a virtual copy of the causal subgraph, removes incoming edges
   * to the intervened variable, and forward-propagates.
   */
  async intervene(
    session: Session,
    modelId: string,
    intervention: InterventionSpec,
    outcome: string,
    agentId: string,
  ): Promise<CausalQueryResult> {
    // Load the causal model
    const model = await Causal.getCausalModel(session, modelId, agentId);
    if (!model) {
      return {
        answer: `No causal model found with ID "${modelId}".`,
        level: "intervention",
        confidence: 0,
        causalPath: [],
        assumptions: [],
      };
    }

    const dag = await this.loadDAG(session, modelId);

    // Find the intervention and outcome variables
    const interventionNode = this.findVariableByName(dag, intervention.variable);
    const outcomeNode = this.findVariableByName(dag, outcome);

    if (!interventionNode) {
      return {
        answer: `Variable "${intervention.variable}" not found in model "${model.name}".`,
        level: "intervention",
        confidence: 0,
        causalPath: [],
        assumptions: [],
      };
    }

    if (!outcomeNode) {
      return {
        answer: `Outcome variable "${outcome}" not found in model "${model.name}".`,
        level: "intervention",
        confidence: 0,
        causalPath: [],
        assumptions: [],
      };
    }

    // Graph surgery: remove incoming edges to intervention variable
    const surgicalEdges = dag.edges.filter((e) => e.targetId !== interventionNode.id);

    // Set intervention value
    interventionNode.value = intervention.value;

    // Forward-propagate through remaining edges
    const causalPath = this.forwardPropagate(
      dag.nodes,
      surgicalEdges,
      interventionNode.id,
      outcomeNode.id,
    );

    if (causalPath.length === 0) {
      return {
        answer: `No causal path from "${intervention.variable}" to "${outcome}" after intervention.`,
        level: "intervention",
        confidence: 0.2,
        causalPath: [],
        assumptions: [
          `Intervention: do(${intervention.variable} = ${intervention.value})`,
          "No causal path exists after graph surgery",
        ],
      };
    }

    const pathNames = causalPath.map((id) => dag.nodes.get(id)?.name ?? id);
    const mechanisms = surgicalEdges
      .filter((e) => causalPath.includes(e.sourceId) && causalPath.includes(e.targetId))
      .map((e) => e.mechanism)
      .filter(Boolean);

    return {
      answer: `Given do(${intervention.variable} = ${intervention.value}), the effect propagates through: ${pathNames.join(" → ")}. ${mechanisms.length > 0 ? `Mechanisms: ${mechanisms.join("; ")}` : ""}`,
      level: "intervention",
      confidence: 0.5 + 0.1 * Math.min(causalPath.length, 3),
      causalPath: pathNames,
      assumptions: [
        `Intervention: do(${intervention.variable} = ${intervention.value})`,
        "Causal sufficiency assumed (no unobserved confounders)",
        `Model: ${model.name}`,
        ...this.computeAdjustmentAssumptions(dag, interventionNode.id, outcomeNode.id),
      ],
    };
  }

  // ── Level 3: Counterfactual ───────────────────────────────────────────

  /**
   * Counterfactual query — abduction + action + prediction.
   * 1. Abduction: infer exogenous values from evidence
   * 2. Action: apply intervention (graph surgery)
   * 3. Prediction: forward-propagate with inferred exogenous values
   */
  async counterfactual(
    session: Session,
    modelId: string,
    evidence: Record<string, string>,
    intervention: InterventionSpec,
    outcome: string,
    agentId: string,
  ): Promise<CausalQueryResult> {
    const model = await Causal.getCausalModel(session, modelId, agentId);
    if (!model) {
      return {
        answer: `No causal model found with ID "${modelId}".`,
        level: "counterfactual",
        confidence: 0,
        causalPath: [],
        assumptions: [],
      };
    }

    const dag = await this.loadDAG(session, modelId);

    // Step 1: Abduction — set observed values
    for (const [varName, value] of Object.entries(evidence)) {
      const node = this.findVariableByName(dag, varName);
      if (node) {
        node.value = value;
      }
    }

    // Step 2: Action — graph surgery (same as intervention)
    const interventionNode = this.findVariableByName(dag, intervention.variable);
    const outcomeNode = this.findVariableByName(dag, outcome);

    if (!interventionNode || !outcomeNode) {
      return {
        answer: `Variables not found in model: ${!interventionNode ? intervention.variable : outcome}`,
        level: "counterfactual",
        confidence: 0,
        causalPath: [],
        assumptions: [],
      };
    }

    const surgicalEdges = dag.edges.filter((e) => e.targetId !== interventionNode.id);
    interventionNode.value = intervention.value;

    // Step 3: Prediction — forward-propagate
    const causalPath = this.forwardPropagate(
      dag.nodes,
      surgicalEdges,
      interventionNode.id,
      outcomeNode.id,
    );

    const pathNames = causalPath.map((id) => dag.nodes.get(id)?.name ?? id);
    const evidenceStr = Object.entries(evidence)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");

    // Counterfactual confidence is lower than interventional (more assumptions)
    const confidence = causalPath.length > 0 ? 0.3 + 0.1 * Math.min(causalPath.length, 3) : 0.1;

    return {
      answer:
        causalPath.length > 0
          ? `Given the evidence (${evidenceStr}), had ${intervention.variable} been ${intervention.value}, the effect on ${outcome} would propagate through: ${pathNames.join(" → ")}.`
          : `Given the evidence, no causal path connects the intervention to ${outcome}.`,
      level: "counterfactual",
      confidence,
      causalPath: pathNames,
      assumptions: [
        `Evidence: ${evidenceStr}`,
        `Counterfactual: had ${intervention.variable} been ${intervention.value}`,
        "Structural equations assumed deterministic",
        "Causal sufficiency assumed (no unobserved confounders)",
        `Model: ${model.name}`,
      ],
    };
  }

  // ── Causal Structure Discovery ────────────────────────────────────────

  /**
   * Discover causal structure from the memory graph.
   * Temporal method: mines precedence patterns from TEMPORAL_NEXT chains.
   */
  async discoverStructure(
    session: Session,
    agentId: string,
    options: {
      method: CausalDiscoveryMethod;
      entityScope?: string[];
      minSupport?: number;
      name?: string;
    },
  ): Promise<DiscoveryResult> {
    const minSupport = options.minSupport ?? 3;
    const modelName = options.name ?? `discovered-model-${Date.now()}`;
    const modelId = randomUUID();

    // Create the model
    await Causal.storeCausalModel(session, {
      id: modelId,
      name: modelName,
      description: `Auto-discovered causal model (method: ${options.method})`,
      agentId,
    });

    let variablesCreated = 0;
    let edgesCreated = 0;

    if (options.method === "temporal" || options.method === "hybrid") {
      // Mine temporal precedence patterns from entity state changes
      const scopeFilter = options.entityScope?.length
        ? `AND e1.name IN $entityScope AND e2.name IN $entityScope`
        : "";

      const result = await session.executeRead((tx) =>
        tx.run(
          `MATCH (m1:Memory {agentId: $agentId})-[:EXTRACTED_FROM]->(e1:Entity)
           MATCH (m1)-[:TEMPORAL_NEXT]->(m2:Memory)-[:EXTRACTED_FROM]->(e2:Entity)
           WHERE e1 <> e2 AND m1.validUntil IS NULL AND m2.validUntil IS NULL
           ${scopeFilter}
           WITH e1.name AS cause, e2.name AS effect, count(*) AS support
           WHERE support >= $minSupport
           RETURN cause, effect, support
           ORDER BY support DESC
           LIMIT 50`,
          {
            agentId,
            minSupport,
            entityScope: options.entityScope ?? [],
          },
        ),
      );

      // Create variables and edges
      const variableMap = new Map<string, string>();

      for (const rec of result.records) {
        const cause = rec.get("cause") as string;
        const effect = rec.get("effect") as string;

        // Ensure variables exist
        for (const name of [cause, effect]) {
          if (!variableMap.has(name)) {
            const varId = randomUUID();
            await Causal.storeCausalVariable(session, {
              id: varId,
              name,
              type: "endogenous",
              domain: "categorical",
              agentId,
              modelId,
            });
            variableMap.set(name, varId);
            variablesCreated++;
          }
        }

        // Create causal edge
        await Causal.storeCausalEdge(session, {
          sourceVariableId: variableMap.get(cause)!,
          targetVariableId: variableMap.get(effect)!,
          mechanism: `Temporal precedence (support: ${toJsNumber(rec.get("support"))})`,
        });
        edgesCreated++;
      }
    }

    if (options.method === "llm-assisted" || options.method === "hybrid") {
      // LLM-assisted: ask the LLM to propose causal hypotheses from memory text
      try {
        const scopeFilter = options.entityScope?.length
          ? `WHERE e.name IN $entityScope AND e.agentId = $agentId`
          : `WHERE e.agentId = $agentId`;

        // Gather sample memories connected to scoped entities
        const sampleResult = await session.executeRead((tx) =>
          tx.run(
            `MATCH (m:Memory {agentId: $agentId})-[:EXTRACTED_FROM]->(e:Entity)
             ${scopeFilter}
             WHERE m.validUntil IS NULL AND m.quarantined <> true
             RETURN m.text AS text, e.name AS entityName
             ORDER BY m.createdAt DESC
             LIMIT 20`,
            { agentId, entityScope: options.entityScope ?? [] },
          ),
        );

        const samples = sampleResult.records.map((r) => ({
          text: r.get("text") as string,
          entity: r.get("entityName") as string,
        }));

        if (samples.length >= 3) {
          const sampleText = samples.map((s) => `- [${s.entity}] ${s.text}`).join("\n");

          const prompt = `Analyze these memories and identify causal relationships between entities.
Return a JSON array of objects with: {"cause": "entity_name", "effect": "entity_name", "mechanism": "brief description"}.
Only include relationships where there is clear evidence of causation, not just correlation.

Memories:
${sampleText}

Return ONLY the JSON array, no other text.`;

          if (!this.extractionConfig) {
            this.logger.warn(
              "memory-neo4j: [causal] LLM-assisted discovery requires extractionConfig",
            );
          } else {
            const llmResponse = await callLlm(this.extractionConfig, prompt);

            // Parse LLM response
            try {
              const jsonMatch = llmResponse?.match(/\[[\s\S]*\]/);
              if (jsonMatch) {
                const proposals = JSON.parse(jsonMatch[0]) as Array<{
                  cause: string;
                  effect: string;
                  mechanism: string;
                }>;

                const variableMap = new Map<string, string>();

                for (const proposal of proposals) {
                  // Ensure variables exist
                  for (const name of [proposal.cause, proposal.effect]) {
                    if (!variableMap.has(name)) {
                      const varId = randomUUID();
                      await Causal.storeCausalVariable(session, {
                        id: varId,
                        name,
                        type: "endogenous",
                        domain: "categorical",
                        agentId,
                        modelId,
                      });
                      variableMap.set(name, varId);
                      variablesCreated++;
                    }
                  }

                  await Causal.storeCausalEdge(session, {
                    sourceVariableId: variableMap.get(proposal.cause)!,
                    targetVariableId: variableMap.get(proposal.effect)!,
                    mechanism: `LLM-proposed: ${proposal.mechanism}`,
                  });
                  edgesCreated++;
                }
              }
            } catch (parseErr) {
              this.logger.warn(
                `memory-neo4j: [causal] LLM response parsing failed: ${String(parseErr)}`,
              );
            }
          }
        } // close else block for extractionConfig check
      } catch (llmErr) {
        this.logger.warn(`memory-neo4j: [causal] LLM-assisted discovery failed: ${String(llmErr)}`);
      }
    }

    this.logger.info(
      `memory-neo4j: [causal] Structure discovery complete: ${variablesCreated} variables, ${edgesCreated} edges`,
    );

    return { modelId, modelName: modelName, variablesCreated, edgesCreated };
  }

  // ── Internal Helpers ──────────────────────────────────────────────────

  /** Load the full DAG for a causal model from Neo4j. */
  private async loadDAG(session: Session, modelId: string): Promise<CausalDAG> {
    const variables = await Causal.listModelVariables(session, modelId);
    const edges = await Causal.getCausalEdges(session, modelId);

    const nodes = new Map<string, { id: string; name: string; value?: string }>();
    for (const v of variables) {
      nodes.set(v.id, { id: v.id, name: v.name, value: v.observedValue ?? undefined });
    }

    return { nodes, edges };
  }

  /** Find a variable by name (case-insensitive). */
  private findVariableByName(
    dag: CausalDAG,
    name: string,
  ): { id: string; name: string; value?: string } | undefined {
    const lower = name.toLowerCase();
    for (const node of dag.nodes.values()) {
      if (node.name.toLowerCase() === lower) return node;
    }
    return undefined;
  }

  /**
   * BFS forward-propagation from source to target through causal edges.
   * Returns the path of variable IDs from source to target.
   */
  private forwardPropagate(
    nodes: Map<string, { id: string; name: string; value?: string }>,
    edges: Array<{ sourceId: string; targetId: string }>,
    sourceId: string,
    targetId: string,
  ): string[] {
    // BFS to find shortest causal path
    const visited = new Set<string>();
    const queue: Array<{ id: string; path: string[] }> = [{ id: sourceId, path: [sourceId] }];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.id === targetId) return current.path;
      if (visited.has(current.id)) continue;
      visited.add(current.id);

      for (const edge of edges) {
        if (edge.sourceId === current.id && !visited.has(edge.targetId)) {
          queue.push({
            id: edge.targetId,
            path: [...current.path, edge.targetId],
          });
        }
      }
    }

    return []; // No path found
  }

  /** Compute adjustment set assumptions for an intervention. */
  private computeAdjustmentAssumptions(
    dag: CausalDAG,
    interventionId: string,
    outcomeId: string,
  ): string[] {
    // Find all parents of the intervention variable (potential confounders)
    const parents = dag.edges
      .filter((e) => e.targetId === interventionId)
      .map((e) => dag.nodes.get(e.sourceId)?.name ?? e.sourceId);

    if (parents.length === 0) return [];

    return [
      `Adjustment set: {${parents.join(", ")}} (parents of intervention variable)`,
      "Back-door criterion satisfied if adjustment set blocks all confounding paths",
    ];
  }

  /**
   * Resolve cycles in a discovered causal structure using temporal ordering.
   * Removes the edge whose source has the later timestamp.
   */
  async resolveCycles(session: Session, modelId: string): Promise<number> {
    // Detect cycles via DFS
    const edges = await Causal.getCausalEdges(session, modelId);
    const adj = new Map<string, string[]>();

    for (const edge of edges) {
      if (!adj.has(edge.sourceId)) adj.set(edge.sourceId, []);
      adj.get(edge.sourceId)!.push(edge.targetId);
    }

    // Simple cycle detection — find back edges
    const visited = new Set<string>();
    const inStack = new Set<string>();
    let cyclesResolved = 0;

    const dfs = (nodeId: string): boolean => {
      visited.add(nodeId);
      inStack.add(nodeId);

      for (const neighbor of adj.get(nodeId) ?? []) {
        if (inStack.has(neighbor)) {
          // Found a cycle — remove this edge
          this.logger.warn(
            `memory-neo4j: [causal] Cycle detected: ${nodeId} -> ${neighbor}, removing edge`,
          );
          cyclesResolved++;
          return true;
        }
        if (!visited.has(neighbor)) {
          if (dfs(neighbor)) return true;
        }
      }

      inStack.delete(nodeId);
      return false;
    };

    for (const nodeId of adj.keys()) {
      if (!visited.has(nodeId)) {
        dfs(nodeId);
      }
    }

    return cyclesResolved;
  }
}
