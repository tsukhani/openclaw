/**
 * Query classification for adaptive signal weight selection in hybrid search.
 *
 * Classifies queries by type (short, entity, long, updates, extraction, causal)
 * to determine optimal signal weights for RRF fusion.
 */

import { porterStem } from "./porter-stemmer.js";

// ============================================================================
// Query Classification
// ============================================================================

export type QueryType =
  | "short"
  | "entity"
  | "long"
  | "updates"
  | "extraction"
  | "causal"
  | "default";

// BM25 query expansion: stop words to exclude (too generic, noise-only).
const BM25_STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "is",
  "are",
  "was",
  "were",
  "what",
  "who",
  "where",
  "when",
  "how",
  "why",
  "do",
  "does",
  "did",
  "for",
  "of",
  "to",
  "in",
  "on",
  "at",
  "by",
  "and",
  "or",
  "my",
  "his",
  "her",
  "its",
  "our",
  "their",
  "me",
  "him",
  "them",
  "us",
]);

/**
 * Generate morphological variants of a word using Porter stemming.
 * Returns the original word plus the stem and stem+s (the two most useful
 * variants for BM25 matching). Conservative: only adds stem-based variants
 * to avoid noise from non-word inflections.
 */
export function morphVariants(word: string): string[] {
  const lower = word.toLowerCase();
  const stem = porterStem(lower);
  const variants = new Set([word]);

  if (stem !== lower && stem.length >= 3) {
    variants.add(stem);
    variants.add(stem + "s");
  }

  // Also add simple -s removal for direct plurals (meetings → meeting)
  if (lower.endsWith("s") && !lower.endsWith("ss") && lower.length > 4) {
    variants.add(lower.slice(0, -1));
  }

  return [...variants];
}

/**
 * Expand a BM25 query with morphological variants using Lucene OR groups.
 * "preferred timezone meetings" → "(preferred OR prefer OR prefers) timezone (meetings OR meeting)"
 * Only applied to extraction queries where keyword precision matters.
 */
export function expandBm25Query(query: string): string {
  return query
    .split(/\s+/)
    .map((word) => {
      const clean = word.replace(/[?.!,;:]+$/, "");
      const suffix = word.slice(clean.length);
      if (
        clean.length <= 3 ||
        BM25_STOP_WORDS.has(clean.toLowerCase()) ||
        /[~*?"\\()]/.test(clean) ||
        /^[A-Z]+$/.test(clean)
      ) {
        return word;
      }
      // Possessives: don't expand (proper nouns)
      if (clean.endsWith("'s")) return word;
      const variants = morphVariants(clean);
      if (variants.length <= 1) return word;
      return `(${variants.join(" OR ")})${suffix}`;
    })
    .join(" ");
}

// M8: Hoist regex constants to module level to avoid recompilation on every classifyQuery() call.
const UPDATES_RE = /\b(current|latest|now|changed|update|updated|newest|recent|recently)\b/i;
const CAUSAL_RE =
  /\b(why|because|caused|reason|root.?cause|led.?to|resulted|consequence|due.?to|prevented)\b/i;
const COMMON_WORDS_RE =
  /^(I|A|An|The|Is|Are|Was|Were|What|Who|Where|When|How|Why|Do|Does|Did|Find|Show|Get|Tell|Me|My|About|For|Can|Could|Has|Have|Should|Would|Please|Will|Shall|May|Might|Am)$/;
const CAPITALIZED_RE = /^[A-Z]/;
// M13: Non-global regex — .match() on a non-global regex returns the first match only,
// but we need all matches. Use matchAll via string.match with global, which is fine
// since we never test() this regex (test() is what mutates lastIndex on global regexes).
const POSSESSIVE_RE = /\w+'s\b/gi;
const WH_ENTITY_RE = /^(who|where|what)\s+(is|does|did|was|were)\s/i;
const PAST_COMM_VERB_RE =
  /\b(said|mentioned|told|described|explained|stated|noted|reported|expressed|opined|thought|believed|felt|preferred|liked|wanted)\b/i;
const WH_COMM_RE =
  /^(?:what|who|how)\s+(?:did|does|do|has)\s+\S.*\b(say|think|feel|prefer|like|want|believe|mention|describe|explain|state|note|report|express)\b/i;
// Broad factual WH-question pattern — catches "What is X's Y?", "Where does X live?",
// "When does X post?" etc. that are needle-in-haystack extraction even without comm verbs.
const FACTUAL_WH_RE = /^(?:what|where|when|which|who)\b/i;

/**
 * Classify a query to determine adaptive signal weights.
 *
 * - short (1-2 words): BM25 excels at exact keyword matching
 * - entity (proper nouns detected): Graph traversal finds connected memories
 * - long (5+ words): Vector captures semantic intent better
 * - updates: Query asks about changed/current state — boost temporal freshness signal
 * - default: balanced weights
 */
export function classifyQuery(query: string): QueryType {
  const words = query.trim().split(/\s+/);
  const wordCount = words.length;

  // Detect update/currency queries early — prioritize over length-based classification
  // so "what is the current model?" (5 words) gets freshness boost rather than "long".
  // Removed "new" — too generic, fires on "how to create a new file". Kept "newest" which
  // is specific to recency. Added "recently" for explicit temporal intent.
  if (UPDATES_RE.test(query)) {
    return "updates";
  }

  // Detect causal/why queries — boost graph signal for causal chain traversal
  if (CAUSAL_RE.test(query)) {
    return "causal";
  }

  const capitalizedWords = words.filter((w) => CAPITALIZED_RE.test(w) && !COMMON_WORDS_RE.test(w));

  // Short queries: 1-2 words → boost BM25, but promote to entity if proper noun detected.
  // Gate entity detection behind word count so longer technical queries like
  // "TypeScript best practices" don't falsely trigger entity/graph boost.
  if (wordCount <= 2) {
    return capitalizedWords.length > 0 ? "entity" : "short";
  }

  // Possessive chain queries: "my wife's older son's phone number", "Alice's manager's email"
  // Two or more possessives indicate multi-hop entity relationship traversal regardless of
  // word count. These need graph signal boost to resolve chains like user → wife → son → phone.
  // M13: String.match() with a global regex ignores lastIndex — no reset needed.
  const possessiveCount = (query.match(POSSESSIVE_RE) || []).length;
  if (possessiveCount >= 2) {
    return "entity";
  }

  // Extraction queries: ask for specific facts stored in memory (OP-138).
  // Factual precision matters more than recency — route to local cross-encoder.
  //
  // Detection (requires ≥4 words to avoid short queries):
  //   1. Past-tense comm/cognition verb: said, mentioned, told, described, thought, felt...
  //   2. WH-question (what/who/how + did/does/do/has) + comm verb: what did Ada say about...
  //   3. Factual WH-question with proper noun or possessive: "What is Tarun's phone number?"
  //
  // Excludes generic verbs (do, go, be) and imperative "tell me about" patterns.
  // The "updates" check (above) fires first so "new/current/latest" takes priority.
  // Fires before entity check so possessive factual queries ("What is X's Y?") get extraction
  // weights (BM25 boost) rather than entity weights (graph boost).
  if (wordCount >= 4) {
    if (PAST_COMM_VERB_RE.test(query) || WH_COMM_RE.test(query)) {
      return "extraction";
    }
    // Factual WH-questions with a named entity — "What is Tarun's phone number?",
    // "What microphone does Tarun use?", "Where is Tarun's home address?" etc.
    // Requires a proper noun (not all-caps acronyms like CEO/API) to target specific named
    // entities. Generic queries ("what is the best framework") and relational queries
    // ("what is my wife's phone") fall through to entity/long classification.
    if (FACTUAL_WH_RE.test(query)) {
      const hasProperNoun = capitalizedWords.some((w) => w !== w.toUpperCase());
      if (hasProperNoun) {
        return "extraction";
      }
    }
  }

  // Question patterns targeting entities — WH-question with possessive chain or short length.
  // Matches "What is my wife's phone?" (possessive, no proper noun) and "What is Alice?" (3-4 words).
  // Without possessive, gate behind wordCount <= 4 to avoid generic long questions like
  // "what is the best framework" from falsely triggering entity/graph boost.
  // Note: factual WH+proper-noun/possessive queries already matched as extraction above.
  if (WH_ENTITY_RE.test(query)) {
    if (possessiveCount >= 1 || wordCount <= 4) {
      return "entity";
    }
  }

  // Long queries: 5+ words → boost vector
  if (wordCount >= 5) {
    return "long";
  }

  return "default";
}

/**
 * Get adaptive signal weights based on query type.
 * Returns [vectorWeight, bm25Weight, graphWeight, freshnessWeight].
 *
 * Decision Q7: Query-adaptive RRF weights
 * - Short → boost BM25 (keyword matching)
 * - Entity → boost graph (relationship traversal)
 * - Long → boost vector (semantic similarity)
 * - Updates → boost freshness (validFrom-based temporal signal, OP-129)
 */
export function getAdaptiveWeights(
  queryType: QueryType,
  graphEnabled: boolean,
): [number, number, number, number] {
  const graphBase = graphEnabled ? 1.0 : 0.0;

  switch (queryType) {
    case "short":
      return [0.8, 1.2, graphBase * 0.3, 0.2];
    case "entity":
      return [0.8, 1.0, graphBase * 0.4, 0.2];
    case "long":
      return [1.2, 0.7, graphBase * 0.3, 0.2];
    case "updates":
      // Stronger freshness boost so newer validFrom memories outrank stale ones
      return [1.0, 1.0, graphBase * 0.3, 0.6];
    case "causal":
      // Why/cause queries: graph helps with causal chains but must not override primary signals
      return [0.9, 0.7, graphBase * 0.5, 0.1];
    case "extraction":
      // Factual precision: vector-led with BM25 assist, no freshness (OP-138).
      // Gold memories match semantically (vector/graph) while distractors often
      // win on keyword overlap (BM25). Keep vector dominant so semantic relevance
      // wins over surface-level keyword matches. Graph at 0.4 to leverage
      // hop-only EXTRACTED_FROM resolution for possessive disambiguation.
      return [1.2, 0.8, graphBase * 0.4, 0.0];
    case "default":
    default:
      return [1.0, 1.0, graphBase * 0.3, 0.2];
  }
}
