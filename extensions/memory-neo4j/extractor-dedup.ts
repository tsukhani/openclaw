/**
 * Semantic deduplication and contradiction detection for memory-neo4j.
 *
 * Uses LLM-based comparison to detect whether new text duplicates
 * or contradicts an existing memory, with a vector similarity
 * pre-screen to avoid unnecessary LLM calls.
 */

import type { ExtractionConfig } from "./config.js";
import { sanitizeMemoryText, stripCodeFences } from "./extractor.js";
import { callLlm } from "./llm-client.js";

// System instruction — user message contains the two texts to compare
const SEMANTIC_DEDUP_SYSTEM = `You are a memory deduplication system. Determine whether the new text conveys the SAME factual information as the existing memory.

Rules:
- Return "duplicate" if the new text is conveying the same core fact(s), even if worded differently
- Return "duplicate" if the new text is a subset of information already in the existing memory
- Return "unique" if the new text contains genuinely new information not in the existing memory
- Ignore differences in formatting, pronouns, or phrasing — focus on the underlying facts

Return JSON: {"verdict": "duplicate"|"unique", "reason": "brief explanation"}`;

/**
 * Minimum cosine similarity to proceed with the LLM comparison.
 * Below this threshold, texts are too dissimilar to be semantic duplicates,
 * saving an expensive LLM call. Exported for testing.
 */
export const SEMANTIC_DEDUP_VECTOR_THRESHOLD = 0.8;

/**
 * Check whether new text is semantically a duplicate of an existing memory.
 *
 * When a pre-computed vector similarity score is provided (from findSimilar
 * or findDuplicateClusters), the LLM call is skipped entirely for pairs
 * below SEMANTIC_DEDUP_VECTOR_THRESHOLD — a fast pre-screen that avoids
 * the most expensive part of the pipeline.
 *
 * Returns true if the new text is a duplicate (should be skipped).
 * Returns false on any failure (allow storage).
 */
export async function isSemanticDuplicate(
  newText: string,
  existingText: string,
  config: ExtractionConfig,
  vectorSimilarity?: number,
  abortSignal?: AbortSignal,
): Promise<boolean> {
  if (!config.enabled) {
    return false;
  }

  // Vector pre-screen: skip LLM call when similarity is below threshold
  if (vectorSimilarity !== undefined && vectorSimilarity < SEMANTIC_DEDUP_VECTOR_THRESHOLD) {
    return false;
  }

  try {
    const content = await callLlm(
      config,
      [
        { role: "system", content: SEMANTIC_DEDUP_SYSTEM },
        {
          role: "user",
          content: `Existing memory: ${JSON.stringify(sanitizeMemoryText(existingText))}\nNew text: ${JSON.stringify(sanitizeMemoryText(newText))}`,
        },
      ],
      abortSignal,
    );
    if (!content) {
      return false;
    }

    const parsed = JSON.parse(stripCodeFences(content)) as { verdict?: string };
    return parsed.verdict === "duplicate";
  } catch (err) {
    // H5: Re-throw AbortError — deliberate cancellation must propagate to callers
    if (err instanceof Error && err.name === "AbortError") {
      throw err;
    }
    return false;
  }
}

// System instruction for contradiction detection
const CONTRADICTION_SYSTEM = `You are a memory contradiction detector. Determine whether the new text CONTRADICTS the existing memory (they cannot both be true simultaneously).

Rules:
- Return "contradiction" if the new text directly conflicts with the existing memory (e.g., different values for the same attribute)
- Return "compatible" if both can be true at the same time, even if they discuss the same topic
- Return "compatible" if they discuss different topics entirely
- Focus on factual incompatibility, not just different phrasing

Return JSON: {"verdict": "contradiction"|"compatible", "reason": "brief explanation"}`;

/**
 * Check whether new text contradicts an existing memory.
 *
 * Called in the auto-capture pipeline for candidates in the 0.75-0.95
 * similarity band that are NOT semantic duplicates. This closes the
 * contradiction gap between sleep cycles.
 *
 * Returns true if the texts are contradictory (older should be superseded).
 * Returns false on any failure (allow storage without superseding).
 */
export async function isContradiction(
  newText: string,
  existingText: string,
  config: ExtractionConfig,
  abortSignal?: AbortSignal,
): Promise<boolean> {
  if (!config.enabled) {
    return false;
  }

  try {
    const content = await callLlm(
      config,
      [
        { role: "system", content: CONTRADICTION_SYSTEM },
        {
          role: "user",
          content: `Existing memory: ${JSON.stringify(sanitizeMemoryText(existingText))}\nNew text: ${JSON.stringify(sanitizeMemoryText(newText))}`,
        },
      ],
      abortSignal,
    );
    if (!content) {
      return false;
    }

    const parsed = JSON.parse(stripCodeFences(content)) as { verdict?: string };
    return parsed.verdict === "contradiction";
  } catch (err) {
    // H5: Re-throw AbortError — deliberate cancellation must propagate to callers
    if (err instanceof Error && err.name === "AbortError") {
      throw err;
    }
    return false;
  }
}
