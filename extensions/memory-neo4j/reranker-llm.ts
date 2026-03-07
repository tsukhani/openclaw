/**
 * LLM-based reranker — fallback and temporal/update query handler (OP-130).
 *
 * For standard queries: scores relevance of each memory to the query.
 * For temporal/update queries: also includes memory timestamps so the LLM
 * can reason about recency and prefer more recently recorded facts.
 *
 * Batches ALL candidates into a single LLM call per rerank invocation.
 * Uses callLlm from llm-client.ts (native routing when in-gateway, direct HTTP otherwise).
 * Can also route to a local Ollama model for zero-cost inference.
 */

import type { ExtractionConfig } from "./config.js";
import { callLlm } from "./llm-client.js";
import type { LocalRerankResult } from "./reranker-local.js";

/** Memory entry with optional metadata passed to the LLM reranker. */
export interface LlmRerankCandidate {
  text: string;
  /** ISO-8601 creation date — included for temporal reasoning. */
  createdAt?: string;
  /** ISO-8601 fact validity start — more semantically meaningful than createdAt for updates. */
  validFrom?: string;
}

const SYSTEM_PROMPT_STANDARD = `You are a relevance scoring assistant.
Score each memory's relevance to the query.
Return ONLY a JSON array: [{"index": 0, "score": 0.95}, {"index": 1, "score": 0.1}, ...]
Scores must be numbers between 0 and 1.`;

const SYSTEM_PROMPT_TEMPORAL = `You are a relevance scoring assistant specialising in temporal knowledge retrieval.
Score each memory's relevance to the query.

IMPORTANT TEMPORAL RULES:
- When the query asks about the CURRENT, LATEST, or MOST RECENT state of something, strongly prefer the memory with the most recent "recorded" date.
- When multiple memories contain similar information but different dates, rank the NEWER memory higher.
- The "recorded" date shown after each memory indicates when that fact was captured.
- A memory recorded later supersedes an earlier one about the same topic.

Return ONLY a JSON array: [{"index": 0, "score": 0.95}, {"index": 1, "score": 0.1}, ...]
Scores must be numbers between 0 and 1.`;

/** Format a date string concisely for the LLM prompt (e.g. "2026-03-06"). */
function formatDate(iso?: string): string {
  if (!iso) return "unknown";
  try {
    return iso.slice(0, 10); // YYYY-MM-DD
  } catch {
    return "unknown";
  }
}

/**
 * Rerank `candidates` against `query` using an LLM call.
 *
 * @param query - The search query.
 * @param candidates - Candidate memories with text and optional timestamps.
 * @param config - Extraction/LLM config used for the API call.
 * @param isTemporal - When true, uses temporal-aware prompt with date context.
 * @param signal - Optional AbortSignal.
 * @returns Results sorted descending by relevanceScore, same interface as localRerank.
 */
export async function llmRerank(
  query: string,
  candidates: LlmRerankCandidate[] | string[],
  config: ExtractionConfig | undefined,
  isTemporal: boolean = false,
  signal?: AbortSignal,
): Promise<LocalRerankResult[]> {
  if (candidates.length === 0) return [];

  if (!config) {
    return candidates.map((_, i) => ({ index: i, relevanceScore: 0 }));
  }

  // Normalise to LlmRerankCandidate[]
  const items: LlmRerankCandidate[] = candidates.map((c) =>
    typeof c === "string" ? { text: c } : c,
  );

  // Build the memory list — include timestamps for temporal queries
  const memoriesList = items
    .map((item, i) => {
      const text = item.text.slice(0, 400);
      if (isTemporal && (item.validFrom ?? item.createdAt)) {
        const date = formatDate(item.validFrom ?? item.createdAt);
        return `[${i}] (recorded: ${date}) ${text}`;
      }
      return `[${i}] ${text}`;
    })
    .join("\n");

  const systemPrompt = isTemporal ? SYSTEM_PROMPT_TEMPORAL : SYSTEM_PROMPT_STANDARD;
  const userPrompt = `Query: ${query}\n\nMemories:\n${memoriesList}`;

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  const raw = await callLlm(config, messages, signal);

  if (!raw) {
    return candidates.map((_, i) => ({ index: i, relevanceScore: 0 }));
  }

  // Parse the JSON array — fallback to original order on any parse error
  let parsed: Array<{ index: number; score: number }>;
  try {
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
    return candidates.map((_, i) => ({ index: i, relevanceScore: 0 }));
  }

  const byIndex = new Map<number, number>(parsed.map((p) => [p.index, p.score]));
  const results: LocalRerankResult[] = candidates.map((_, i) => ({
    index: i,
    relevanceScore: byIndex.get(i) ?? 0,
  }));

  results.sort((a, b) => b.relevanceScore - a.relevanceScore);
  return results;
}
