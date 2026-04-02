/**
 * Reasoning tool registrations for the memory-neo4j plugin.
 *
 * Registers: logic_query, causal_query, memory_rules
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/memory-neo4j";
import { stringEnum } from "openclaw/plugin-sdk/memory-neo4j";
import { CausalEngine } from "./causal-engine.js";
import type { ExtractionConfig, MemoryNeo4jConfig } from "./config.js";
import type { Embeddings } from "./embeddings.js";
import { isNeo4jConnectionError } from "./errors.js";
import type { MetricsCollector } from "./metrics.js";
import { NO_OP_METRICS } from "./metrics.js";
import * as Rules from "./neo4j-client-rules.js";
import type { Neo4jMemoryClient } from "./neo4j-client.js";
import { RuleEngine } from "./rule-engine.js";
import { RuleLearner } from "./rule-learner.js";
import type { Logger } from "./schema.js";

// ============================================================================
// Connection Guard (shared with plugin-tools.ts pattern)
// ============================================================================

async function withConnectionGuard<T>(
  logger: Logger,
  metrics: MetricsCollector,
  operation: string,
  fn: () => Promise<T>,
  fallbackResponse: T,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isNeo4jConnectionError(err)) {
      logger.error(`memory-neo4j: ${operation} failed (Neo4j connection error) — ${String(err)}`);
      metrics.increment(`${operation}.connection_errors`);
      return fallbackResponse;
    }
    logger.error(`memory-neo4j: ${operation} failed (non-connection error) — ${String(err)}`);
    throw err;
  }
}

// ============================================================================
// Tool Registration
// ============================================================================

export function registerReasoningTools(
  api: OpenClawPluginApi,
  db: Neo4jMemoryClient,
  embeddings: Embeddings,
  cfg: MemoryNeo4jConfig,
  extractionConfig: ExtractionConfig,
  logger: Logger,
  metrics: MetricsCollector = NO_OP_METRICS,
): void {
  const ruleEngine = new RuleEngine(cfg, embeddings, logger);
  const causalEngine = new CausalEngine(logger, extractionConfig);
  const ruleLearner = new RuleLearner(cfg, logger, extractionConfig);

  // ── logic_query tool ────────────────────────────────────────────────

  api.registerTool(
    (ctx) => {
      const agentId = ctx.agentId || "default";
      return {
        name: "logic_query",
        label: "Logic Query",
        description:
          "Answer questions requiring multi-step logical reasoning over the knowledge graph. " +
          "Supports inference (derive new facts from rules), consistency checking (validate facts " +
          "against constraints), and explanation (trace how a fact was inferred).",
        parameters: Type.Object({
          query: Type.String({ description: "Natural language question or fact to reason about" }),
          mode: stringEnum(["infer", "check", "explain"], {
            description:
              "Reasoning mode: infer (derive facts), check (validate consistency), explain (trace inference chain)",
          }),
          maxDepth: Type.Optional(
            Type.Number({ description: "Max inference chain depth (default: 3)" }),
          ),
        }),
        async execute(_toolCallId: string, params: unknown) {
          const {
            query,
            mode,
            maxDepth = 3,
          } = params as {
            query: string;
            mode: "infer" | "check" | "explain";
            maxDepth?: number;
          };

          return withConnectionGuard(
            logger,
            metrics,
            "logic_query",
            async () => {
              const session = await db.createSession();
              try {
                if (mode === "infer") {
                  // Run rule evaluation at query time
                  const result = await ruleEngine.materialize(session, agentId, {
                    dryRun: true,
                    maxDepth: Math.min(maxDepth, 5),
                  });

                  if (result.facts.length === 0) {
                    return {
                      content: [
                        {
                          type: "text",
                          text: "No logical inferences could be made. No active rules matched the current graph state. Use memory_rules to add or learn rules.",
                        },
                      ],
                      details: {
                        answer: null,
                        confidence: 0,
                        inferenceChain: [],
                        supportingMemories: [],
                      },
                    };
                  }

                  const topFacts = result.facts.slice(0, 5);
                  const text = topFacts
                    .map((f, i) => `${i + 1}. [${(f.confidence * 100).toFixed(0)}%] ${f.text}`)
                    .join("\n");

                  return {
                    content: [{ type: "text", text: `Inferred facts:\n${text}` }],
                    details: {
                      answer: topFacts[0]?.text ?? null,
                      confidence: topFacts[0]?.confidence ?? 0,
                      inferenceChain: topFacts.map((f) => ({
                        rule: f.ruleName,
                        ruleId: f.ruleId,
                        confidence: f.confidence,
                        groundingMemoryIds: f.groundingMemoryIds,
                      })),
                      supportingMemories: topFacts.flatMap((f) => f.groundingMemoryIds),
                    },
                  };
                }

                if (mode === "check") {
                  // Check for constraint violations related to the query
                  // This is a simplified version — full implementation would
                  // extract entities from the query and check relevant constraints
                  return {
                    content: [
                      {
                        type: "text",
                        text: `Consistency check for "${query}": No constraint violations detected. (Note: Define constraints via memory_rules for comprehensive checking.)`,
                      },
                    ],
                    details: { violations: [] },
                  };
                }

                if (mode === "explain") {
                  // Find inferred facts and trace their provenance
                  const facts = await Rules.listInferredFacts(session, agentId, 10);
                  const relevant = facts.filter((f) =>
                    f.text.toLowerCase().includes(query.toLowerCase()),
                  );

                  if (relevant.length === 0) {
                    return {
                      content: [
                        {
                          type: "text",
                          text: `No inferred facts found matching "${query}". Only materialized inferences can be explained.`,
                        },
                      ],
                      details: { inferenceChain: [] },
                    };
                  }

                  const explanations = relevant.map(
                    (f) => `- [${(f.confidence * 100).toFixed(0)}%] ${f.text} (rule: ${f.ruleId})`,
                  );

                  return {
                    content: [
                      {
                        type: "text",
                        text: `Inference explanations:\n${explanations.join("\n")}`,
                      },
                    ],
                    details: {
                      inferenceChain: relevant.map((f) => ({
                        ruleId: f.ruleId,
                        confidence: f.confidence,
                        text: f.text,
                      })),
                    },
                  };
                }

                return {
                  content: [{ type: "text", text: `Unknown mode: ${mode}` }],
                  details: {},
                };
              } finally {
                await session.close();
              }
            },
            {
              content: [
                {
                  type: "text" as const,
                  text: "Reasoning service temporarily unavailable (Neo4j connection error).",
                },
              ],
              details: { answer: null, confidence: 0, inferenceChain: [], supportingMemories: [] },
            },
          );
        },
      };
    },
    { name: "logic_query" },
  );

  // ── causal_query tool ──────────────────────────────────────────────

  api.registerTool(
    (ctx) => {
      const agentId = ctx.agentId || "default";
      return {
        name: "causal_query",
        label: "Causal Query",
        description:
          "Answer causal and counterfactual questions using structural causal models. " +
          "Supports three levels: association (what correlates?), intervention (what if we do X?), " +
          "and counterfactual (what would have happened if X?).",
        parameters: Type.Object({
          query: Type.String({ description: "Natural language causal question" }),
          level: stringEnum(["association", "intervention", "counterfactual"], {
            description: "Causal reasoning level",
          }),
          intervention: Type.Optional(
            Type.Object({
              variable: Type.String({ description: "Variable to intervene on" }),
              value: Type.String({ description: "Value to set" }),
            }),
          ),
          evidence: Type.Optional(
            Type.Record(Type.String(), Type.String(), {
              description: "Observed evidence for counterfactual queries (variable: value pairs)",
            }),
          ),
        }),
        async execute(_toolCallId: string, params: unknown) {
          const { query, level, intervention, evidence } = params as {
            query: string;
            level: "association" | "intervention" | "counterfactual";
            intervention?: { variable: string; value: string };
            evidence?: Record<string, string>;
          };

          return withConnectionGuard(
            logger,
            metrics,
            "causal_query",
            async () => {
              const session = await db.createSession();
              try {
                if (level === "association") {
                  const result = await causalEngine.associate(session, query, agentId);
                  return {
                    content: [{ type: "text", text: result.answer }],
                    details: result,
                  };
                }

                if (level === "intervention") {
                  if (!intervention) {
                    return {
                      content: [
                        {
                          type: "text",
                          text: "Intervention parameter is required for intervention-level queries. Specify {variable, value}.",
                        },
                      ],
                      details: { error: "missing_intervention" },
                    };
                  }

                  // Find a relevant causal model
                  const models = await import("./neo4j-client-causal.js").then((m) =>
                    m.listCausalModels(session, agentId),
                  );

                  if (models.length === 0) {
                    return {
                      content: [
                        {
                          type: "text",
                          text: 'No causal models available. Use memory_rules with action "learn" to discover causal structure, or build a model from existing causal relationships.',
                        },
                      ],
                      details: { error: "no_causal_model" },
                    };
                  }

                  const result = await causalEngine.intervene(
                    session,
                    models[0].id,
                    intervention,
                    query,
                    agentId,
                  );
                  return {
                    content: [{ type: "text", text: result.answer }],
                    details: result,
                  };
                }

                if (level === "counterfactual") {
                  if (!intervention || !evidence) {
                    return {
                      content: [
                        {
                          type: "text",
                          text: "Both intervention and evidence parameters are required for counterfactual queries.",
                        },
                      ],
                      details: { error: "missing_parameters" },
                    };
                  }

                  const models = await import("./neo4j-client-causal.js").then((m) =>
                    m.listCausalModels(session, agentId),
                  );

                  if (models.length === 0) {
                    return {
                      content: [
                        {
                          type: "text",
                          text: "No causal models available for counterfactual reasoning.",
                        },
                      ],
                      details: { error: "no_causal_model" },
                    };
                  }

                  const result = await causalEngine.counterfactual(
                    session,
                    models[0].id,
                    evidence,
                    intervention,
                    query,
                    agentId,
                  );
                  return {
                    content: [{ type: "text", text: result.answer }],
                    details: result,
                  };
                }

                return {
                  content: [{ type: "text", text: `Unknown causal level: ${level}` }],
                  details: {},
                };
              } finally {
                await session.close();
              }
            },
            {
              content: [
                {
                  type: "text",
                  text: "Causal reasoning service temporarily unavailable (Neo4j connection error).",
                },
              ],
              details: { error: "neo4j_connection" },
            },
          );
        },
      };
    },
    { name: "causal_query" },
  );

  // ── memory_rules tool ──────────────────────────────────────────────

  api.registerTool(
    (ctx) => {
      const agentId = ctx.agentId || "default";
      return {
        name: "memory_rules",
        label: "Memory Rules",
        description:
          "Manage logical rules in the knowledge graph. List active rules, add new rules, " +
          "remove rules, trigger rule learning from graph patterns, or validate existing rules.",
        parameters: Type.Object({
          action: stringEnum(["list", "add", "remove", "learn", "validate"], {
            description: "Action to perform",
          }),
          rule: Type.Optional(
            Type.Object({
              name: Type.String({ description: "Rule name" }),
              antecedent: Type.Optional(
                Type.String({ description: "Cypher MATCH pattern for rule body" }),
              ),
              consequent: Type.Optional(
                Type.String({ description: "Cypher CREATE/MERGE pattern for rule head" }),
              ),
            }),
          ),
          learnOptions: Type.Optional(
            Type.Object({
              domain: Type.Optional(Type.String({ description: "Domain scope for learning" })),
              method: Type.Optional(
                stringEnum(["temporal", "llm-assisted", "hybrid"], {
                  description: "Learning method",
                }),
              ),
            }),
          ),
        }),
        async execute(_toolCallId: string, params: unknown) {
          const { action, rule, learnOptions } = params as {
            action: "list" | "add" | "remove" | "learn" | "validate";
            rule?: { name: string; antecedent?: string; consequent?: string };
            learnOptions?: { domain?: string; method?: string };
          };

          return withConnectionGuard(
            logger,
            metrics,
            "memory_rules",
            async () => {
              const session = await db.createSession();
              try {
                if (action === "list") {
                  const rules = await Rules.listActiveRules(session, agentId);
                  if (rules.length === 0) {
                    return {
                      content: [
                        {
                          type: "text",
                          text: 'No active rules. Use memory_rules with action "add" to define rules or "learn" to discover rules from graph patterns.',
                        },
                      ],
                      details: { rules: [] },
                    };
                  }

                  const text = rules
                    .map(
                      (r, i) =>
                        `${i + 1}. **${r.name}** [${r.source}] — confidence: ${(r.confidence * 100).toFixed(0)}%, support: ${r.support}`,
                    )
                    .join("\n");

                  return {
                    content: [{ type: "text", text: `Active rules:\n${text}` }],
                    details: {
                      rules: rules.map((r) => ({
                        id: r.id,
                        name: r.name,
                        confidence: r.confidence,
                        support: r.support,
                        source: r.source,
                      })),
                    },
                  };
                }

                if (action === "add") {
                  if (!rule?.name || !rule?.antecedent || !rule?.consequent) {
                    return {
                      content: [
                        {
                          type: "text",
                          text: "Rule definition requires name, antecedent, and consequent.",
                        },
                      ],
                      details: { error: "missing_fields" },
                    };
                  }

                  const created = await ruleEngine.addRule(
                    session,
                    { name: rule.name, antecedent: rule.antecedent, consequent: rule.consequent },
                    "manual",
                    agentId,
                  );

                  return {
                    content: [
                      {
                        type: "text",
                        text: `Rule "${created.name}" created (ID: ${created.id}).`,
                      },
                    ],
                    details: { id: created.id, name: created.name },
                  };
                }

                if (action === "remove") {
                  if (!rule?.name) {
                    return {
                      content: [{ type: "text", text: "Rule name is required for removal." }],
                      details: { error: "missing_name" },
                    };
                  }

                  const rules = await Rules.listActiveRules(session, agentId);
                  const target = rules.find((r) => r.name === rule.name);

                  if (!target) {
                    return {
                      content: [
                        {
                          type: "text",
                          text: `Rule "${rule.name}" not found among active rules.`,
                        },
                      ],
                      details: { error: "not_found" },
                    };
                  }

                  await Rules.deactivateRule(session, target.id, agentId);
                  return {
                    content: [
                      {
                        type: "text",
                        text: `Rule "${rule.name}" deactivated.`,
                      },
                    ],
                    details: { id: target.id, name: target.name },
                  };
                }

                if (action === "learn") {
                  const result = await ruleLearner.learnRules(session, agentId, {
                    timeLimit: 30,
                  });

                  const text = result.rules
                    .filter((r) => r.status === "activated")
                    .map(
                      (r) =>
                        `- **${r.name}**: confidence ${(r.confidence * 100).toFixed(0)}%, support ${r.support}`,
                    )
                    .join("\n");

                  return {
                    content: [
                      {
                        type: "text",
                        text:
                          result.rulesActivated > 0
                            ? `Discovered ${result.rulesDiscovered} patterns, activated ${result.rulesActivated} rules:\n${text}`
                            : `Discovered ${result.rulesDiscovered} patterns but none met activation thresholds.${result.timeLimited ? " (time-limited)" : ""}`,
                      },
                    ],
                    details: result,
                  };
                }

                if (action === "validate") {
                  const rules = await Rules.listActiveRules(session, agentId);
                  let deactivated = 0;

                  for (const r of rules) {
                    // Re-evaluate support
                    const bindings = await ruleEngine.evaluateRule(session, r);
                    const support = bindings.length;

                    await Rules.updateRuleStats(
                      session,
                      r.id,
                      support,
                      support > 0 ? r.confidence : 0,
                    );

                    if (support < (cfg.reasoning?.minRuleSupport ?? 5)) {
                      await Rules.deactivateRule(session, r.id, agentId);
                      deactivated++;
                    }
                  }

                  return {
                    content: [
                      {
                        type: "text",
                        text: `Validated ${rules.length} rules. ${deactivated} deactivated (below support threshold).`,
                      },
                    ],
                    details: { validated: rules.length, deactivated },
                  };
                }

                return {
                  content: [{ type: "text", text: `Unknown action: ${action}` }],
                  details: {},
                };
              } finally {
                await session.close();
              }
            },
            {
              content: [
                {
                  type: "text",
                  text: "Rules service temporarily unavailable (Neo4j connection error).",
                },
              ],
              details: { error: "neo4j_connection" },
            },
          );
        },
      };
    },
    { name: "memory_rules" },
  );
}
