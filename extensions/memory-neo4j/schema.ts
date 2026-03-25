/**
 * Graph schema types, Cypher query templates, and constants for memory-neo4j.
 */

// ============================================================================
// Shared Types
// ============================================================================

export type Logger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  debug?: (msg: string) => void;
};

// ============================================================================
// Node Types
// ============================================================================

export type MemoryCategory =
  | "core"
  | "preference"
  | "fact"
  | "decision"
  | "entity"
  | "lesson"
  | "other";
/** Entity type. Known types are listed below; arbitrary strings are accepted for extensibility. */
export type EntityType =
  | "person"
  | "organization"
  | "location"
  | "event"
  | "concept"
  | (string & {});
export type ExtractionStatus = "pending" | "complete" | "failed" | "skipped" | "decomposed";
export type MemorySource = "user" | "auto-capture" | "memory-watcher" | "import" | "decomposed";

export type MemoryNode = {
  id: string;
  text: string;
  embedding: number[];
  importance: number;
  category: MemoryCategory;
  source: MemorySource;
  createdAt: string;
  updatedAt: string;
  extractionStatus: ExtractionStatus;
  extractionRetries: number;
  agentId: string;
  sessionKey?: string;
  retrievalCount: number;
  lastRetrievedAt?: string;
  // Temporal validity (bi-temporal)
  validFrom: string; // ISO-8601 — when this fact became true (defaults to createdAt)
  validUntil?: string; // ISO-8601 — when this fact stopped being true (null = still valid)
  supersededBy?: string; // ID of the memory that replaced this one (null = not superseded)
  // Trust & safety
  trustScore: number; // 0.0–1.0 confidence in memory reliability (default 1.0)
  quarantined?: boolean; // true when flagged by instruction-pattern detection
};

export type EntityNode = {
  id: string;
  name: string;
  type: EntityType;
  aliases: string[];
  description?: string;
  firstSeen: string;
  lastSeen: string;
  relationshipCount: number;
  agentId?: string;
};

export type TagNode = {
  id: string;
  name: string;
  category: string;
  createdAt: string;
};

export type EpisodeNode = {
  id: string;
  text: string;
  role: "user" | "assistant";
  timestamp: string; // ISO-8601
  sessionKey: string;
  agentId: string;
};

export type CommunityNode = {
  id: string;
  name: string;
  summary: string;
  entityCount: number;
  embedding?: number[];
  createdAt: string;
  updatedAt: string;
};

export type ObservationNode = {
  id: string;
  entityName: string;
  agentId: string;
  summary: string;
  lastRefreshed: string; // ISO-8601
  memoryCount: number; // number of memories used to generate this observation
};

export type OpinionNode = {
  id: string;
  agentId: string;
  entityName?: string; // Optional — opinions can be about entities or general topics
  topic: string; // What the opinion is about
  belief: string; // The opinion statement
  confidence: number; // 0.0–1.0
  supportingMemoryIds: string[];
  contradictingMemoryIds: string[];
  lastReflected: string; // ISO-8601
  createdAt: string; // ISO-8601
  archived?: boolean; // true when confidence drops below threshold
  /** Disposition snapshot at time of opinion creation/update (OP-188). */
  dispositionSnapshot?: { skepticism: number; literalism: number; empathy: number };
  /** True when opinion was generalized from cross-entity patterns (OP-188). */
  generalized?: boolean;
};

/** Temporal properties on entity-to-entity relationship edges (OP-122). */
export type EntityRelationship = {
  type: string;
  confidence: number;
  createdAt: string;
  updatedAt?: string; // ISO-8601 — set on every subsequent merge
  validFrom: string; // ISO-8601 — when this relationship was first observed
  validUntil?: string; // ISO-8601 — when this relationship was closed (null = still active)
};

// ============================================================================
// Extraction Types
// ============================================================================

export type ExtractedEntity = {
  name: string;
  type: EntityType;
  aliases?: string[];
  description?: string;
  /** Structured attributes extracted from memory text (e.g. phone, email, birthday). */
  properties?: Record<string, string>;
};

export type ExtractedRelationship = {
  source: string;
  target: string;
  type: string;
  confidence: number;
};

export type ExtractedTag = {
  name: string;
  category: string;
};

export type ExtractionResult = {
  category?: MemoryCategory;
  entities: ExtractedEntity[];
  relationships: ExtractedRelationship[];
  tags: ExtractedTag[];
};

// ============================================================================
// Search Types
// ============================================================================

export type SearchSignalResult = {
  id: string;
  text: string;
  category: string;
  importance: number;
  createdAt: string;
  validFrom?: string; // ISO-8601 — when this fact became true (used for temporal freshness signal)
  supersededBy?: string; // ID of the memory that replaced this one (OP-193)
  score: number;
  trustScore?: number; // 0.0–1.0 — memory reliability (for trust-weighted ranking)
};

export type SignalAttribution = {
  rank: number; // 1-indexed, 0 = absent from this signal
  score: number; // raw signal score, 0 = absent
};

export type HybridSearchResult = {
  id: string;
  text: string;
  category: string;
  importance: number;
  createdAt: string;
  /** ISO-8601 — when this fact became valid. Populated from validFrom signal (OP-129/130). */
  validFrom?: string;
  score: number;
  /** 0.0–1.0 — memory reliability score (for trust-weighted results). */
  trustScore?: number;
  /** True if memory was quarantined by instruction-pattern detection. */
  quarantined?: boolean;
  /** True when retrieval confidence is low — only one signal matched and the
   *  second result scored well below the top. Consumers may use this to abstain
   *  from injecting context rather than risk hallucination. */
  lowConfidence?: boolean;
  /** Rerank score [0,1] when reranker is enabled. Undefined otherwise. */
  rerankScore?: number;
  /** Original pre-rerank RRF score, preserved for debugging. */
  rrfScore?: number;
  /** Episode ID when the memory was linked to an episode via EPISODE_SOURCE (OP-178). */
  episodeId?: string;
  /** ISO-8601 timestamp of the source episode (OP-178). */
  episodeDate?: string;
  /** Session key of the source episode (OP-178). */
  episodeSessionKey?: string;
  /** True when result was returned as a direct answer from the mental model (OP-188). */
  directAnswer?: boolean;
  /** Source opinion when result is a direct answer from the mental model (OP-188). */
  opinionSource?: { topic: string; belief: string; confidence: number };
  /** True when results were produced via compound query decomposition (OP-190). */
  decomposed?: boolean;
  signals?: {
    vector: SignalAttribution;
    bm25: SignalAttribution;
    graph: SignalAttribution;
    recency?: SignalAttribution;
    freshness?: SignalAttribution; // validFrom-based temporal freshness (OP-129)
    community?: SignalAttribution; // community detection signal
    mpfp?: SignalAttribution; // MPFP meta-path traversal (OP-181)
    observation?: SignalAttribution; // per-entity observation summaries (OP-183)
    opinion?: SignalAttribution; // opinion/belief confidence signal (OP-186)
  };
};

/** Configuration for the cross-encoder reranker (OP-130). */
export interface RerankerConfig {
  /** Enable/disable the reranker. Default: false. */
  enabled: boolean;
  /** Provider. Default: "local". */
  provider: "local" | "llm" | "none";
  /** ONNX model name from HuggingFace. Default: "cross-encoder/ms-marco-MiniLM-L-6-v2". */
  model?: string;
  /** Number of candidates to fetch before reranking. Default: 10. */
  topK?: number;
  /** Number of results to return after reranking. Default: 5. */
  topJ?: number;
  /** Drop results below this rerank score. Default: 0 (keep all). */
  minScore?: number;
  /**
   * Reranker provider to use for extraction queries (OP-138).
   * - "local": always use the cross-encoder (fast, ~50ms, optimised for factual precision)
   * - "llm-temporal": use the LLM temporal reranker (slow, ~4–9s)
   * - "auto": use the default provider routing (may hit LLM for temporal-looking queries)
   * Default: "local" — the cross-encoder is significantly better suited for fact-lookup queries.
   */
  extractionMode?: "local" | "llm-temporal" | "auto";
}

// ============================================================================
// Input Types
// ============================================================================

export type StoreMemoryInput = {
  id: string;
  text: string;
  embedding: number[];
  importance: number;
  category: MemoryCategory;
  source: MemorySource;
  extractionStatus: ExtractionStatus;
  agentId: string;
  sessionKey?: string;
  validFrom?: string; // Optional — defaults to now() at store time
  trustScore?: number; // 0.0–1.0 — defaults to source-based trust score or 1.0
  quarantined?: boolean; // true if flagged by instruction detection
};

export type MergeEntityInput = {
  id: string;
  name: string;
  type: EntityType;
  aliases?: string[];
  description?: string;
};

// ============================================================================
// Constants
// ============================================================================

export const MEMORY_CATEGORIES = [
  "core",
  "preference",
  "fact",
  "decision",
  "entity",
  "lesson",
  "other",
] as const;

// ── Fact Type Separation (OP-185) ──
// Groups memory categories into Hindsight-style fact types for retrieval boosting.

export type FactType = "world" | "experience" | "observation" | "opinion" | "other";

/**
 * Maps each fact type to the set of MemoryCategory values it covers.
 * Used by intent detection to boost relevant categories in RRF fusion.
 */
export const FACT_TYPE_CATEGORIES: Record<FactType, readonly MemoryCategory[]> = {
  world: ["fact", "entity"],
  experience: ["lesson", "decision"],
  observation: ["core", "other"], // profile/summary queries — boost core memories
  opinion: ["preference"],
  other: [],
};

/**
 * Reverse lookup: MemoryCategory → FactType.
 * Built once at module load from FACT_TYPE_CATEGORIES.
 */
export const CATEGORY_TO_FACT_TYPE: Record<MemoryCategory, FactType> = (() => {
  const map = {} as Record<MemoryCategory, FactType>;
  for (const [factType, categories] of Object.entries(FACT_TYPE_CATEGORIES) as [
    FactType,
    readonly MemoryCategory[],
  ][]) {
    for (const cat of categories) {
      map[cat] = factType;
    }
  }
  return map;
})();

export const ENTITY_TYPES = ["person", "organization", "location", "event", "concept"] as const;

/**
 * Well-known entity relationship types (documentation / prompt guidance only).
 * Not used as an allowlist — the LLM may produce any relationship type.
 * All LLM-returned types are sanitized via sanitizeRelationshipType() before use.
 */
export const WELL_KNOWN_RELATIONSHIP_TYPES = [
  "WORKS_AT",
  "LIVES_AT",
  "KNOWS",
  "MARRIED_TO",
  "PARENT_OF",
  "CHILD_OF",
  "SIBLING_OF",
  "PREFERS",
  "DECIDED",
  "RELATED_TO",
  "REPORTS_TO",
  "PART_OF",
  "OWNS",
  "ATTENDED",
  "CREATED",
  "MANAGES",
  "COLLABORATES_WITH",
  "FOUNDED",
  "STUDIED_AT",
  "LOCATED_IN",
  "USES",
  "INTEGRATES_WITH",
  // Causal relationships
  "CAUSED_BY",
  "LED_TO",
  "RESULTED_IN",
  "ENABLED_BY",
  "PREVENTED_BY",
] as const;

/**
 * Memory-to-memory relationship types (distinct from entity-entity relationships).
 * These are excluded from entity graph traversal to avoid polluting hop results.
 */
export const MEMORY_RELATIONSHIP_TYPES = new Set(["DERIVED_FROM"]);

/** Relationship from Memory to its source Episode (episodic memory tier). */
export const EPISODE_SOURCE_REL = "EPISODE_SOURCE";

/** Relationship from Entity to its Community (community detection). */
export const BELONGS_TO_REL = "BELONGS_TO";

// M2: Centralized index names — use these constants instead of hardcoded strings.
export const INDEX_MEMORY_EMBEDDING = "memory_embedding_index";
export const INDEX_MEMORY_FULLTEXT = "memory_fulltext_index";
export const INDEX_ENTITY_FULLTEXT = "entity_fulltext_index";
export const INDEX_ENTITY_EMBEDDING = "entity_embedding_index";
export const INDEX_COMMUNITY_FULLTEXT = "community_fulltext_index";

/**
 * Sanitize a relationship type string for safe Cypher interpolation.
 * Normalizes to UPPER_SNAKE_CASE and validates the result matches /^[A-Z_]+$/.
 * Returns null if the type cannot be sanitized to a safe identifier.
 */
export function sanitizeRelationshipType(type: string): string | null {
  const normalized = type
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
  if (normalized.length === 0) return null;
  // M10: Cap relationship type length to prevent unwieldy Cypher identifiers
  if (normalized.length > 64) return null;
  // M3: Allow digits in relationship types (e.g. RELATES_TO_V2, HAS_3_ITEMS)
  // Must start with a letter to be a valid Cypher identifier
  if (!/^[A-Z][A-Z0-9_]*$/.test(normalized)) return null;
  // Reject trailing underscores
  if (normalized.endsWith("_")) return null;
  return normalized;
}

// ============================================================================
// Lucene Helpers
// ============================================================================

const LUCENE_SPECIAL_CHARS = /[+\-&|!(){}[\]^"~*?:\\/]/g;

/**
 * Lucene boolean operators that must not appear as standalone uppercase words.
 * Lucene treats AND, OR, NOT, TO as query operators (case-sensitive) — lowercase
 * equivalents are treated as plain terms, preserving search intent without errors.
 * Fixes: ParseException "Encountered <EOF>" when memory text ends with e.g. "AND".
 */
const LUCENE_RESERVED_WORDS = /\b(AND|OR|NOT|TO)\b/g;

/**
 * Escape special characters and reserved words for Lucene fulltext search queries.
 */
export function escapeLucene(query: string): string {
  return query
    .replace(LUCENE_SPECIAL_CHARS, "\\$&")
    .replace(LUCENE_RESERVED_WORDS, (w) => w.toLowerCase());
}

/**
 * Validate that a relationship type is safe for Cypher interpolation.
 * Returns true if the type matches /^[A-Z_]+$/ after normalization.
 */
export function validateRelationshipType(type: string): boolean {
  return sanitizeRelationshipType(type) !== null;
}

/**
 * Validate a relationship type string and return it for safe Cypher interpolation.
 * Throws if the type does not match /^[A-Z][A-Z0-9_]*$/ (max 64 chars, no trailing underscore).
 *
 * All Cypher queries that interpolate a relationship type into a template literal
 * MUST call this function instead of inline regex guards.
 */
export function safeCypherRelType(type: string): string {
  const valid = /^[A-Z][A-Z0-9_]*$/.test(type) && type.length <= 64 && !type.endsWith("_");
  if (!valid) {
    throw new Error(`Unsafe Cypher relationship type: ${type.slice(0, 80)}`);
  }
  return type;
}

/**
 * Safely convert a Neo4j record value to a JS number.
 * Neo4j returns count(*) and integer properties as neo4j.Integer objects,
 * not plain JS numbers. A TypeScript `as number` cast does not convert at runtime.
 */
export function toJsNumber(raw: unknown): number {
  if (raw == null) return 0;
  if (typeof raw === "number") return raw;
  return Number(raw);
}

/**
 * Create a canonical key for a pair of IDs (sorted for order-independence).
 */
// L2: Use null byte separator — UUIDs never contain \0, preventing
// collisions if IDs ever contain the previous ":" separator.
export function makePairKey(a: string, b: string): string {
  return a < b ? `${a}\0${b}` : `${b}\0${a}`;
}
