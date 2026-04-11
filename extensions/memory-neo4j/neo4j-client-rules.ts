/**
 * Cypher template module for Rule and InferredFact CRUD operations.
 */

import type { Session } from "neo4j-driver";
import type { ConfidenceFormula, RuleNode, RuleSource } from "./schema.js";
import { toJsNumber } from "./schema.js";

// ============================================================================
// Input Types
// ============================================================================

export type StoreRuleInput = {
  id: string;
  name: string;
  antecedent: string;
  consequent: string;
  confidence: number;
  confidenceFormula: ConfidenceFormula;
  source: RuleSource;
  agentId: string;
};

export type StoreInferredFactInput = {
  id: string;
  text: string;
  confidence: number;
  ruleId: string;
  groundingMemoryIds: string[];
  embedding?: number[];
  agentId: string;
};

// ============================================================================
// Rule CRUD
// ============================================================================

/** Store or update a rule node. */
export async function storeRule(session: Session, input: StoreRuleInput): Promise<string> {
  const now = new Date().toISOString();
  const result = await session.executeWrite((tx) =>
    tx.run(
      `MERGE (r:Rule {id: $id})
       ON CREATE SET
         r.name = $name, r.antecedent = $antecedent,
         r.consequent = $consequent, r.confidence = $confidence,
         r.confidenceFormula = $confidenceFormula, r.source = $source,
         r.support = 0, r.headCoverage = 0.0,
         r.active = true, r.agentId = $agentId,
         r.validFrom = $now, r.validUntil = null,
         r.createdAt = $now
       ON MATCH SET
         r.name = $name, r.antecedent = $antecedent,
         r.consequent = $consequent, r.confidence = $confidence,
         r.confidenceFormula = $confidenceFormula
       RETURN r.id AS id`,
      {
        id: input.id,
        name: input.name,
        antecedent: input.antecedent,
        consequent: input.consequent,
        confidence: input.confidence,
        confidenceFormula: input.confidenceFormula,
        source: input.source,
        agentId: input.agentId,
        now,
      },
    ),
  );
  return (result.records[0]?.get("id") as string) ?? input.id;
}

/** Deactivate a rule (set active=false, validUntil=now). */
export async function deactivateRule(
  session: Session,
  ruleId: string,
  agentId: string,
): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await session.executeWrite((tx) =>
    tx.run(
      `MATCH (r:Rule {id: $ruleId, agentId: $agentId})
       SET r.active = false, r.validUntil = $now
       RETURN r.id AS id`,
      { ruleId, agentId, now },
    ),
  );
  return result.records.length > 0;
}

/** List all active rules for an agent, sorted by confidence desc. */
export async function listActiveRules(session: Session, agentId: string): Promise<RuleNode[]> {
  const result = await session.executeRead((tx) =>
    tx.run(
      `MATCH (r:Rule {agentId: $agentId, active: true})
       WHERE r.validUntil IS NULL
       RETURN r
       ORDER BY r.confidence DESC`,
      { agentId },
    ),
  );
  return result.records.map((rec) => rec.get("r").properties as RuleNode);
}

/** Count active rules for an agent. */
export async function countActiveRules(session: Session, agentId: string): Promise<number> {
  const result = await session.executeRead((tx) =>
    tx.run(
      `MATCH (r:Rule {agentId: $agentId, active: true})
       WHERE r.validUntil IS NULL
       RETURN count(r) AS cnt`,
      { agentId },
    ),
  );
  return toJsNumber(result.records[0]?.get("cnt"));
}

/** Update support and headCoverage for a rule. */
export async function updateRuleStats(
  session: Session,
  ruleId: string,
  support: number,
  headCoverage: number,
): Promise<void> {
  await session.executeWrite((tx) =>
    tx.run(
      `MATCH (r:Rule {id: $ruleId})
       SET r.support = $support, r.headCoverage = $headCoverage`,
      { ruleId, support, headCoverage },
    ),
  );
}

/** Get rules with support below a threshold (for pruning). */
export async function listLowSupportRules(
  session: Session,
  agentId: string,
  maxSupport: number,
): Promise<RuleNode[]> {
  const result = await session.executeRead((tx) =>
    tx.run(
      `MATCH (r:Rule {agentId: $agentId, active: true})
       WHERE r.support < $maxSupport AND r.validUntil IS NULL
       RETURN r
       ORDER BY r.support ASC`,
      { agentId, maxSupport },
    ),
  );
  return result.records.map((rec) => rec.get("r").properties as RuleNode);
}

/** Get the rule with the lowest support (for cap enforcement). */
export async function getLowestSupportRule(
  session: Session,
  agentId: string,
): Promise<RuleNode | null> {
  const result = await session.executeRead((tx) =>
    tx.run(
      `MATCH (r:Rule {agentId: $agentId, active: true})
       WHERE r.validUntil IS NULL
       RETURN r
       ORDER BY r.support ASC
       LIMIT 1`,
      { agentId },
    ),
  );
  if (result.records.length === 0) {
    return null;
  }
  return result.records[0].get("r").properties as RuleNode;
}

// ============================================================================
// InferredFact CRUD
// ============================================================================

/** Store an inferred fact with INFERRED_BY and GROUNDED_IN relationships. */
export async function storeInferredFact(
  session: Session,
  input: StoreInferredFactInput,
): Promise<string> {
  const now = new Date().toISOString();
  const result = await session.executeWrite((tx) =>
    tx.run(
      `MERGE (f:InferredFact {id: $id})
       ON CREATE SET
         f.text = $text, f.confidence = $confidence,
         f.ruleId = $ruleId, f.groundingMemoryIds = $groundingMemoryIds,
         f.materialized = true, f.embedding = $embedding,
         f.agentId = $agentId, f.validFrom = $now,
         f.validUntil = null, f.createdAt = $now
       ON MATCH SET
         f.confidence = $confidence, f.embedding = $embedding
       WITH f
       MATCH (r:Rule {id: $ruleId})
       MERGE (f)-[:INFERRED_BY]->(r)
       WITH f
       UNWIND $groundingMemoryIds AS memId
       MATCH (m:Memory {id: memId})
       MERGE (f)-[:GROUNDED_IN]->(m)
       RETURN f.id AS id`,
      {
        id: input.id,
        text: input.text,
        confidence: input.confidence,
        ruleId: input.ruleId,
        groundingMemoryIds: input.groundingMemoryIds,
        embedding: input.embedding ?? null,
        agentId: input.agentId,
        now,
      },
    ),
  );
  return (result.records[0]?.get("id") as string) ?? input.id;
}

/** Remove an inferred fact and its relationships. */
export async function deleteInferredFact(
  session: Session,
  factId: string,
  agentId: string,
): Promise<boolean> {
  const result = await session.executeWrite((tx) =>
    tx.run(
      `MATCH (f:InferredFact {id: $factId, agentId: $agentId})
       DETACH DELETE f
       RETURN count(*) AS deleted`,
      { factId, agentId },
    ),
  );
  return toJsNumber(result.records[0]?.get("deleted")) > 0;
}

/** Find inferred facts grounded in a specific memory. */
export async function findFactsGroundedIn(
  session: Session,
  memoryId: string,
): Promise<
  Array<{ id: string; confidence: number; ruleId: string; groundingMemoryIds: string[] }>
> {
  const result = await session.executeRead((tx) =>
    tx.run(
      `MATCH (f:InferredFact)-[:GROUNDED_IN]->(m:Memory {id: $memoryId})
       RETURN f.id AS id, f.confidence AS confidence,
              f.ruleId AS ruleId, f.groundingMemoryIds AS groundingMemoryIds`,
      { memoryId },
    ),
  );
  return result.records.map((rec) => ({
    id: rec.get("id") as string,
    confidence: rec.get("confidence") as number,
    ruleId: rec.get("ruleId") as string,
    groundingMemoryIds: rec.get("groundingMemoryIds") as string[],
  }));
}

/** List all inferred facts for an agent. */
export async function listInferredFacts(
  session: Session,
  agentId: string,
  limit: number = 100,
): Promise<Array<{ id: string; text: string; confidence: number; ruleId: string }>> {
  const result = await session.executeRead((tx) =>
    tx.run(
      `MATCH (f:InferredFact {agentId: $agentId})
       WHERE f.validUntil IS NULL
       RETURN f.id AS id, f.text AS text, f.confidence AS confidence, f.ruleId AS ruleId
       ORDER BY f.confidence DESC
       LIMIT $limit`,
      { agentId, limit },
    ),
  );
  return result.records.map((rec) => ({
    id: rec.get("id") as string,
    text: rec.get("text") as string,
    confidence: rec.get("confidence") as number,
    ruleId: rec.get("ruleId") as string,
  }));
}

/** Check if a specific inferred fact already exists (by rule + bindings hash). */
export async function inferredFactExists(
  session: Session,
  ruleId: string,
  groundingMemoryIds: string[],
  agentId: string,
): Promise<boolean> {
  // Sort for canonical comparison
  const sorted = [...groundingMemoryIds].toSorted();
  const result = await session.executeRead((tx) =>
    tx.run(
      `MATCH (f:InferredFact {ruleId: $ruleId, agentId: $agentId})
       WHERE f.validUntil IS NULL AND f.groundingMemoryIds = $sorted
       RETURN count(f) AS cnt`,
      { ruleId, agentId, sorted },
    ),
  );
  return toJsNumber(result.records[0]?.get("cnt")) > 0;
}
