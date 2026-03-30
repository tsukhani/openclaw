/**
 * Fact type intent detection for query-aware search boosting (OP-185).
 *
 * Detects the dominant fact type intent from query keywords and applies
 * category-based score boosts to fused RRF candidates.
 */

import type { FactType, MemoryCategory } from "./schema.js";
import { CATEGORY_TO_FACT_TYPE } from "./schema.js";
import type { FusedCandidate } from "./search-rrf-fusion.js";

// ============================================================================
// Fact Type Intent Detection (OP-185)
// ============================================================================

// Keyword patterns for detecting fact type intent in queries.
const OPINION_INTENT_RE =
  /\b(prefer|preference|preferences|opinion|opinions|think|thinks|like|likes|love|loves|hate|hates|dislike|dislikes|favorite|favourite|want|wants|wish|wished)\b/i;
const EXPERIENCE_INTENT_RE =
  /\b(lesson|lessons|learned|learnt|decided|decision|decisions|experience|experiences|try|tried|attempt|attempted|mistake|mistakes|takeaway|takeaways|insight|insights)\b/i;
const WORLD_INTENT_RE =
  /\b(fact|facts|know|knows|knowledge|what\s+is|who\s+is|where\s+is|when\s+was|information|detail|details|data|name|address|number|email|phone|birthday|age|cost|costs|price|priced|pricing|how\s+much|fee|fees|charge|charges|rate|rates|salary|salaries|budget|revenue|income|expense|expenses)\b/i;
const OBSERVATION_INTENT_RE = /\b(observation|observations|profile|profiles|summary|summaries)\b/i;

/**
 * Detect the dominant fact type intent from query keywords (OP-185).
 * Returns null when no clear intent is detected (uniform weights).
 * Simple keyword-based — no LLM call.
 */
export function detectFactTypeIntent(query: string): FactType | null {
  if (OPINION_INTENT_RE.test(query)) return "opinion";
  if (EXPERIENCE_INTENT_RE.test(query)) return "experience";
  // Check observation before world — world's "what is" pattern is broad and would
  // shadow observation-specific keywords like "profile" and "summary".
  if (OBSERVATION_INTENT_RE.test(query)) return "observation";
  if (WORLD_INTENT_RE.test(query)) return "world";
  return null;
}

/**
 * Category boost multiplier applied to RRF scores when a fact type intent is detected.
 * Matching categories get boosted; non-matching get a neutral 1.0 (no penalty).
 */
export const FACT_TYPE_BOOST = 1.3;

/**
 * Apply fact-type-aware boost to fused candidates (OP-185).
 * Multiplies RRF score by FACT_TYPE_BOOST for candidates whose category
 * matches the detected intent. Non-matching candidates are unchanged.
 * Re-sorts by boosted score.
 */
export function applyFactTypeBoost(
  candidates: FusedCandidate[],
  intent: FactType,
): FusedCandidate[] {
  const boosted = candidates.map((c) => {
    const catFactType = CATEGORY_TO_FACT_TYPE[c.category as MemoryCategory];
    if (catFactType === intent) {
      return { ...c, rrfScore: c.rrfScore * FACT_TYPE_BOOST };
    }
    return c;
  });
  boosted.sort((a, b) => b.rrfScore - a.rrfScore);
  return boosted;
}
