/**
 * LLM-based reranker — fallback when the local ONNX model is unavailable (OP-130).
 *
 * Batches ALL candidates into a single LLM call (one prompt per rerank invocation).
 * Uses the existing callOpenRouter/callOpenRouterStream infrastructure from llm-client.ts.
 */

import type { ExtractionConfig } from "./config.js";
import { callOpenRouter } from "./llm-client.js";
import type { LocalRerankResult } from "./reranker-local.js";

const SYSTEM_PROMPT = `You are a relevance scoring assistant.
Score each memory's relevance to the query.
Return ONLY a JSON array: [{"index": 0, "score": 0.95}, {"index": 1, "score": 0.1}, ...]
Scores must be numbers between 0 and 1.`;

/**
 * Rerank `documents` against `query` using an LLM call.
 *
 * @param query - The search query.
 * @param documents - Candidate document texts to score.
 * @param config - Extraction/LLM config used for the API call.
 * @param signal - Optional AbortSignal.
 * @returns Results sorted descending by relevanceScore, same interface as localRerank.
 */
export async function llmRerank(
  query: string,
  documents: string[],
  config: ExtractionConfig,
  signal?: AbortSignal,
): Promise<LocalRerankResult[]> {
  if (documents.length === 0) return [];

  const memoriesList = documents
    .map((doc, i) => `[${i}] ${doc.slice(0, 500)}`) // truncate each doc to 500 chars
    .join("\n");

  const userPrompt = `Query: ${query}\n\nMemories:\n${memoriesList}`;

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ];

  const raw = await callOpenRouter(config, messages, signal);

  if (!raw) {
    // Return original order as fallback
    return documents.map((_, i) => ({ index: i, relevanceScore: 0 }));
  }

  // Parse the JSON array — fallback to original order on any parse error
  let parsed: Array<{ index: number; score: number }>;
  try {
    // Strip markdown code fences if present
    const jsonStr = raw
      .replace(/^```(?:json)?\n?/m, "")
      .replace(/\n?```$/m, "")
      .trim();
    const result = JSON.parse(jsonStr) as unknown;
    if (!Array.isArray(result)) throw new Error("Expected array");
    parsed = (result as Array<unknown>).map((item) => {
      const r = item as { index?: unknown; score?: unknown };
      if (typeof r.index !== "number" || typeof r.score !== "number") {
        throw new Error("Invalid item shape");
      }
      return { index: r.index, score: Math.max(0, Math.min(1, r.score)) };
    });
  } catch {
    // Graceful fallback: preserve original ordering with neutral score
    return documents.map((_, i) => ({ index: i, relevanceScore: 0 }));
  }

  // Build indexed results, filling in any missing indices with score 0
  const byIndex = new Map<number, number>(parsed.map((p) => [p.index, p.score]));
  const results: LocalRerankResult[] = documents.map((_, i) => ({
    index: i,
    relevanceScore: byIndex.get(i) ?? 0,
  }));

  // Sort descending by score
  results.sort((a, b) => b.relevanceScore - a.relevanceScore);
  return results;
}
