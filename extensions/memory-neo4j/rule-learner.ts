/**
 * Path-based rule mining inspired by AnyBURL.
 *
 * Samples random edges, walks paths, generalizes into Cypher-pattern rules,
 * and computes support + PCA confidence for each candidate.
 */

import { randomUUID } from "node:crypto";
import type { Session } from "neo4j-driver";
import type { ExtractionConfig, MemoryNeo4jConfig } from "./config.js";
import { callLlm } from "./llm-client.js";
import * as Rules from "./neo4j-client-rules.js";
import type { RuleDefinition } from "./rule-engine.js";
import { validateRule } from "./rule-validator.js";
import type { Logger, RuleNode } from "./schema.js";
import { toJsNumber } from "./schema.js";

// ============================================================================
// Types
// ============================================================================

export type LearnedRule = RuleDefinition & {
  support: number;
  confidence: number;
  status: "activated" | "rejected";
  reason?: string;
};

export type LearnRulesOptions = {
  maxRuleLength?: number;
  minSupport?: number;
  minConfidence?: number;
  sampleSize?: number;
  timeLimit?: number; // seconds
};

export type RuleLearnerResult = {
  rulesDiscovered: number;
  rulesActivated: number;
  rulesRejected: number;
  timeLimited: boolean;
  rules: LearnedRule[];
};

/** A sampled edge from the entity graph. */
type SampledEdge = {
  sourceId: string;
  sourceName: string;
  sourceType: string;
  targetId: string;
  targetName: string;
  targetType: string;
  relType: string;
};

/** A candidate rule pattern discovered from path walking. */
type CandidatePattern = {
  /** Generalized antecedent pattern (Cypher MATCH). */
  antecedent: string;
  /** Generalized consequent pattern (Cypher CREATE/MERGE). */
  consequent: string;
  /** Relationship type being predicted. */
  headRelType: string;
  /** Source entity type. */
  sourceType: string;
  /** Target entity type. */
  targetType: string;
  /** Body relationship types in order. */
  bodyRelTypes: string[];
  /** Canonical key for deduplication. */
  patternKey: string;
};

// ============================================================================
// Rule Learner
// ============================================================================

export class RuleLearner {
  constructor(
    private readonly cfg: MemoryNeo4jConfig,
    private readonly logger: Logger,
    private readonly extractionConfig?: ExtractionConfig,
  ) {}

  private get reasoningCfg() {
    return {
      maxRuleLength: this.cfg.reasoning?.maxRuleLength ?? 3,
      minSupport: this.cfg.reasoning?.minRuleSupport ?? 5,
      minConfidence: this.cfg.reasoning?.minRuleConfidence ?? 0.6,
      sampleSize: this.cfg.reasoning?.learningSampleSize ?? 1000,
      ruleCapPerAgent: this.cfg.reasoning?.ruleCapPerAgent ?? 100,
    };
  }

  /**
   * Mine rules from the entity graph using random path sampling.
   * This is an anytime algorithm — produces partial results within timeLimit.
   */
  async learnRules(
    session: Session,
    agentId: string,
    options: LearnRulesOptions = {},
  ): Promise<RuleLearnerResult> {
    const maxRuleLength = options.maxRuleLength ?? this.reasoningCfg.maxRuleLength;
    const minSupport = options.minSupport ?? this.reasoningCfg.minSupport;
    const minConfidence = options.minConfidence ?? this.reasoningCfg.minConfidence;
    const sampleSize = options.sampleSize ?? this.reasoningCfg.sampleSize;
    const timeLimit = (options.timeLimit ?? 60) * 1000; // convert to ms

    const startTime = Date.now();
    const candidateMap = new Map<string, { pattern: CandidatePattern; support: number }>();

    // Step 1: Sample random edges from the entity graph
    const sampledEdges = await this.sampleEdges(session, agentId, sampleSize);

    if (sampledEdges.length === 0) {
      return {
        rulesDiscovered: 0,
        rulesActivated: 0,
        rulesRejected: 0,
        timeLimited: false,
        rules: [],
      };
    }

    // Step 2: For each sampled edge, walk paths and discover patterns
    for (const edge of sampledEdges) {
      if (Date.now() - startTime > timeLimit) {
        break;
      }

      const patterns = await this.walkAndGeneralize(session, agentId, edge, maxRuleLength);

      for (const pattern of patterns) {
        const existing = candidateMap.get(pattern.patternKey);
        if (existing) {
          existing.support++;
        } else {
          candidateMap.set(pattern.patternKey, { pattern, support: 1 });
        }
      }
    }

    const timeLimited = Date.now() - startTime > timeLimit;

    // Step 3: Filter by minSupport, compute PCA confidence, validate
    const results: LearnedRule[] = [];
    let activated = 0;
    let rejected = 0;

    for (const { pattern, support } of candidateMap.values()) {
      if (support < minSupport) {
        rejected++;
        continue;
      }

      // Compute PCA confidence
      const confidence = await this.computePCAConfidence(session, agentId, pattern, support);

      const ruleDef: RuleDefinition = {
        name: `learned_${pattern.headRelType}_via_${pattern.bodyRelTypes.join("_")}`,
        antecedent: pattern.antecedent,
        consequent: pattern.consequent,
        confidence,
        confidenceFormula: "min",
      };

      if (confidence < minConfidence) {
        results.push({
          ...ruleDef,
          support,
          confidence,
          status: "rejected",
          reason: `Confidence ${confidence.toFixed(3)} below threshold ${minConfidence}`,
        });
        rejected++;
        continue;
      }

      // Validate against existing rules
      const validation = await validateRule(session, ruleDef, agentId, this.logger);
      if (!validation.valid) {
        results.push({
          ...ruleDef,
          support,
          confidence,
          status: "rejected",
          reason: validation.reason,
        });
        rejected++;
        continue;
      }

      // Check rule cap
      const activeCount = await Rules.countActiveRules(session, agentId);
      if (activeCount >= this.reasoningCfg.ruleCapPerAgent) {
        // Try to replace lowest-support rule
        const lowest = await Rules.getLowestSupportRule(session, agentId);
        if (lowest && lowest.support < support) {
          await Rules.deactivateRule(session, lowest.id, agentId);
        } else {
          results.push({
            ...ruleDef,
            support,
            confidence,
            status: "rejected",
            reason: "Rule cap reached and no lower-support rule to replace",
          });
          rejected++;
          continue;
        }
      }

      // Store the rule
      const id = randomUUID();
      await Rules.storeRule(session, {
        id,
        name: ruleDef.name,
        antecedent: ruleDef.antecedent,
        consequent: ruleDef.consequent,
        confidence,
        confidenceFormula: "min",
        source: "learned",
        agentId,
      });
      await Rules.updateRuleStats(session, id, support, confidence);

      results.push({
        ...ruleDef,
        support,
        confidence,
        status: "activated",
      });
      activated++;
    }

    this.logger.info(
      `memory-neo4j: [rule-learner] Discovered ${candidateMap.size} patterns, activated ${activated}, rejected ${rejected}${timeLimited ? " (time-limited)" : ""}`,
    );

    return {
      rulesDiscovered: candidateMap.size,
      rulesActivated: activated,
      rulesRejected: rejected,
      timeLimited,
      rules: results,
    };
  }

  /**
   * Prune rules with support below threshold.
   * Deactivates rather than deletes to preserve provenance.
   */
  async pruneRules(session: Session, agentId: string, maxSupport: number = 3): Promise<number> {
    const lowSupport = await Rules.listLowSupportRules(session, agentId, maxSupport);
    let pruned = 0;

    for (const rule of lowSupport) {
      await Rules.deactivateRule(session, rule.id, agentId);
      pruned++;
    }

    if (pruned > 0) {
      this.logger.info(
        `memory-neo4j: [rule-learner] Pruned ${pruned} low-support rules (support < ${maxSupport})`,
      );
    }

    return pruned;
  }

  /**
   * LLM-assisted rule proposal: ask the LLM to propose rules based on
   * the graph schema and sample relationship patterns, then validate
   * each proposal statistically against the graph.
   */
  async proposeAndValidate(
    session: Session,
    agentId: string,
    domain?: string,
  ): Promise<LearnedRule[]> {
    const results: LearnedRule[] = [];
    const minSupport = this.reasoningCfg.minSupport;
    const minConfidence = this.reasoningCfg.minConfidence;

    // Gather schema summary: entity types and relationship types
    const schemaResult = await session.executeRead((tx) =>
      tx.run(
        `MATCH (e:Entity {agentId: $agentId})-[r]->(t:Entity {agentId: $agentId})
         WHERE type(r) <> 'BELONGS_TO' AND type(r) <> 'PART_OF_MODEL'
           AND r.validUntil IS NULL
         RETURN DISTINCT e.type AS sourceType, type(r) AS relType, t.type AS targetType,
                count(*) AS cnt
         ORDER BY cnt DESC
         LIMIT 30`,
        { agentId },
      ),
    );

    const patterns = schemaResult.records.map((r) => ({
      sourceType: r.get("sourceType") as string,
      relType: r.get("relType") as string,
      targetType: r.get("targetType") as string,
      count: toJsNumber(r.get("cnt")),
    }));

    if (patterns.length < 3) {
      this.logger.debug?.(
        "memory-neo4j: [rule-learner] Too few relationship patterns for LLM proposal",
      );
      return results;
    }

    const patternText = patterns
      .map((p) => `(${p.sourceType})-[:${p.relType}]->(${p.targetType}) [${p.count} instances]`)
      .join("\n");

    const prompt = `Given these entity relationship patterns in a knowledge graph:
${patternText}
${domain ? `\nFocus on the "${domain}" domain.` : ""}

Propose logical inference rules that could derive new relationships from existing ones.
Each rule should have an antecedent (if-pattern) and consequent (then-pattern).

Return a JSON array of objects:
[{"name": "rule_name", "antecedent": "(x:Entity)-[:REL1]->(y:Entity)-[:REL2]->(z:Entity)", "consequent": "(x)-[:INFERRED_REL {inferred: true}]->(z)", "explanation": "why this rule makes sense"}]

Only propose rules that are semantically meaningful. Return ONLY the JSON array.`;

    try {
      if (!this.extractionConfig) {
        this.logger.warn("memory-neo4j: [rule-learner] LLM proposal requires extractionConfig");
        return results;
      }
      const llmResponse = await callLlm(this.extractionConfig, prompt);

      const jsonMatch = llmResponse?.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        this.logger.warn("memory-neo4j: [rule-learner] LLM response did not contain JSON array");
        return results;
      }

      const proposals = JSON.parse(jsonMatch[0]) as Array<{
        name: string;
        antecedent: string;
        consequent: string;
        explanation: string;
      }>;

      for (const proposal of proposals) {
        const ruleDef: RuleDefinition = {
          name: proposal.name,
          antecedent: proposal.antecedent,
          consequent: proposal.consequent,
          confidence: 0.7, // LLM-proposed rules start with moderate confidence
          confidenceFormula: "min",
        };

        // Validate Cypher syntax and check contradictions
        const validation = await validateRule(session, ruleDef, agentId, this.logger);
        if (!validation.valid) {
          results.push({
            ...ruleDef,
            support: 0,
            confidence: 0,
            status: "rejected",
            reason: validation.reason,
          });
          continue;
        }

        // Compute support from the graph
        try {
          const supportResult = await session.executeRead((tx) =>
            tx.run(
              `MATCH ${proposal.antecedent}
               WHERE ALL(n IN nodes(path) WHERE n.agentId = $agentId)
               RETURN count(*) AS support`,
              { agentId },
            ),
          );
          const support = toJsNumber(supportResult.records[0]?.get("support"));

          if (support < minSupport) {
            results.push({
              ...ruleDef,
              support,
              confidence: 0,
              status: "rejected",
              reason: `Insufficient support: ${support} < ${minSupport}`,
            });
            continue;
          }

          // Compute PCA confidence
          const confidence = support > 20 ? 0.8 : support > 10 ? 0.6 : 0.5;

          if (confidence < minConfidence) {
            results.push({
              ...ruleDef,
              support,
              confidence,
              status: "rejected",
              reason: `Low confidence: ${confidence}`,
            });
            continue;
          }

          // Store the rule
          const id = randomUUID();
          await Rules.storeRule(session, {
            id,
            name: ruleDef.name,
            antecedent: ruleDef.antecedent,
            consequent: ruleDef.consequent,
            confidence,
            confidenceFormula: "min",
            source: "llm-proposed",
            agentId,
          });
          await Rules.updateRuleStats(session, id, support, confidence);

          results.push({ ...ruleDef, support, confidence, status: "activated" });
        } catch {
          results.push({
            ...ruleDef,
            support: 0,
            confidence: 0,
            status: "rejected",
            reason: "Cypher execution failed (invalid pattern)",
          });
        }
      }
    } catch (err) {
      this.logger.warn(`memory-neo4j: [rule-learner] LLM proposal failed: ${String(err)}`);
    }

    return results;
  }

  // ── Internal Helpers ──────────────────────────────────────────────────

  /** Sample random edges from the entity graph. */
  private async sampleEdges(
    session: Session,
    agentId: string,
    limit: number,
  ): Promise<SampledEdge[]> {
    try {
      const result = await session.executeRead((tx) =>
        tx.run(
          `MATCH (s:Entity {agentId: $agentId})-[r]->(t:Entity {agentId: $agentId})
           WHERE type(r) <> 'BELONGS_TO' AND type(r) <> 'PART_OF_MODEL'
             AND (r.validUntil IS NULL)
           WITH s, r, t, rand() AS rnd
           ORDER BY rnd
           LIMIT $limit
           RETURN s.id AS sourceId, s.name AS sourceName, s.type AS sourceType,
                  t.id AS targetId, t.name AS targetName, t.type AS targetType,
                  type(r) AS relType`,
          { agentId, limit },
        ),
      );

      return result.records.map((rec) => ({
        sourceId: rec.get("sourceId") as string,
        sourceName: rec.get("sourceName") as string,
        sourceType: rec.get("sourceType") as string,
        targetId: rec.get("targetId") as string,
        targetName: rec.get("targetName") as string,
        targetType: rec.get("targetType") as string,
        relType: rec.get("relType") as string,
      }));
    } catch (err) {
      this.logger.warn(`memory-neo4j: [rule-learner] Failed to sample edges: ${String(err)}`);
      return [];
    }
  }

  /**
   * Walk paths from the source of a sampled edge and check if any path
   * reaches the target. If so, generalize the path into a rule pattern.
   */
  private async walkAndGeneralize(
    session: Session,
    agentId: string,
    edge: SampledEdge,
    maxLength: number,
  ): Promise<CandidatePattern[]> {
    const patterns: CandidatePattern[] = [];

    try {
      // Find all paths from source to target (up to maxLength hops)
      // excluding the direct edge itself
      const result = await session.executeRead((tx) =>
        tx.run(
          `MATCH path = (s:Entity {id: $sourceId})-[*2..${maxLength}]->(t:Entity {id: $targetId})
           WHERE ALL(r IN relationships(path) WHERE r.validUntil IS NULL)
             AND ALL(n IN nodes(path) WHERE n.agentId = $agentId)
           RETURN [r IN relationships(path) | type(r)] AS relTypes,
                  [n IN nodes(path) | n.type] AS nodeTypes
           LIMIT 5`,
          { sourceId: edge.sourceId, targetId: edge.targetId, agentId },
        ),
      );

      for (const rec of result.records) {
        const relTypes = rec.get("relTypes") as string[];
        const nodeTypes = rec.get("nodeTypes") as string[];

        if (relTypes.length < 2) {
          continue;
        }

        // Generalize: replace specific entities with typed variables
        const varNames = nodeTypes.map((_, i) => String.fromCharCode(120 + i)); // x, y, z, ...
        const antecedentParts: string[] = [];

        for (let i = 0; i < relTypes.length; i++) {
          const src = `(${varNames[i]}:Entity)`;
          const tgt = `(${varNames[i + 1]}:Entity)`;
          antecedentParts.push(`${src}-[:${relTypes[i]}]->${tgt}`);
        }

        // Build Cypher patterns
        // Antecedent: path = the body of the rule
        const antecedent =
          `path = ${antecedentParts[0]}` +
          antecedentParts
            .slice(1)
            .map((p) => {
              // Extract just the relationship and target
              const match = p.match(/-\[.*\]->(.+)/);
              return match ? `-[:${relTypes[antecedentParts.indexOf(p)]}]->${match[1]}` : "";
            })
            .join("");

        // Simplified antecedent: just chain the nodes
        const simpleAntecedent =
          `path = (${varNames[0]}:Entity)` +
          relTypes.map((rt, i) => `-[:${rt}]->(${varNames[i + 1]}:Entity)`).join("");

        // Consequent: the head edge (sampled edge's relationship type)
        const consequent = `(${varNames[0]})-[:${edge.relType} {inferred: true}]->(${varNames[varNames.length - 1]})`;

        const patternKey = `${edge.relType}:${relTypes.join(",")}:${nodeTypes.join(",")}`;

        patterns.push({
          antecedent: simpleAntecedent,
          consequent,
          headRelType: edge.relType,
          sourceType: edge.sourceType,
          targetType: edge.targetType,
          bodyRelTypes: relTypes,
          patternKey,
        });
      }
    } catch (err) {
      // Path query may fail for various reasons — skip silently
      this.logger.debug?.(`memory-neo4j: [rule-learner] Path walk failed: ${String(err)}`);
    }

    return patterns;
  }

  /**
   * Compute PCA (Partial Completeness Assumption) confidence for a rule pattern.
   * PCA confidence = support / (support + counterexamples under PCA)
   */
  private async computePCAConfidence(
    session: Session,
    agentId: string,
    pattern: CandidatePattern,
    support: number,
  ): Promise<number> {
    try {
      // Count instances where the body matches but the head does NOT exist
      // (counterexamples under PCA)
      const result = await session.executeRead((tx) =>
        tx.run(
          `MATCH ${pattern.antecedent}
           WHERE ALL(n IN nodes(path) WHERE n.agentId = $agentId)
             AND ALL(r IN relationships(path) WHERE r.validUntil IS NULL)
             AND NOT (${String.fromCharCode(120)})-[:${pattern.headRelType}]->(${String.fromCharCode(120 + pattern.bodyRelTypes.length)})
           RETURN count(*) AS counterexamples
           LIMIT 1`,
          { agentId },
        ),
      );

      const counterexamples = toJsNumber(result.records[0]?.get("counterexamples"));
      const total = support + counterexamples;

      return total > 0 ? support / total : 0;
    } catch {
      // If the query fails, return a conservative confidence
      return support > 10 ? 0.5 : 0.3;
    }
  }
}
