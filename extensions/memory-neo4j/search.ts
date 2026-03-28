/**
 * Three-signal hybrid search with query-adaptive RRF fusion.
 *
 * Combines:
 *   Signal 1: Vector similarity (HNSW cosine)
 *   Signal 2: BM25 full-text keyword matching
 *   Signal 3: Graph traversal (structured entity nodes via fulltext index)
 *
 * Fused using confidence-weighted Reciprocal Rank Fusion (RRF)
 * with query-adaptive signal weights.
 *
 * Adapted from ontology project RRF implementation.
 */

import { shouldAbstain } from "./abstention-classifier.js";
import type { ExtractionConfig } from "./config.js";
import type { Embeddings } from "./embeddings.js";
import type { MetricsCollector } from "./metrics.js";
import { NO_OP_METRICS } from "./metrics.js";
import { getOpinionsForTopics } from "./neo4j-client-opinion.js";
import type { Neo4jMemoryClient } from "./neo4j-client.js";
import { decomposeQuery, extractTemporalConstraint } from "./query-analyzer.js";
import type {
  FactType,
  HybridSearchResult,
  Logger,
  MemoryCategory,
  RerankerConfig,
  SearchSignalResult,
  SignalAttribution,
} from "./schema.js";
import { CATEGORY_TO_FACT_TYPE } from "./schema.js";

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

/**
 * Classify a query to determine adaptive signal weights.
 *
 * - short (1-2 words): BM25 excels at exact keyword matching
 * - entity (proper nouns detected): Graph traversal finds connected memories
 * - long (5+ words): Vector captures semantic intent better
 * - updates: Query asks about changed/current state — boost temporal freshness signal
 * - default: balanced weights
 */
import { porterStem } from "./porter-stemmer.js";

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
function morphVariants(word: string): string[] {
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
function expandBm25Query(query: string): string {
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
const FACT_TYPE_BOOST = 1.3;

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

// ============================================================================
// Signal Score Normalization
// ============================================================================

/**
 * Normalize signal scores to 0-1 range via max-scaling.
 *
 * Graph and community signals return raw Lucene fulltext scores (unbounded,
 * typically 0.5–5+) while vector (cosine) and BM25 are already in [0, 1].
 * Without normalization, the confidence-weighted RRF formula
 *   score += weight × signal_score / (k + rank)
 * lets unbounded signals dominate — a graph Entity at score 4.4 contributes
 * ~4× more than a vector Memory at score 0.92 per unit weight.
 *
 * Max-scaling divides all scores by the maximum so the top result gets 1.0
 * and the rest scale proportionally.
 */
function normalizeSignalScores(results: SearchSignalResult[]): SearchSignalResult[] {
  if (results.length === 0) return [];
  const maxScore = results[0].score; // results are already sorted desc by score
  if (maxScore <= 0) return results.map((r) => ({ ...r, score: 0 }));
  return results.map((r) => ({ ...r, score: r.score / maxScore }));
}

// ============================================================================
// Temporal Freshness Signal (OP-129)
// ============================================================================

/**
 * Minimum score ratio below which a result set is considered low-confidence.
 * If the top result was found by only one primary signal AND the second result's
 * normalized score is below this threshold, all results are flagged lowConfidence.
 */
export const LOW_CONFIDENCE_THRESHOLD = 0.35;

/**
 * Returns true if the result set has been flagged as low-confidence.
 * Consumers can use this to abstain from injecting context rather than risk
 * hallucinating with irrelevant memories.
 */
export function isLowConfidenceResult(results: HybridSearchResult[]): boolean {
  return results.length > 0 && results[0].lowConfidence === true;
}

/** M26: Module-level constant for freshness signal threshold. */
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
/** Freshness decay period in days — exp(-daysSince / FRESHNESS_DECAY_DAYS). */
const FRESHNESS_DECAY_DAYS = 365;
/** L3: Default RRF k parameter (rank smoothing constant). */
const DEFAULT_RRF_K = 60;
/** L3: Default candidate multiplier for non-reranker path. */
const DEFAULT_CANDIDATE_MULTIPLIER = 4;
/** L3: Recency decay period in days — same scale as freshness for consistency. */
const RECENCY_DECAY_DAYS = 365;

/**
 * Build a synthetic freshness signal from candidate validFrom dates.
 *
 * Only includes candidates where validFrom differs from createdAt by more than
 * 7 days — i.e. the memory was explicitly back-dated or represents an update
 * to an earlier fact. Sorted by freshness score descending to create ranks for RRF.
 *
 * Freshness score: exp(-daysSince / 365) — decays over ~1 year.
 */
function buildFreshnessSignal(candidates: SearchSignalResult[], now: number): SearchSignalResult[] {
  const seen = new Set<string>();
  const withFreshness: SearchSignalResult[] = [];

  for (const c of candidates) {
    if (seen.has(c.id)) {
      continue;
    }
    seen.add(c.id);

    if (!c.validFrom) {
      continue;
    }
    const validFromMs = new Date(c.validFrom).getTime();
    if (Number.isNaN(validFromMs)) continue; // M9: skip malformed date strings
    const createdAtMs = c.createdAt ? new Date(c.createdAt).getTime() : NaN;
    // M7: Skip when createdAt is missing/malformed — NaN comparison would bypass the 7-day guard
    if (Number.isNaN(createdAtMs)) continue;
    // Only apply freshness when validFrom was explicitly set to differ from createdAt
    if (Math.abs(validFromMs - createdAtMs) <= SEVEN_DAYS_MS) {
      continue;
    }

    const daysSince = (now - validFromMs) / (1000 * 60 * 60 * 24);
    // M1: Clamp to [0, 1] — future validFrom (daysSince < 0) would produce score > 1
    const freshnessScore = Math.min(1.0, Math.exp(-daysSince / FRESHNESS_DECAY_DAYS));
    withFreshness.push({ ...c, score: freshnessScore });
  }

  withFreshness.sort((a, b) => b.score - a.score);
  return withFreshness;
}

// ============================================================================
// Confidence-Weighted RRF Fusion
// ============================================================================

type SignalEntry = {
  rank: number; // 1-indexed
  score: number; // 0-1 normalized
};

type FusedCandidate = {
  id: string;
  text: string;
  category: string;
  importance: number;
  createdAt: string;
  validFrom?: string;
  rrfScore: number;
  signals: {
    vector: SignalAttribution;
    bm25: SignalAttribution;
    graph: SignalAttribution;
    freshness: SignalAttribution;
    community: SignalAttribution;
    mpfp: SignalAttribution;
    observation: SignalAttribution;
    opinion?: SignalAttribution;
  };
};

/**
 * Fuse multiple search signals using confidence-weighted RRF.
 *
 * Formula: RRF_conf(d) = Σ w_i × score_i(d) / (k + rank_i(d))
 *
 * Unlike standard RRF which only uses ranks, this variant preserves
 * score magnitude: rank-1 with score 0.99 contributes more than
 * rank-1 with score 0.55.
 *
 * Reference: Cormack et al. (2009), extended with confidence weighting.
 */
export function fuseWithConfidenceRRF(
  signals: SearchSignalResult[][],
  k: number,
  weights: number[],
): FusedCandidate[] {
  if (signals.length !== weights.length) {
    throw new Error(
      `fuseWithConfidenceRRF: signals.length (${signals.length}) !== weights.length (${weights.length})`,
    );
  }
  // Build per-signal rank/score lookups
  const signalMaps: Map<string, SignalEntry>[] = signals.map((signal) => {
    const map = new Map<string, SignalEntry>();
    for (let i = 0; i < signal.length; i++) {
      const entry = signal[i];
      // If duplicate in same signal, keep first (higher ranked)
      if (!map.has(entry.id)) {
        map.set(entry.id, { rank: i + 1, score: entry.score });
      }
    }
    return map;
  });

  // Collect all unique candidate IDs with their metadata
  const candidateMetadata = new Map<
    string,
    {
      text: string;
      category: string;
      importance: number;
      createdAt: string;
      validFrom?: string;
      supersededBy?: string;
      trustScore?: number;
    }
  >();

  for (const signal of signals) {
    for (const entry of signal) {
      if (!candidateMetadata.has(entry.id)) {
        candidateMetadata.set(entry.id, {
          text: entry.text,
          category: entry.category,
          importance: Number.isFinite(entry.importance) ? entry.importance : 0.5,
          createdAt: entry.createdAt,
          validFrom: entry.validFrom,
          supersededBy: entry.supersededBy,
          trustScore: entry.trustScore,
        });
      }
    }
  }

  // Calculate confidence-weighted RRF score for each candidate
  const results: FusedCandidate[] = [];
  const NO_SIGNAL: SignalAttribution = { rank: 0, score: 0 };

  for (const [id, meta] of candidateMetadata) {
    let rrfScore = 0;

    for (let i = 0; i < signalMaps.length; i++) {
      const entry = signalMaps[i].get(id);
      if (entry && entry.rank > 0) {
        // Confidence-weighted: multiply by original score
        rrfScore += weights[i] * entry.score * (1 / (k + entry.rank));
      }
    }

    // Build per-signal attribution from the existing signal maps
    const signals = {
      vector: signalMaps[0]?.get(id) ?? NO_SIGNAL,
      bm25: signalMaps[1]?.get(id) ?? NO_SIGNAL,
      graph: signalMaps[2]?.get(id) ?? NO_SIGNAL,
      freshness: signalMaps[3]?.get(id) ?? NO_SIGNAL,
      community: signalMaps[4]?.get(id) ?? NO_SIGNAL,
      mpfp: signalMaps[5]?.get(id) ?? NO_SIGNAL,
      observation: signalMaps[6]?.get(id) ?? NO_SIGNAL,
      opinion: signalMaps[7]?.get(id) ?? NO_SIGNAL,
    };

    // Apply trust score as multiplicative weight (default 1.0 = no change)
    const trustWeight = meta.trustScore ?? 1.0;
    const weightedRrfScore = rrfScore * trustWeight;

    results.push({
      id,
      text: meta.text,
      category: meta.category,
      importance: meta.importance,
      createdAt: meta.createdAt,
      validFrom: meta.validFrom,
      rrfScore: weightedRrfScore,
      signals,
    });
  }

  // Sort by RRF score descending
  results.sort((a, b) => b.rrfScore - a.rrfScore);
  return results;
}

// ============================================================================
// Hybrid Search Orchestrator
// ============================================================================

/**
 * Perform a three-signal hybrid search with query-adaptive RRF fusion.
 *
 * 1. Embed the query
 * 2. Classify query for adaptive weights
 * 3. Run three signals in parallel
 * 4. Fuse with confidence-weighted RRF
 * 5. Return top results
 *
 * Graceful degradation: if any signal fails, RRF works with remaining signals.
 * If graph search is not enabled (no extraction API key), uses 2-signal fusion.
 */
export async function hybridSearch(
  db: Neo4jMemoryClient,
  embeddings: Embeddings,
  query: string,
  limit: number = 5,
  agentId: string = "default",
  graphEnabled: boolean = false,
  options: {
    rrfK?: number;
    candidateMultiplier?: number;
    graphFiringThreshold?: number;
    graphSearchDepth?: number;
    /** Max seed entities to look up in the fulltext index. Default: 5. */
    graphSeedCap?: number;
    /** Relationship types to traverse during graph search. Default: null (all types). */
    graphRelTypes?: string[] | null;
    /** Causal relationship types for directed chain search. Default: built-in list. */
    graphCausalRelTypes?: string[];
    logger?: Logger;
    /** When true, include expired (superseded) memories in search results */
    includeExpired?: boolean;
    /** ISO-8601 date — recall memories valid at this point in time. Takes precedence over includeExpired. */
    asOf?: string;
    /** Weight for recency boost applied after RRF fusion (default: 0.1). Higher = more recent memories ranked higher. */
    recencyWeight?: number;
    /**
     * Override adaptive signal weights [vector, bm25, graph, freshness].
     * When set, bypasses query-adaptive weight calculation.
     * Used by the eval harness to implement variant ablations (vector-only, bm25-only, etc.).
     */
    weightOverride?: [number, number, number, number];
    /**
     * Cross-encoder reranker configuration (OP-130).
     * When set and enabled, reranks the final candidate set before returning.
     */
    rerankerConfig?: RerankerConfig;
    /**
     * LLM extraction config — required when rerankerConfig.provider === "llm".
     */
    extractionConfig?: ExtractionConfig;
    /** Metrics collector for reranker telemetry. Defaults to no-op. */
    metricsCollector?: MetricsCollector;
    /**
     * Canonical name of the user's entity in the graph (e.g. "tarun").
     * When set, possessive pronouns ("my", "mine") in the query are resolved
     * to the user's entity name for graph search. Pure string substitution — no LLM call.
     */
    selfEntityName?: string | null;
    /** Optional query result cache. When provided and enabled, caches results by query+agentId. */
    searchCache?: import("./search-cache.js").QueryResultCache;
    /** When true, include quarantined (trustScore=0) memories in results. */
    includeQuarantined?: boolean;
    /** When true, include community search signal in RRF fusion. */
    communityDetectionEnabled?: boolean;
    /** Weight for community signal in RRF fusion. Default: 0.15. */
    communitySignalWeight?: number;
    /** When true, include MPFP meta-path traversal signal in RRF fusion (OP-181). Default: true when graphEnabled. */
    mpfpEnabled?: boolean;
    /** Weight for MPFP signal in RRF fusion. Default: 0.2. */
    mpfpSignalWeight?: number;
    /** When true, include observation summaries signal in RRF fusion (OP-183). Default: true when graphEnabled. */
    observationEnabled?: boolean;
    /** Weight for observation signal in RRF fusion. Default: 0.15. */
    observationSignalWeight?: number;
    /** When true, include opinion/belief signal in RRF fusion (OP-186). Default: true when graphEnabled. */
    opinionEnabled?: boolean;
    /** Weight for opinion signal in RRF fusion. Default: 0.2. */
    opinionSignalWeight?: number;
    /** @internal Guard against infinite recursion in compound query decomposition (OP-190). */
    _skipDecomposition?: boolean;
  } = {},
): Promise<HybridSearchResult[]> {
  // Guard against empty queries
  if (!query.trim()) {
    return [];
  }

  // OP-190: Compound query decomposition — split multi-intent queries into sub-queries
  // and run each independently, then merge results via round-robin interleaving.
  // Guard: recursive calls set _skipDecomposition to prevent infinite recursion.
  if (!options._skipDecomposition) {
    const decomposition = decomposeQuery(query);
    if (decomposition.isCompound && decomposition.subQueries.length >= 2) {
      options.logger?.info?.(
        `memory-neo4j: [decompose] compound query split into ${decomposition.subQueries.length} sub-queries`,
      );

      // Run hybridSearch for each sub-query independently (no further decomposition)
      const subResults = await Promise.all(
        decomposition.subQueries.map((sq) =>
          hybridSearch(db, embeddings, sq, limit, agentId, graphEnabled, {
            ...options,
            _skipDecomposition: true,
          }),
        ),
      );

      // Round-robin interleave: take rank 1 from sub-query 1, rank 1 from sub-query 2, etc.
      const merged: HybridSearchResult[] = [];
      const seenIds = new Set<string>();
      const maxLen = Math.max(...subResults.map((r) => r.length));
      for (let rank = 0; rank < maxLen; rank++) {
        for (const results of subResults) {
          if (rank < results.length) {
            const r = results[rank];
            if (!seenIds.has(r.id)) {
              seenIds.add(r.id);
              merged.push({ ...r, decomposed: true });
            }
            // Dedup: if already seen, skip (first occurrence has higher rank = higher score)
          }
        }
      }

      return merged.slice(0, limit);
    }
  }

  // OP-184: Extract temporal constraints from the query before retrieval.
  // If the query contains temporal expressions (e.g. "last week", "in January"),
  // extract a date range filter and use the cleaned query for semantic search.
  const temporalConstraint = extractTemporalConstraint(query);
  let semanticQuery = query;
  let dateRangeStart: string | undefined;
  let dateRangeEnd: string | undefined;
  if (temporalConstraint) {
    semanticQuery = temporalConstraint.cleanedQuery || query;
    dateRangeStart = temporalConstraint.startDate;
    dateRangeEnd = temporalConstraint.endDate;
    options.logger?.info(
      `memory-neo4j: [temporal] extracted "${temporalConstraint.originalExpression}" → range ${dateRangeStart} to ${dateRangeEnd}`,
    );
  }

  // ── Mental model fast-path (OP-188) ──
  // For opinion-intent queries, check if a high-confidence opinion can directly answer.
  const opinionFastPathEnabled = graphEnabled && options.opinionEnabled !== false;
  const factTypeIntentEarly = detectFactTypeIntent(query);
  if (opinionFastPathEnabled && factTypeIntentEarly === "opinion") {
    try {
      const topicKeywords = query
        .split(/\s+/)
        .filter((w) => w.length >= 3 && !/^(what|who|does|did|how|the|and|for|with)$/i.test(w))
        .map((w) => w.replace(/[^a-zA-Z0-9]/g, ""))
        .filter((w) => w.length >= 3);
      if (topicKeywords.length > 0) {
        const fastPathSession = await db.createSession();
        try {
          const opinions = await getOpinionsForTopics(fastPathSession, agentId, topicKeywords);
          // Find a high-confidence opinion (>= 0.8)
          const highConfidence = opinions.find((o) => o.confidence >= 0.8);
          if (highConfidence && highConfidence.supportingMemoryIds.length > 0) {
            // Fetch supporting memory texts to build direct answer results
            const memIds = highConfidence.supportingMemoryIds;
            const memResult = await fastPathSession.executeRead((tx) =>
              tx.run(
                `MATCH (m:Memory)
                 WHERE m.id IN $ids AND m.agentId = $agentId AND m.validUntil IS NULL
                 RETURN m.id AS id, m.text AS text, m.category AS category,
                        m.importance AS importance, m.createdAt AS createdAt,
                        m.validFrom AS validFrom,
                        COALESCE(m.trustScore, 1.0) AS trustScore`,
                { ids: memIds, agentId },
              ),
            );

            if (memResult.records.length > 0) {
              const directResults: HybridSearchResult[] = memResult.records.map((r, i) => ({
                id: r.get("id") as string,
                text: r.get("text") as string,
                category: r.get("category") as string,
                importance: r.get("importance") as number,
                createdAt: String(r.get("createdAt") ?? ""),
                validFrom: r.get("validFrom") != null ? String(r.get("validFrom")) : undefined,
                score: 1.0 - i * 0.05, // Highest score for first result
                trustScore: (r.get("trustScore") as number) || 1.0,
                directAnswer: true,
                opinionSource: {
                  topic: highConfidence.topic,
                  belief: highConfidence.belief,
                  confidence: highConfidence.confidence,
                },
                signals: {
                  vector: { rank: 0, score: 0 },
                  bm25: { rank: 0, score: 0 },
                  graph: { rank: 0, score: 0 },
                  opinion: { rank: i + 1, score: highConfidence.confidence },
                },
              }));

              options.logger?.info?.(
                `memory-neo4j: [mental-model] direct answer from opinion "${highConfidence.topic}" (confidence: ${highConfidence.confidence})`,
              );
              return directResults.slice(0, limit);
            }
          }
        } finally {
          await fastPathSession.close();
        }
      }
    } catch {
      // Non-critical — fall through to full search pipeline
    }
  }

  // Check cache before executing signals
  const cacheOptions = options.searchCache
    ? {
        includeExpired: options.includeExpired,
        asOf: options.asOf,
        limit,
        includeQuarantined: options.includeQuarantined,
        recencyWeight: options.recencyWeight,
        graphSearchDepth: options.graphSearchDepth,
        graphSeedCap: options.graphSeedCap,
      }
    : undefined;
  if (options.searchCache) {
    const cached = await options.searchCache.get(query, agentId, cacheOptions);
    if (cached) {
      options.metricsCollector?.increment("cache.hits");
      return cached;
    }
    options.metricsCollector?.increment("cache.misses");
  }

  const {
    rrfK = DEFAULT_RRF_K,
    candidateMultiplier = DEFAULT_CANDIDATE_MULTIPLIER,
    graphFiringThreshold = 0.3,
    graphSearchDepth = 2,
    graphSeedCap,
    graphRelTypes,
    graphCausalRelTypes,
    logger,
    includeExpired = false,
    asOf,
    recencyWeight = 0.1,
    weightOverride,
    rerankerConfig,
    extractionConfig,
    metricsCollector = NO_OP_METRICS,
    selfEntityName,
  } = options;

  // Resolve possessive pronouns and strip question noise for graph search.
  // Applied only to the graph query — BM25/vector use the original query.
  //
  // Two-step process:
  //   1. Replace "my"/"mine" with the user's entity name for fulltext matching.
  //   2. Strip question words (what/is/does/etc.) so the Lucene fulltext query
  //      focuses on entity-relevant terms. Without this, a 9-word query like
  //      "What is my wife's older son's phone number?" matches "tarun" as 1/9 terms
  //      giving a low BM25 score that falls below the 0.5 seed threshold.
  let graphQuery = query;
  if (graphEnabled) {
    if (selfEntityName) {
      graphQuery = graphQuery.replace(/\b(my|mine)\b/gi, selfEntityName);
    }
    // Strip leading question patterns and filler words to improve BM25 seed scoring.
    // "What is tarun wife's older son's phone number" → "tarun wife's older son's phone number"
    graphQuery = graphQuery
      .replace(
        /^(what|who|where|when|how|which|whose|whom)\s+(is|are|was|were|does|did|do|has|have|had|will|would|can|could|should)\s+/i,
        "",
      )
      .replace(/[?]/g, "")
      // M23: Strip possessives ('s) to prevent Lucene BM25 dilution.
      // "Tarun's preferred timezone" → "Tarun preferred timezone"
      // Without this, Lucene tokenizes "Tarun's" as ["tarun", "s"] and the noise
      // token "s" dilutes the BM25 score, pushing the entity below the seed threshold.
      .replace(/'s\b/g, "")
      .trim();
  }

  // When reranking is active, fetch topK candidates before reranking; otherwise fetch limit*multiplier
  const rerankerActive = rerankerConfig?.enabled && rerankerConfig.provider !== "none";
  const candidateLimit = rerankerActive
    ? Math.floor(Math.min(200, Math.max(1, rerankerConfig!.topK ?? 10)))
    : Math.floor(Math.min(200, Math.max(1, limit * candidateMultiplier)));

  // 1. Generate query embedding
  const t0 = performance.now();
  // Use cleaned query for embedding so temporal noise doesn't pollute vector similarity
  const queryEmbedding = await embeddings.embed(semanticQuery);
  const tEmbed = performance.now();

  // 2. Classify query and get adaptive weights (overridable for eval variants)
  const queryType = classifyQuery(query);
  const [vW, bW, gW, freshnessW] = weightOverride ?? getAdaptiveWeights(queryType, graphEnabled);

  // BM25 query expansion for extraction queries: append Lucene fuzzy modifier (~1)
  // to content words so BM25 matches morphological variants without changing the
  // fulltext index analyzer. "preferred" matches "prefers", "meetings" matches "meeting".
  // Only vector/graph use the original query; BM25 gets the expanded version.
  const bm25Query = queryType === "extraction" ? expandBm25Query(semanticQuery) : semanticQuery;

  // Detect fact type intent early — needed by opinion signal (OP-186) and post-fusion boost (OP-185).
  const factTypeIntent = detectFactTypeIntent(query);

  // Community signal weight (opt-in, default 0.15 when enabled)
  const communityEnabled = options.communityDetectionEnabled === true;
  const communityW = communityEnabled ? (options.communitySignalWeight ?? 0.15) : 0;

  // 3. Run signals in parallel — each gets its own session because Neo4j sessions
  //    don't support concurrent transactions (executeRead starts a transaction).
  // H7: Per-signal timeout (15s) prevents a single hung signal from blocking the entire search.
  // Each signal gets an AbortController so that when the timeout fires, zombie retries
  // are stopped and the Neo4j session is closed — preventing connection pool exhaustion
  // during high-throughput workloads like the eval harness.
  // M22: Reduced from 15s to 5s. M25: Reduced to 3s — graph traversal timeout
  // is now 2s (down from 5s) and typical queries complete in <100ms. The 3s
  // outer timeout covers network/session overhead for edge cases.
  const SIGNAL_TIMEOUT_MS = 3_000;
  // M15: Clear timer when the promise resolves to prevent timer accumulation
  const withAbortableTimeout = <T>(
    fn: (signal: AbortSignal) => Promise<T>,
    fallback: T,
  ): Promise<T> => {
    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<T>((resolve) => {
      timer = setTimeout(() => {
        ac.abort();
        resolve(fallback);
      }, SIGNAL_TIMEOUT_MS);
      if (typeof timer === "object" && "unref" in timer) timer.unref();
    });
    return Promise.race([fn(ac.signal).finally(() => clearTimeout(timer)), timeoutPromise]);
  };

  const [vectorResults, bm25Results, graphResults, communityResults] = await Promise.all([
    withAbortableTimeout(
      (signal) =>
        db.vectorSearch(
          queryEmbedding,
          candidateLimit,
          0.1,
          agentId,
          includeExpired,
          asOf,
          options.includeQuarantined,
          signal,
          dateRangeStart,
          dateRangeEnd,
        ),
      [] as SearchSignalResult[],
    ),
    withAbortableTimeout(
      (signal) =>
        db.bm25Search(
          bm25Query,
          candidateLimit,
          agentId,
          includeExpired,
          asOf,
          options.includeQuarantined,
          signal,
          dateRangeStart,
          dateRangeEnd,
        ),
      [] as SearchSignalResult[],
    ),
    withAbortableTimeout(
      (signal) =>
        graphEnabled
          ? db.graphSearch(
              graphQuery,
              candidateLimit,
              graphFiringThreshold,
              agentId,
              graphSearchDepth,
              includeExpired,
              asOf,
              graphSeedCap,
              graphRelTypes,
              undefined, // hopDecayThreshold — use default
              queryType, // dispatch to causalChainSearch for "causal" queries
              queryEmbedding, // OP-143: dual-seed — vector + fulltext for entity traversal
              graphCausalRelTypes, // configurable causal types for chain search
              signal,
            )
          : Promise.resolve([] as SearchSignalResult[]),
      [] as SearchSignalResult[],
    ),
    withAbortableTimeout(
      (signal) =>
        communityEnabled
          ? db.communitySearch(
              query,
              candidateLimit,
              agentId,
              options.includeQuarantined,
              includeExpired,
              asOf,
              signal,
            )
          : Promise.resolve([] as SearchSignalResult[]),
      [] as SearchSignalResult[],
    ),
  ]);
  const tSignals = performance.now();

  // 4a. Normalize unbounded graph/community scores to 0-1.
  //     Vector (cosine) and BM25 are already in [0, 1]; graph and community
  //     carry raw Lucene fulltext scores (often 2–5+) that would dominate RRF.
  //     Graph results are now resolved to Memory nodes via EXTRACTED_FROM
  //     provenance edges in structuredGraphSearch, so they carry Memory IDs
  //     consistent with vector/BM25 signals.
  const normalizedGraphResults = normalizeSignalScores(graphResults);
  const normalizedCommunityResults = normalizeSignalScores(communityResults);

  // 4a-bis. MPFP meta-path traversal (OP-181): run after primary signals
  // to use seed Memory IDs from vector/BM25 hits as traversal starting points.
  const mpfpEnabled = graphEnabled && options.mpfpEnabled !== false;
  const mpfpW = mpfpEnabled ? (options.mpfpSignalWeight ?? 0.2) : 0;
  let mpfpResults: SearchSignalResult[] = [];
  if (mpfpEnabled) {
    const seedIds = [
      ...new Set([...vectorResults.map((r) => r.id), ...bm25Results.map((r) => r.id)]),
    ];
    if (seedIds.length > 0) {
      // Determine MPFP mode: temporal queries use temporal patterns, others use semantic.
      // OP-184: also use temporal mode when query-analyzer extracted a date constraint.
      const mpfpMode =
        queryType === "updates" || temporalConstraint
          ? "temporal"
          : queryType === "causal"
            ? "both"
            : "semantic";
      mpfpResults = await withAbortableTimeout(
        (signal) => db.mpfpSearch(seedIds, agentId, mpfpMode, { logger }, signal),
        [] as SearchSignalResult[],
      );
    }
  }
  const normalizedMpfpResults = normalizeSignalScores(mpfpResults);

  // 4a-ter. Observation signal (OP-183): look up per-entity observation summaries
  // for entities matching the query and map to connected memory IDs.
  const observationEnabled = graphEnabled && options.observationEnabled !== false;
  const observationW = observationEnabled ? (options.observationSignalWeight ?? 0.15) : 0;
  let observationResults: SearchSignalResult[] = [];
  if (observationEnabled) {
    try {
      // Extract capitalized words (likely entity names) from the graph-optimized query
      const entityCandidates = graphQuery
        .split(/\s+/)
        .filter((w) => w.length >= 2 && /^[A-Z]/i.test(w))
        .map((w) => w.replace(/[^a-zA-Z0-9]/g, ""))
        .filter((w) => w.length >= 2);
      const uniqueNames = [...new Set(entityCandidates)];
      if (uniqueNames.length > 0) {
        const observations = await db.getObservationsForEntities(agentId, uniqueNames);
        for (const obs of observations) {
          // Create synthetic signal results: each connected memory gets a score
          // proportional to 1/position so earlier memories rank higher.
          const count = obs.memoryIds.length;
          for (let i = 0; i < count; i++) {
            observationResults.push({
              id: obs.memoryIds[i],
              text: obs.summary,
              category: "entity",
              importance: 0.8,
              createdAt: new Date().toISOString(),
              score: count > 1 ? 1 - i / count : 1.0,
            });
          }
        }
      }
    } catch {
      // Non-critical — observation lookup failure doesn't block search
    }
  }
  const normalizedObservationResults = normalizeSignalScores(observationResults);

  // 4a-quater. Opinion/belief signal (OP-186): look up opinions matching query keywords
  // and map to their supporting memory IDs, with confidence-based score boosting.
  // Only fires for opinion/preference intent queries (detected by OP-185).
  const opinionEnabled = graphEnabled && options.opinionEnabled !== false;
  const opinionW = opinionEnabled ? (options.opinionSignalWeight ?? 0.2) : 0;
  let opinionResults: SearchSignalResult[] = [];
  if (opinionEnabled && factTypeIntent === "opinion") {
    try {
      // Extract topic keywords from the query for opinion lookup
      const topicKeywords = query
        .split(/\s+/)
        .filter((w) => w.length >= 3 && !/^(what|who|does|did|how|the|and|for|with)$/i.test(w))
        .map((w) => w.replace(/[^a-zA-Z0-9]/g, ""))
        .filter((w) => w.length >= 3);
      if (topicKeywords.length > 0) {
        const session = await db.createSession();
        try {
          const opinions = await getOpinionsForTopics(session, agentId, topicKeywords);
          for (const op of opinions) {
            // Confidence-based score boost:
            // High (>= 0.7): 1.4x, Medium (0.4-0.7): 1.0x, Low (< 0.4): 0.7x
            const confidenceBoost = op.confidence >= 0.7 ? 1.4 : op.confidence >= 0.4 ? 1.0 : 0.7;
            const baseScore = op.confidence * confidenceBoost;
            // Bridge to supporting memory IDs
            const count = op.supportingMemoryIds.length;
            for (let i = 0; i < count; i++) {
              opinionResults.push({
                id: op.supportingMemoryIds[i],
                text: op.belief,
                category: "preference",
                importance: 0.9,
                createdAt: new Date().toISOString(),
                score: count > 1 ? baseScore * (1 - i / count) : baseScore,
              });
            }
          }
        } finally {
          await session.close();
        }
      }
    } catch {
      // Non-critical — opinion lookup failure doesn't block search
    }
  }
  const normalizedOpinionResults = normalizeSignalScores(opinionResults);

  // 4b. Build temporal freshness signal from validFrom dates across all candidates (OP-129).
  //     Only candidates where validFrom differs from createdAt by >7 days participate.
  const now = Date.now();
  const freshnessSignal = buildFreshnessSignal(
    [
      ...vectorResults,
      ...bm25Results,
      ...normalizedGraphResults,
      ...normalizedCommunityResults,
      ...normalizedMpfpResults,
      ...normalizedObservationResults,
      ...normalizedOpinionResults,
    ],
    now,
  );

  // 5. Fuse all signals with confidence-weighted RRF.
  //    8 signals: vector, bm25, graph, freshness, community, mpfp, observation, opinion.
  //    M22: When graph returns empty results, zero its weight to prevent
  //    diluting vector/BM25 contributions. An empty graph signal adds no
  //    useful information but changes relative RRF score distribution.
  const effectiveGraphWeight = normalizedGraphResults.length > 0 ? gW : 0;
  const effectiveMpfpWeight = normalizedMpfpResults.length > 0 ? mpfpW : 0;
  const effectiveObservationWeight = normalizedObservationResults.length > 0 ? observationW : 0;
  const effectiveOpinionWeight = normalizedOpinionResults.length > 0 ? opinionW : 0;
  const weights = [
    vW,
    bW,
    effectiveGraphWeight,
    freshnessW,
    communityW,
    effectiveMpfpWeight,
    effectiveObservationWeight,
    effectiveOpinionWeight,
  ];
  let fused = fuseWithConfidenceRRF(
    [
      vectorResults,
      bm25Results,
      normalizedGraphResults,
      freshnessSignal,
      normalizedCommunityResults,
      normalizedMpfpResults,
      normalizedObservationResults,
      normalizedOpinionResults,
    ],
    rrfK,
    weights,
  );

  // 5b. Fact type boost (OP-185): boost matching categories when intent detected.
  if (factTypeIntent) {
    fused = applyFactTypeBoost(fused, factTypeIntent);
    logger?.info?.(`memory-neo4j: [fact-type] detected intent="${factTypeIntent}"`);
  }

  const tFuse = performance.now();

  // 6. Apply recency as a multiplicative boost (OP-121).
  //    recencyScore = exp(-daysSince / 365) — 1-year half-life
  //    boostedScore = rrfScore * (1 + recencyWeight * recencyScore)
  //    Then normalize to 0-1 range.
  //    Apply to a larger window (limit*2) so recent memories ranked just outside
  //    the RRF top-N can still surface after the recency re-sort.
  const recencyWindow = Math.min(fused.length, limit * 2);
  const candidates = fused.slice(0, recencyWindow).map((r) => {
    const createdAtMs = r.createdAt ? new Date(r.createdAt).getTime() : NaN;
    const ageDays = !Number.isNaN(createdAtMs)
      ? (now - createdAtMs) / (1000 * 60 * 60 * 24)
      : RECENCY_DECAY_DAYS; // default to 1 year if missing or malformed createdAt
    const recencyScore = Math.exp(-ageDays / RECENCY_DECAY_DAYS);
    const boostedScore = r.rrfScore * (1 + recencyWeight * recencyScore);
    return { ...r, recencyScore, boostedScore };
  });

  // Re-sort by boosted score (recency boost may reorder vs pure RRF)
  // then take only `limit` results
  candidates.sort((a, b) => b.boostedScore - a.boostedScore);
  candidates.splice(limit);

  // Score-gap truncation for extraction queries: if the score drops sharply between
  // consecutive results, the tail is likely noise. Trimming improves precision without
  // hurting recall (gold memories score well above distractors).
  const SCORE_GAP_RATIO = 0.6; // >40% drop signals noise — tighter to prune competitive distractors
  if (queryType === "extraction" && candidates.length >= 2) {
    let cutoff = candidates.length;
    for (let i = 1; i < candidates.length; i++) {
      if (candidates[i].boostedScore < candidates[i - 1].boostedScore * SCORE_GAP_RATIO) {
        cutoff = i;
        break;
      }
    }
    if (cutoff < candidates.length) {
      logger?.info?.(
        `memory-neo4j: [score-gap] truncated extraction results from ${candidates.length} to ${cutoff}`,
      );
      candidates.splice(cutoff);
    }
  }

  // Normalize boosted scores to 0-1 range
  const maxBoosted = candidates.length > 0 ? candidates[0].boostedScore : 0;
  const MIN_SCORE_FOR_NORMALIZATION = 0.01;
  const normalizer = maxBoosted >= MIN_SCORE_FOR_NORMALIZATION ? 1 / maxBoosted : 1;

  // 7. Detect low confidence (OP-129): flag all results when the top result was
  //    found by only one primary signal AND the second result scores well below it.
  //    Consumers can use lowConfidence=true to abstain from injecting weak context.
  const lowConfidence = (() => {
    if (candidates.length < 1) {
      return false;
    }
    const top = candidates[0];
    const s = top.signals;
    const vectorFound = s.vector.rank > 0;
    const bm25Found = s.bm25.rank > 0;
    const graphFound = s.graph.rank > 0;
    const signalCount = [vectorFound, bm25Found, graphFound].filter(Boolean).length;
    if (signalCount > 1) {
      return false;
    }
    // Compute normalized score for second result to compare
    const secondBoosted = candidates.length >= 2 ? candidates[1].boostedScore : 0;
    const secondNormalized = Math.min(1, secondBoosted * normalizer);
    return secondNormalized < LOW_CONFIDENCE_THRESHOLD;
  })();

  const results: HybridSearchResult[] = candidates.map((r) => ({
    id: r.id,
    text: r.text,
    category: r.category,
    importance: r.importance,
    createdAt: r.createdAt,
    validFrom: r.validFrom,
    score: Math.min(1, r.boostedScore * normalizer),
    ...(lowConfidence ? { lowConfidence: true as const } : {}),
    signals: {
      ...r.signals,
      recency: { rank: 0, score: r.recencyScore },
    },
  }));

  // 7b. Rerank candidates if configured (OP-130).
  //     Temporal/update queries route to LLM reranker (with timestamps) inside rerankCandidates.
  //     All other queries use the local cross-encoder HTTP service.
  let finalResults = results;
  if (rerankerActive && rerankerConfig) {
    const { rerankCandidates } = await import("./reranker.js");
    finalResults = await rerankCandidates(
      query,
      results,
      rerankerConfig,
      extractionConfig ?? null,
      logger ?? null,
      metricsCollector,
      undefined, // no per-search AbortSignal here
      queryType, // passed for temporal routing decision
    );
  }

  // 7c. Unified abstention classifier (OP-137).
  // Runs on both reranker and non-reranker paths. Operates on .score which is
  // cross-encoder relevanceScore post-reranking, or normalized RRF score otherwise.
  // Skip for graph-only results — classifiers can't evaluate relationship-traversal
  // results meaningfully (e.g. multi-hop entity chains).
  // Skip for temporal queries — LLM reranker assigns moderate scores (0.8–0.9) to
  // comparison-type queries where multiple memories are jointly relevant.
  if (finalResults.length > 0) {
    const { isTemporalQuery } = await import("./reranker.js");
    const temporal = isTemporalQuery(query, queryType);
    const graphOnlyResults = finalResults.every((r) => {
      const s = r.signals;
      return s && s.graph.rank > 0 && s.vector.rank === 0 && s.bm25.rank === 0;
    });
    if (graphOnlyResults) {
      logger?.info(
        `memory-neo4j: [abstention] skipped — all ${finalResults.length} results are graph-only`,
      );
    } else if (temporal) {
      logger?.info(`memory-neo4j: [abstention] skipped — temporal query`);
    } else if (shouldAbstain(finalResults, queryType)) {
      logger?.info(
        `memory-neo4j: [abstention/classifier] abstaining — queryType=${queryType} candidates=${finalResults.length} maxScore=${finalResults[0].score.toFixed(3)}`,
      );
      metricsCollector.increment("reranker.abstentions");
      finalResults = [];
    }
  }

  // Memory node IDs from vector/BM25 signals — used for retrieval tracking and episode enrichment.
  // Graph signal results carry Neo4j element IDs (entity nodes) which don't exist in the Memory label.
  const memoryIdSet = new Set([...vectorResults.map((r) => r.id), ...bm25Results.map((r) => r.id)]);

  // 6. Record retrieval events (fire-and-forget for latency)
  // This tracks which memories are actually being used, enabling
  // retrieval-based importance adjustment.
  if (finalResults.length > 0) {
    const memoryIds = finalResults.map((r) => r.id).filter((id) => memoryIdSet.has(id));
    if (memoryIds.length > 0) {
      db.recordRetrievals(memoryIds).catch((err) => {
        logger?.debug?.(
          `memory-neo4j: recordRetrievals failed (non-critical): ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
  }

  // 8. Episode enrichment (OP-178): attach episode metadata to results.
  //    Non-blocking — episode metadata is informational ("when did we discuss X?").
  //    Only enrich Memory-node results (graph-only entity results don't have episodes).
  if (finalResults.length > 0) {
    const enrichIds = finalResults.map((r) => r.id).filter((id) => memoryIdSet.has(id));
    if (enrichIds.length > 0) {
      try {
        const episodes = await db.episodeEnrich(enrichIds);
        if (episodes.length > 0) {
          const epByMemory = new Map(episodes.map((e) => [e.memoryId, e]));
          for (const r of finalResults) {
            const ep = epByMemory.get(r.id);
            if (ep) {
              r.episodeId = ep.episodeId;
              r.episodeDate = ep.episodeDate;
              r.episodeSessionKey = ep.episodeSessionKey;
            }
          }
        }
      } catch (err) {
        logger?.debug?.(
          `memory-neo4j: episodeEnrich failed (non-critical): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // Log search timing breakdown
  const recencyStr = recencyWeight !== 0.1 ? ` recencyWeight=${recencyWeight}` : "";
  const asOfStr = asOf ? ` asOf=${asOf}` : "";
  const lowConfStr = lowConfidence ? " lowConf=true" : "";
  const rerankerStr = rerankerActive ? ` reranker=${rerankerConfig?.provider}` : "";
  const factTypeStr = factTypeIntent ? ` factType=${factTypeIntent}` : "";
  logger?.info?.(
    `memory-neo4j: [bench] hybridSearch ${(tFuse - t0).toFixed(0)}ms (embed=${(tEmbed - t0).toFixed(0)}ms, signals=${(tSignals - tEmbed).toFixed(0)}ms, fuse=${(tFuse - tSignals).toFixed(0)}ms) ` +
      `type=${queryType} vec=${vectorResults.length} bm25=${bm25Results.length} graph=${graphResults.length} freshness=${freshnessSignal.length} mpfp=${mpfpResults.length} obs=${observationResults.length} opin=${opinionResults.length} → ${finalResults.length} results${recencyStr}${asOfStr}${lowConfStr}${rerankerStr}${factTypeStr}`,
  );

  // Store in cache (if enabled)
  if (options.searchCache) {
    await options.searchCache.set(query, agentId, finalResults, cacheOptions);
  }

  return finalResults;
}
