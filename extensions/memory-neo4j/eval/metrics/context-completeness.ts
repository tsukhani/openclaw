/**
 * Context completeness metric for the eval harness.
 *
 * Uses LLM-as-judge to evaluate whether retrieved memories provide
 * sufficient context to answer the question (Zep methodology).
 *
 * Verdicts:
 * - COMPLETE: retrieved context fully answers the question
 * - PARTIAL: some relevant info retrieved but not enough for a full answer
 * - INSUFFICIENT: retrieved context cannot answer the question
 */

import type { LlmJudge } from "../judges/llm-judge.js";
import type { ContextCompletenessResult, ContextVerdict, MemoryAbility } from "../types.js";

/**
 * Evaluate context completeness for a single test case.
 */
export async function evaluateContextCompleteness(
  judge: LlmJudge,
  caseId: string,
  ability: MemoryAbility,
  question: string,
  retrievedTexts: string[],
): Promise<ContextCompletenessResult> {
  if (retrievedTexts.length === 0) {
    // Abstention cases have gold_memory_ids=[] — returning empty means the system
    // correctly recognised there is no relevant memory to retrieve (OP-131).
    // Treat this as COMPLETE for abstention; INSUFFICIENT for all other abilities.
    const isAbstention = ability === "abstention";
    return {
      caseId,
      ability,
      verdict: isAbstention ? "COMPLETE" : "INSUFFICIENT",
      reasoning: isAbstention
        ? "System correctly abstained — no memories retrieved for a query with no relevant stored facts"
        : "No memories were retrieved",
      judgeSucceeded: true,
    };
  }

  try {
    const result = await judge.judgeContextCompleteness(question, retrievedTexts);
    return {
      caseId,
      ability,
      verdict: result.verdict,
      reasoning: result.reasoning,
      judgeSucceeded: true,
    };
  } catch (err) {
    return {
      caseId,
      ability,
      verdict: "INSUFFICIENT",
      reasoning: `Judge error: ${err instanceof Error ? err.message : String(err)}`,
      judgeSucceeded: false,
    };
  }
}

/**
 * Aggregate context completeness results.
 */
export function aggregateContextCompleteness(results: ContextCompletenessResult[]): {
  total: number;
  complete: number;
  partial: number;
  insufficient: number;
  completenessRate: number;
} {
  const total = results.length;
  const complete = results.filter((r) => r.verdict === "COMPLETE").length;
  const partial = results.filter((r) => r.verdict === "PARTIAL").length;
  const insufficient = results.filter((r) => r.verdict === "INSUFFICIENT").length;

  return {
    total,
    complete,
    partial,
    insufficient,
    completenessRate: total > 0 ? complete / total : 0,
  };
}

export type { ContextVerdict };
