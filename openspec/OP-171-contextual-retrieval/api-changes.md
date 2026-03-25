# API and Interface Changes

## Summary

All type, interface, and function signature changes required for Contextual Retrieval. Organized by file.

## `schema.ts` — Type Additions

### MemoryNode Extension

```typescript
// New fields added to existing MemoryNode type
interface MemoryNodeContextualFields {
  /** Generated context prefix (50-100 tokens, LLM-generated) */
  contextualContext?: string;

  /** Concatenated "{context}: {text}" for search indexing */
  contextualText?: string;

  /** Embedding vector of contextualText (same dimensions as embedding) */
  contextualEmbedding?: number[];

  /** Model ID used for context generation (e.g. "claude-haiku-4-5-20251001") */
  contextGenModel?: string;

  /** ISO8601 timestamp of when context was generated */
  contextGenAt?: string;
}
```

All fields are **optional/nullable** for backward compatibility.

### Index Name Constants

```typescript
// New constants alongside existing MEMORY_EMBEDDING_INDEX, MEMORY_FULLTEXT_INDEX
const MEMORY_CONTEXTUAL_EMBEDDING_INDEX = "memory_contextual_embedding_index";
const MEMORY_CONTEXTUAL_FULLTEXT_INDEX = "memory_contextual_fulltext_index";
```

## `contextual-retrieval.ts` — New Module

### Types

```typescript
interface ContextGenerationInput {
  /** Full source text (conversation, document, parent memory) */
  sourceText: string;
  /** Individual memory text to contextualize */
  memoryText: string;
  /** Agent ID for scoping */
  agentId: string;
  /** Optional session key for source grouping */
  sessionKey?: string;
}

interface ContextGenerationResult {
  /** Generated context (50-100 tokens) */
  context: string;
  /** Concatenated "{context}: {memoryText}" */
  contextualText: string;
  /** Model used for generation */
  model: string;
  /** Whether result came from cache */
  cached: boolean;
  /** Token usage (input + output), null if cached */
  tokenUsage?: { input: number; output: number };
}

interface ContextGenerationMetrics {
  totalGenerated: number;
  cacheHits: number;
  cacheMisses: number;
  failures: number;
  avgLatencyMs: number;
  avgContextTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  skippedNoSource: number;
  skippedSourceTooShort: number;
  skippedValidationFail: number;
}
```

### Functions

```typescript
/** Generate contextual summary for a memory given its source text */
async function generateContext(
  input: ContextGenerationInput,
  config: ContextualRetrievalConfig,
  deps: { llm: LLMClient; cache: ContextCache },
): Promise<ContextGenerationResult>;

/** Generate context for a batch of memories sharing the same source text */
async function generateContextBatch(
  sourceText: string,
  memories: string[],
  config: ContextualRetrievalConfig,
  deps: Dependencies,
): Promise<Map<string, string>>;

/** Process a memory through the full contextual pipeline */
async function processMemoryWithContext(
  memory: MemoryInput,
  sourceText: string,
  config: ContextualRetrievalConfig,
  deps: Dependencies,
): Promise<ProcessedMemory>;

/** Validate generated context output */
function validateContext(
  context: string,
  memoryText: string,
  config: ContextualRetrievalConfig,
): boolean;

/** Build the contextual text from context + original */
function buildContextualText(context: string, memoryText: string): string;
```

## `contextual-cache.ts` — New Module

### Types

```typescript
interface CachedDocument {
  sourceHash: string;
  sourceLength: number;
  cachedAt: number;
  ttl: number; // ms
  hitCount: number;
}

interface ContextCache {
  /** Tier 1: Source document cache for prompt caching */
  documents: SourceDocumentCache;
  /** Tier 2: Context result LRU cache */
  results: ContextResultCache;
}
```

### Classes

```typescript
class SourceDocumentCache {
  has(sourceHash: string): boolean;
  get(sourceHash: string): CachedDocument | undefined;
  set(sourceHash: string, doc: CachedDocument): void;
  evict(sourceHash: string): void;
  clear(): void;
}

class ContextResultCache {
  constructor(capacity?: number); // default 1000
  get(key: string): string | undefined;
  set(key: string, context: string): void;
  clear(): void;
  readonly size: number;
}
```

## `neo4j-client-memory.ts` — Modified Functions

### `storeMemory()` — Extended Parameters

The existing parameter object gains optional contextual fields:

```typescript
interface StoreMemoryParams {
  // ... existing fields unchanged ...

  // New optional fields
  contextualContext?: string;
  contextualText?: string;
  contextualEmbedding?: number[];
  contextGenModel?: string;
  contextGenAt?: string;
}
```

### New Function: `updateMemoryContext()`

```typescript
/** Add/update contextual fields on an existing memory (used by migration) */
async function updateMemoryContext(
  memoryId: string,
  contextualFields: {
    contextualContext: string;
    contextualText: string;
    contextualEmbedding: number[];
    contextGenModel: string;
    contextGenAt: string;
  },
): Promise<boolean>; // returns false if memory not found
```

## `neo4j-client-search.ts` — New Functions

```typescript
/** Vector search against contextual embedding index */
async function contextualVectorSearch(
  queryEmbedding: number[],
  limit: number,
  agentId: string,
): Promise<SearchSignalResult[]>;

/** BM25 search against contextual fulltext index */
async function contextualBm25Search(
  query: string,
  limit: number,
  agentId: string,
): Promise<SearchSignalResult[]>;
```

Both functions gracefully return empty arrays if the contextual indexes don't exist.

## `neo4j-client-indexes.ts` — Modified Functions

### `ensureIndexes()` — Extended

Creates two additional indexes when `contextualRetrieval.enabled`:

- `memory_contextual_embedding_index` (HNSW cosine on `contextualEmbedding`)
- `memory_contextual_fulltext_index` (Lucene fulltext on `contextualText`)

### `checkIndexStatus()` — Extended Return Type

```typescript
interface IndexStatus {
  // Existing
  memoryEmbedding: IndexState;
  memoryFulltext: IndexState;
  entityEmbedding: IndexState;
  entityFulltext: IndexState;
  communityFulltext: IndexState;

  // New (optional, only when contextual retrieval enabled)
  memoryContextualEmbedding?: IndexState;
  memoryContextualFulltext?: IndexState;
}
```

## `search.ts` — Modified Functions

### `hybridSearch()` — Extended

Now collects 5 parallel signals (up from 4) and blends contextual sub-signals before RRF:

```typescript
// New internal helper
function blendVectorResults(
  originalResults: SearchSignalResult[],
  contextualResults: SearchSignalResult[],
  contextualWeight: number,
): SearchSignalResult[];
```

### `HybridSearchResult` — Extended Return Type

```typescript
interface HybridSearchResult {
  // ... existing fields unchanged ...

  // New optional fields
  contextualContext?: string; // The generated context prefix
  contextualScore?: number; // Score from contextual signals
  contextualContribution?: number; // Rank improvement from context (diagnostic)
}
```

## `config.ts` — New Config Block

```typescript
interface ContextualRetrievalConfig {
  enabled: boolean;
  contextProvider?: "anthropic" | "openrouter" | "ollama";
  contextApiKey?: string;
  contextBaseUrl?: string;
  contextModel?: string;
  minContextLength?: number;
  maxContextLength?: number;
  contextConcurrency?: number;
  documentCache?: {
    enabled?: boolean;
    ttl?: number;
  };
  resultCacheCapacity?: number;
  signalWeight?: number;
  signalWeightOverrides?: Record<string, number>;
}
```

See [config-schema.md](./config-schema.md) for full details.

## `migration.ts` — New Module

```typescript
interface MigrateOptions {
  agentId: string;
  batchSize?: number; // default 50
  concurrency?: number; // default 4
  dryRun?: boolean;
  force?: boolean;
  category?: string[];
  minImportance?: number;
}

interface MigrateResult {
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  dryRun: boolean;
}

interface ValidationResult {
  totalMemories: number;
  migratedMemories: number;
  coverage: string;
  dimensionMismatches: number;
  indexQueryable: boolean;
  status: "healthy" | "needs-attention";
}

async function migrateContextual(agentId: string, options: MigrateOptions): Promise<MigrateResult>;

async function validateMigration(agentId: string): Promise<ValidationResult>;

async function findSourceText(memory: MemoryNode): Promise<string | null>;
```

## `reranker.ts` — Modified Types

### `RerankerCandidate` — Extended

```typescript
interface RerankerCandidate {
  id: string;
  text: string;
  contextualContext?: string; // NEW
  score: number;
  validFrom?: string;
  category?: string;
}
```

## Plugin Tools — New CLI Commands

### `openclaw memory migrate-contextual`

```
openclaw memory migrate-contextual --agent <id>
  [--batch-size 50]
  [--concurrency 4]
  [--dry-run]
  [--force]
  [--category core,fact,preference]
  [--min-importance 0.3]
  [--phase indexes|migrate|validate]
```

### `openclaw memory status` — Extended Output

Reports contextual retrieval coverage:

```
Memory Neo4j Status
  Memories: 12,450
  With context: 8,230 (66.1%)
  Contextual indexes: active
  Context model: claude-haiku-4-5-20251001
  Signal weight: 0.7
```
