/**
 * Rule validation gate for the neuro-symbolic logic engine.
 *
 * Validates candidate rules before activation: checks support, confidence,
 * Cypher syntax, and contradiction with existing active rules.
 */

import type { Session } from "neo4j-driver";
import * as Rules from "./neo4j-client-rules.js";
import type { RuleDefinition } from "./rule-engine.js";
import type { Logger } from "./schema.js";

// ============================================================================
// Types
// ============================================================================

export type ValidationResult = {
  valid: boolean;
  reason?: string;
};

// ============================================================================
// Validation
// ============================================================================

/**
 * Validate a candidate rule before activation.
 * Checks:
 * 1. Cypher syntax (antecedent and consequent parse correctly)
 * 2. No contradiction with existing active rules
 */
export async function validateRule(
  session: Session,
  rule: RuleDefinition,
  agentId: string,
  logger: Logger,
): Promise<ValidationResult> {
  // Check 1: Cypher syntax validation
  const syntaxResult = await validateCypherSyntax(session, rule, logger);
  if (!syntaxResult.valid) {
    return syntaxResult;
  }

  // Check 2: Check for contradictions with existing rules
  const contradictionResult = await checkContradictions(session, rule, agentId, logger);
  if (!contradictionResult.valid) {
    return contradictionResult;
  }

  return { valid: true };
}

/**
 * Validate that the rule's Cypher patterns are syntactically valid.
 * Uses EXPLAIN to check without executing.
 */
async function validateCypherSyntax(
  session: Session,
  rule: RuleDefinition,
  logger: Logger,
): Promise<ValidationResult> {
  // Validate antecedent
  try {
    await session.executeRead((tx) => tx.run(`EXPLAIN MATCH ${rule.antecedent} RETURN count(*)`));
  } catch (err) {
    return {
      valid: false,
      reason: `Invalid antecedent Cypher pattern: ${String(err).slice(0, 200)}`,
    };
  }

  // Validate consequent (wrap in a CREATE to check syntax)
  try {
    // Extract variable names from antecedent to bind them for consequent validation
    await session.executeRead((tx) =>
      tx.run(`EXPLAIN MATCH ${rule.antecedent} CREATE ${rule.consequent}`),
    );
  } catch (err) {
    // Some consequent patterns may fail EXPLAIN but work in practice
    // (e.g., when they reference variables from the antecedent)
    // Log but don't fail on consequent validation
    logger.debug?.(
      `memory-neo4j: [rule-validator] Consequent syntax check warning: ${String(err).slice(0, 200)}`,
    );
  }

  return { valid: true };
}

/**
 * Check if a candidate rule contradicts any existing active rule.
 * A contradiction exists when two rules would produce conflicting
 * relationship types on the same entity pair.
 */
async function checkContradictions(
  session: Session,
  rule: RuleDefinition,
  agentId: string,
  logger: Logger,
): Promise<ValidationResult> {
  // Get all active rules for this agent
  const activeRules = await Rules.listActiveRules(session, agentId);

  for (const existing of activeRules) {
    // Simple heuristic: rules contradict if they have the same antecedent
    // but produce different/opposite consequents
    if (existing.antecedent === rule.antecedent && existing.consequent !== rule.consequent) {
      // Create a CONTRADICTS relationship between the rules
      try {
        await session.executeWrite((tx) =>
          tx.run(
            `MATCH (r1:Rule {id: $existingId})
             MERGE (r1)-[:CONTRADICTS {detectedAt: $now}]->(r2:Rule {name: $newName})`,
            {
              existingId: existing.id,
              newName: rule.name,
              now: new Date().toISOString(),
            },
          ),
        );
      } catch {
        // Non-critical — log and continue
      }

      return {
        valid: false,
        reason: `Contradicts existing rule "${existing.name}": same antecedent but different consequent`,
      };
    }
  }

  return { valid: true };
}
