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
export type EntityType = "person" | "organization" | "location" | "event" | "concept";
export type ExtractionStatus = "pending" | "complete" | "failed" | "skipped" | "decomposed";
export type MemorySource =
  | "user"
  | "auto-capture"
  | "auto-capture-assistant"
  | "memory-watcher"
  | "import"
  | "decomposed";

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
  taskId?: string; // Optional link to TASKS.md task (e.g., "TASK-001")
  // Temporal validity (bi-temporal)
  validFrom: string; // ISO-8601 — when this fact became true (defaults to createdAt)
  validUntil?: string; // ISO-8601 — when this fact stopped being true (null = still valid)
  supersededBy?: string; // ID of the memory that replaced this one (null = not superseded)
};

export type EntityNode = {
  id: string;
  name: string;
  type: EntityType;
  aliases: string[];
  description?: string;
  firstSeen: string;
  lastSeen: string;
  mentionCount: number;
};

export type TagNode = {
  id: string;
  name: string;
  category: string;
  createdAt: string;
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
  score: number;
  taskId?: string; // Optional link to TASKS.md task (e.g., "TASK-001")
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
  score: number;
  taskId?: string; // Optional link to TASKS.md task (e.g., "TASK-001")
  /** True when retrieval confidence is low — only one signal matched and the
   *  second result scored well below the top. Consumers may use this to abstain
   *  from injecting context rather than risk hallucination. */
  lowConfidence?: boolean;
  signals?: {
    vector: SignalAttribution;
    bm25: SignalAttribution;
    graph: SignalAttribution;
    recency?: SignalAttribution;
    freshness?: SignalAttribution; // validFrom-based temporal freshness (OP-129)
  };
};

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
  taskId?: string; // Optional link to TASKS.md task (e.g., "TASK-001")
  validFrom?: string; // Optional — defaults to now() at store time
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

export const ENTITY_TYPES = ["person", "organization", "location", "event", "concept"] as const;

export const ALLOWED_RELATIONSHIP_TYPES = new Set([
  "WORKS_AT",
  "LIVES_AT",
  "KNOWS",
  "MARRIED_TO",
  "PREFERS",
  "DECIDED",
  "RELATED_TO",
  // OP-126: expanded relationship vocabulary
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
]);

/**
 * Memory-to-memory relationship types (distinct from entity-entity relationships).
 * Not included in ALLOWED_RELATIONSHIP_TYPES to avoid polluting entity graph traversal.
 */
export const MEMORY_RELATIONSHIP_TYPES = new Set(["DERIVED_FROM"]);

// ============================================================================
// Lucene Helpers
// ============================================================================

const LUCENE_SPECIAL_CHARS = /[+\-&|!(){}[\]^"~*?:\\/]/g;

/**
 * Escape special characters for Lucene fulltext search queries.
 */
export function escapeLucene(query: string): string {
  return query.replace(LUCENE_SPECIAL_CHARS, "\\$&");
}

/**
 * Validate that a relationship type is in the allowed set.
 * Prevents Cypher injection via dynamic relationship type.
 */
export function validateRelationshipType(type: string): boolean {
  return ALLOWED_RELATIONSHIP_TYPES.has(type);
}

/**
 * Create a canonical key for a pair of IDs (sorted for order-independence).
 */
export function makePairKey(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}
