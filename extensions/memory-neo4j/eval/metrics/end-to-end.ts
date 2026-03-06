/**
 * End-to-end evaluation metrics for the eval harness (Tier 2).
 *
 * Generates an answer from retrieved context using the LLM, then
 * grades it against the golden answer via LLM-as-judge.
 */

import type { LlmJudge } from "../judges/llm-judge.js";
import type { AnswerCorrectness, EndToEndResult, MemoryAbility } from "../types.js";

/**
 * Generate an answer using the LLM given retrieved context.
 *
 * Returns null if the LLM call fails or context indicates no answer is possible.
 */
export async function generateAnswer(
  judge: LlmJudge,
  question: string,
  retrievedTexts: string[],
): Promise<string | null> {
  if (retrievedTexts.length === 0) {
    return "I don't know. No relevant memories were found.";
  }

  try {
    return await judge.generateAnswer(question, retrievedTexts);
  } catch (err) {
    return null;
  }
}

/**
 * Grade a generated answer against a golden answer using LLM-as-judge.
 */
export async function gradeAnswer(
  judge: LlmJudge,
  caseId: string,
  ability: MemoryAbility,
  question: string,
  goldenAnswer: string,
  generatedAnswer: string | null,
): Promise<EndToEndResult> {
  if (generatedAnswer === null) {
    return {
      caseId,
      ability,
      question,
      goldenAnswer,
      generatedAnswer: null,
      correctness: "incorrect",
      reasoning: "Answer generation failed",
      judgeSucceeded: false,
    };
  }

  try {
    const result = await judge.gradeAnswer(question, goldenAnswer, generatedAnswer);
    return {
      caseId,
      ability,
      question,
      goldenAnswer,
      generatedAnswer,
      correctness: result.correctness,
      reasoning: result.reasoning,
      judgeSucceeded: true,
    };
  } catch (err) {
    return {
      caseId,
      ability,
      question,
      goldenAnswer,
      generatedAnswer,
      correctness: "incorrect",
      reasoning: `Judge error: ${err instanceof Error ? err.message : String(err)}`,
      judgeSucceeded: false,
    };
  }
}

/**
 * Aggregate end-to-end results.
 */
export function aggregateEndToEnd(results: EndToEndResult[]): {
  total: number;
  correct: number;
  partial: number;
  incorrect: number;
  accuracyRate: number;
} {
  const total = results.length;
  const correct = results.filter((r) => r.correctness === "correct").length;
  const partial = results.filter((r) => r.correctness === "partial").length;
  const incorrect = results.filter((r) => r.correctness === "incorrect").length;

  return {
    total,
    correct,
    partial,
    incorrect,
    accuracyRate: total > 0 ? correct / total : 0,
  };
}

export type { AnswerCorrectness };
