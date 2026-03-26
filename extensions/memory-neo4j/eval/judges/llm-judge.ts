/**
 * LLM-as-judge wrapper for the eval harness.
 *
 * Uses the same LLM client as extraction (callOpenRouter from llm-client.ts)
 * to run structured evaluation prompts and parse JSON responses.
 *
 * Two judge operations:
 * 1. Context completeness: COMPLETE / PARTIAL / INSUFFICIENT verdict
 * 2. Answer grading: correct / partial / incorrect verdict
 */

import type { ExtractionConfig } from "../../config.js";
import { callOpenRouter } from "../../llm-client.js";
import type { AnswerCorrectness, ContextVerdict } from "../types.js";

export type ContextCompletenessJudgement = {
  verdict: ContextVerdict;
  reasoning: string;
};

export type AnswerGradingJudgement = {
  correctness: AnswerCorrectness;
  reasoning: string;
};

export type GenerateAnswerResult = string;

/**
 * LLM judge that evaluates retrieval quality and answer correctness.
 * Thin wrapper around callOpenRouter with structured prompt templates.
 */
export class LlmJudge {
  constructor(private readonly config: ExtractionConfig) {}

  /**
   * Judge whether retrieved context is sufficient to answer the question.
   *
   * Returns COMPLETE if context contains everything needed, PARTIAL if
   * it contains some relevant info but not enough for a full answer,
   * and INSUFFICIENT if the context cannot support an answer.
   */
  async judgeContextCompleteness(
    question: string,
    retrievedTexts: string[],
    goldenAnswer?: string,
  ): Promise<ContextCompletenessJudgement> {
    const context = retrievedTexts.map((t, i) => `[Memory ${i + 1}] ${t}`).join("\n");

    const referenceBlock = goldenAnswer
      ? `\nReference answer (for evaluator use only — assess whether the context COULD support this answer): ${goldenAnswer}\n`
      : "";

    const prompt = `You are evaluating whether retrieved memory context is sufficient to answer a question.

Question: ${question}
${referenceBlock}
Retrieved Context:
${context}

Evaluate if the retrieved context is sufficient to answer the question.

Respond with valid JSON only (no markdown, no explanation outside JSON):
{"verdict": "COMPLETE" | "PARTIAL" | "INSUFFICIENT", "reasoning": "brief explanation (max 100 words)"}

- COMPLETE: context contains all information needed to answer the question fully
- PARTIAL: context contains some relevant information but not enough for a complete answer
- INSUFFICIENT: context does not contain relevant information to answer the question`;

    const raw = await callOpenRouter(this.config, prompt);

    return parseContextVerdict(raw, question);
  }

  /**
   * Generate an answer using retrieved context.
   */
  async generateAnswer(question: string, retrievedTexts: string[]): Promise<string> {
    const context = retrievedTexts.map((t, i) => `[Memory ${i + 1}] ${t}`).join("\n");

    const prompt = `You are a helpful assistant. Answer the question using ONLY the provided memory context.
If the context does not contain the answer, say "I don't know" and explain what information is missing.

Memory Context:
${context}

Question: ${question}

Answer concisely based only on the context above:`;

    // generateAnswer returns plain text, not JSON — disable json_object
    // response format to avoid Azure/OpenRouter 400 errors.
    const answer = await callOpenRouter(this.config, prompt, undefined, { jsonMode: false });
    return answer ?? "I don't know. Answer generation failed.";
  }

  /**
   * Grade a generated answer against the golden answer.
   */
  async gradeAnswer(
    question: string,
    goldenAnswer: string,
    generatedAnswer: string,
  ): Promise<AnswerGradingJudgement> {
    const prompt = `You are grading an AI assistant's answer against a reference answer.

Question: ${question}

Reference Answer: ${goldenAnswer}

Generated Answer: ${generatedAnswer}

Grade the generated answer. Focus on factual accuracy and completeness.

Respond with valid JSON only (no markdown):
{"correctness": "correct" | "partial" | "incorrect", "reasoning": "brief explanation (max 100 words)"}

- correct: generated answer contains all key facts from the reference answer
- partial: generated answer contains some correct facts but misses key details
- incorrect: generated answer is wrong, contradicts the reference, or says "I don't know" when the answer was available`;

    const raw = await callOpenRouter(this.config, prompt);

    return parseGradingVerdict(raw, question);
  }
}

// ── JSON parsing helpers ──────────────────────────────────────────────────────

function parseContextVerdict(raw: string | null, question: string): ContextCompletenessJudgement {
  if (!raw) {
    return {
      verdict: "INSUFFICIENT",
      reasoning: "LLM returned empty response",
    };
  }

  try {
    const json = extractJson(raw);
    const parsed = JSON.parse(json) as { verdict?: string; reasoning?: string };
    const verdict = normalizeVerdict(parsed.verdict);
    return {
      verdict,
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "No reasoning provided",
    };
  } catch {
    // Fallback: try to detect verdict keyword in raw text
    // Check PARTIAL before COMPLETE so "PARTIALLY COMPLETE" doesn't false-positive as COMPLETE
    const upper = raw.toUpperCase();
    const verdict: ContextVerdict = upper.includes("PARTIAL")
      ? "PARTIAL"
      : upper.includes("COMPLETE")
        ? "COMPLETE"
        : "INSUFFICIENT";
    return { verdict, reasoning: `Parsed from raw text (JSON parse failed for: ${question})` };
  }
}

function parseGradingVerdict(raw: string | null, question: string): AnswerGradingJudgement {
  if (!raw) {
    return {
      correctness: "incorrect",
      reasoning: "LLM returned empty response",
    };
  }

  try {
    const json = extractJson(raw);
    const parsed = JSON.parse(json) as { correctness?: string; reasoning?: string };
    const correctness = normalizeCorrectness(parsed.correctness);
    return {
      correctness,
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "No reasoning provided",
    };
  } catch {
    const lower = raw.toLowerCase();
    const correctness: AnswerCorrectness = lower.includes("correct")
      ? lower.includes("incorrect")
        ? "incorrect"
        : "correct"
      : lower.includes("partial")
        ? "partial"
        : "incorrect";
    return { correctness, reasoning: `Parsed from raw text (JSON parse failed for: ${question})` };
  }
}

/** Extract first JSON object from a string that may contain markdown code fences.
 *  Uses brace-depth matching to find the correct closing brace, avoiding
 *  over-capture when the text contains trailing `{…}` blocks. */
export function extractJson(text: string): string {
  // Strip markdown code fences
  const stripped = text.replace(/```(?:json)?\s*/gi, "").replace(/```\s*/g, "");
  const start = stripped.indexOf("{");
  if (start === -1) return stripped.trim();

  // Walk forward tracking brace depth + string context to find matching close
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < stripped.length; i++) {
    const ch = stripped[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return stripped.slice(start, i + 1);
      }
    }
  }

  // Unbalanced braces — fall back to original slice
  const end = stripped.lastIndexOf("}");
  if (end > start) return stripped.slice(start, end + 1);
  return stripped.trim();
}

export function normalizeVerdict(raw: unknown): ContextVerdict {
  const s = String(raw ?? "")
    .toUpperCase()
    .trim();
  if (s === "COMPLETE") return "COMPLETE";
  if (s === "PARTIAL") return "PARTIAL";
  return "INSUFFICIENT";
}

export function normalizeCorrectness(raw: unknown): AnswerCorrectness {
  const s = String(raw ?? "")
    .toLowerCase()
    .trim();
  if (s === "correct") return "correct";
  if (s === "partial") return "partial";
  return "incorrect";
}
