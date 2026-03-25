/**
 * Atomic fact decomposition for memory-neo4j.
 *
 * Uses an LLM to break multi-fact memory text into independent,
 * self-contained atomic facts for finer-grained storage and retrieval.
 */

import type { ExtractionConfig } from "./config.js";
import { sanitizeMemoryText, stripCodeFences } from "./extractor.js";
import { callLlmStream } from "./llm-client.js";

// System instruction — user message contains the multi-fact memory text
const DECOMPOSITION_SYSTEM = `You are a memory decomposition system. Break the following text into a list of independent, atomic facts. Each fact should be self-contained and independently useful without needing the others for context.

Return JSON: { "facts": ["fact 1", "fact 2", ...] }

Rules:
- Each fact must be a complete, standalone sentence
- Preserve all specifics (names, numbers, dates, preferences)
- If the text contains only one fact, return it as a single-element array
- Minimum 2 facts to bother decomposing; if only 1 meaningful fact exists, return it alone
- Do NOT add commentary, interpretation, or inferred facts not in the original
- Do NOT split a single compound statement into trivially related fragments`;

/**
 * Decompose a multi-fact memory text into a list of independent atomic facts.
 *
 * Returns an array of fact strings (may be length 1), or null on any failure.
 * Callers should only proceed with decomposition when the result has 3+ facts.
 */
export async function decomposeIntoAtomicFacts(
  text: string,
  config: ExtractionConfig,
  abortSignal?: AbortSignal,
): Promise<string[] | null> {
  if (!config.enabled) {
    return null;
  }

  const messages = [
    { role: "system", content: DECOMPOSITION_SYSTEM },
    { role: "user", content: sanitizeMemoryText(text) },
  ];

  let content: string | null;
  try {
    content = await callLlmStream(config, messages, abortSignal);
  } catch (err) {
    // H5: Re-throw AbortError — deliberate cancellation must propagate to callers
    if (err instanceof Error && err.name === "AbortError") throw err;
    return null;
  }

  if (!content) {
    return null;
  }

  try {
    const parsed = JSON.parse(stripCodeFences(content)) as { facts?: unknown };
    const raw = Array.isArray(parsed.facts) ? parsed.facts : [];
    const MAX_DECOMPOSED_FACTS = 20;
    const facts = raw
      .filter((f: unknown): f is string => typeof f === "string")
      .map((f) => f.trim())
      .filter((f) => f.length > 0);
    if (facts.length > MAX_DECOMPOSED_FACTS) {
      if (typeof globalThis.console?.debug === "function") {
        globalThis.console.debug(
          `memory-neo4j: decomposition produced ${facts.length} facts, capping at ${MAX_DECOMPOSED_FACTS}`,
        );
      }
      return facts.slice(0, MAX_DECOMPOSED_FACTS);
    }
    return facts.length > 0 ? facts : null;
  } catch {
    return null;
  }
}
