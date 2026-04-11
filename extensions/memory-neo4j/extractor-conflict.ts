/**
 * Conflict resolution for memory-neo4j.
 *
 * Uses an LLM to determine whether two memories genuinely conflict
 * and which one should be kept, with retry handling for transient failures.
 */

import type { ExtractionConfig } from "./config.js";
import { sanitizeMemoryText, stripCodeFences, withRetry } from "./extractor.js";
import { callLlm, isTransientError } from "./llm-client.js";

/**
 * Use an LLM to determine whether two memories genuinely conflict.
 * Returns which memory to keep, or "both" if they don't actually conflict.
 * Returns "skip" on permanent failure (JSON parse, empty response, disabled config).
 * Returns "transient" on network/timeout errors so the caller can retry later.
 */
export async function resolveConflict(
  memA: string,
  memB: string,
  config: ExtractionConfig,
  abortSignal?: AbortSignal,
): Promise<"a" | "b" | "both" | "skip" | "transient"> {
  if (!config.enabled) {
    return "skip";
  }

  const messages = [
    {
      role: "system",
      content: `Two memories may conflict with each other. Determine which should be kept.

If they genuinely contradict each other, keep the one that is more current, specific, or accurate.
If they don't actually conflict (they cover different aspects or are both valid), keep both.

Return JSON: {"keep": "a"|"b"|"both", "reason": "brief explanation"}`,
    },
    {
      role: "user",
      content: `Memory A: ${JSON.stringify(sanitizeMemoryText(memA))}\nMemory B: ${JSON.stringify(sanitizeMemoryText(memB))}`,
    },
  ];

  try {
    // H4: Two-layer retry design — callLlm has internal retries for transient HTTP errors
    // (429, 502, 503), while withRetry here retries on transient LLM content errors
    // (empty response, timeout). Total worst-case: 3 × 3 = 9 HTTP attempts.
    // Returns null when all attempts exhausted or aborted — store pair for next sleep cycle.
    const content = await withRetry(
      () => callLlm(config, messages, abortSignal),
      3,
      500,
      abortSignal,
    );
    // null = callLlm returned empty content on a successful 200 response — skip this pair
    if (!content) {
      return "skip";
    }

    const parsed = JSON.parse(stripCodeFences(content)) as { keep?: string };
    const keep = parsed.keep;
    if (keep === "a" || keep === "b" || keep === "both") {
      return keep;
    }
    return "skip";
  } catch (err) {
    // withRetry throws on: all retries exhausted (transient) or abort signal fired.
    // Non-transient errors (4xx, content policy, JSON parse) are re-thrown directly.
    if (isTransientError(err)) {
      return "transient";
    }
    return "skip";
  }
}
