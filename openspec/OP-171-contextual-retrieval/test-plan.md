# Test Plan and Benchmarking Strategy

## Unit Tests

### 1. Context Generation (`contextual-retrieval.test.ts`)

```typescript
describe("generateContext", () => {
  it("generates context from source text and memory text");
  it("returns cached result on cache hit");
  it("respects minContextLength validation");
  it("respects maxContextLength validation");
  it("rejects context that echoes the memory text verbatim");
  it("handles empty source text gracefully (skips generation)");
  it("handles source text shorter than 2x memory (skips generation)");
  it("handles LLM API errors gracefully (returns without context)");
  it("handles LLM timeout gracefully");
  it("uses correct prompt template with document + chunk structure");
  it("routes to correct provider based on config (anthropic/openrouter/ollama)");
  it("falls back to extraction.apiKey when contextApiKey not set");
  it("tracks metrics (totalGenerated, cacheHits, failures)");
});

describe("generateContextBatch", () => {
  it("processes multiple memories with same source text");
  it("respects concurrency limit");
  it("continues batch on individual failures");
  it("leverages prompt caching across batch");
  it("returns Map with successful results only");
});

describe("buildContextualText", () => {
  it("formats as '{context}: {text}'");
  it("trims whitespace from context");
  it("handles empty context (returns original text)");
  it("preserves original text unchanged after separator");
});

describe("validateContext", () => {
  it("accepts context within token bounds");
  it("rejects context below minContextLength");
  it("rejects context above maxContextLength");
  it("rejects empty/whitespace-only context");
  it("rejects context identical to memory text");
  it("uses 4-char/token estimation");
});
```

### 2. Context Cache (`contextual-cache.test.ts`)

```typescript
describe("ContextResultCache", () => {
  it("returns undefined for cache miss");
  it("returns cached value for cache hit");
  it("evicts oldest entry when capacity exceeded (LRU)");
  it("uses xxhash64 with null-byte separator for key generation");
  it("handles concurrent access safely");
  it("reports size accurately");
  it("clears all entries on clear()");
});

describe("SourceDocumentCache", () => {
  it("tracks cached documents by source hash");
  it("expires entries after TTL");
  it("increments hit count on repeated access");
  it("evicts expired entries on access");
  it("returns undefined for expired entries");
});
```

### 3. Signal Blending (`search.test.ts` additions)

```typescript
describe("blendVectorResults", () => {
  it("blends original and contextual results with configured weight");
  it("handles memories appearing in only original signal");
  it("handles memories appearing in only contextual signal");
  it("handles memories appearing in both signals");
  it("returns original results at full weight when contextual is empty");
  it("deduplicates by memory id");
  it("sorts by blended score descending");
  it("applies weight=0.7 default when not configured");
  it("applies custom weight from config");
  it("preserves metadata from original results when merging");
});

describe("hybridSearch with contextual", () => {
  it("queries contextual indexes in parallel with original");
  it("blends sub-signals before RRF fusion");
  it("falls back gracefully when contextual indexes don't exist");
  it("falls back gracefully when no memories have contextual fields");
  it("skips contextual queries when signalWeight is 0");
  it("skips contextual queries when feature disabled");
  it("respects signalWeightOverrides per query type");
  it("includes contextualContext in result metadata");
  it("preserves low confidence detection behavior");
});
```

### 4. Neo4j Index Operations (`neo4j-client-indexes.test.ts` additions)

```typescript
describe("contextual indexes", () => {
  it("creates contextual vector index when feature enabled");
  it("creates contextual fulltext index when feature enabled");
  it("skips contextual indexes when feature disabled");
  it("reports contextual index status in checkIndexStatus");
  it("uses same dimensions as primary vector index");
  it("handles index already exists gracefully (IF NOT EXISTS)");
});
```

### 5. Storage Changes (`neo4j-client-memory.test.ts` additions)

```typescript
describe("storeMemory with contextual fields", () => {
  it("stores contextualContext, contextualText, contextualEmbedding");
  it("stores contextGenModel and contextGenAt");
  it("stores memory without contextual fields when null/undefined");
  it("preserves existing fields when contextual fields are null");
  it("handles storeManyMemories batch path with contextual fields");
});

describe("updateMemoryContext", () => {
  it("adds contextual fields to existing memory");
  it("updates updatedAt timestamp");
  it("returns false when memory not found");
  it("does not modify non-contextual fields");
});
```

### 6. Configuration (`config.test.ts` additions)

```typescript
describe("contextualRetrieval config validation", () => {
  it("accepts valid config with all fields");
  it("accepts minimal config (enabled only with ollama)");
  it("rejects signalWeight outside 0-1");
  it("rejects minContextLength > maxContextLength");
  it("rejects contextConcurrency outside 1-32");
  it("rejects signalWeightOverrides values outside 0-1");
  it("warns when enabled without API key and non-local provider");
  it("defaults disabled when not specified");
  it("resolves env var overrides correctly");
});
```

### 7. Reranker with Context (`reranker.test.ts` additions)

```typescript
describe("context-aware reranking", () => {
  it("uses contextualText for cross-encoder input when available");
  it("falls back to original text when no context");
  it("includes context in LLM reranker prompt");
  it("preserves existing reranker routing (local vs LLM)");
});
```

### 8. Migration (`migration.test.ts`)

```typescript
describe("findSourceText", () => {
  it("recovers source from episode nodes via EPISODE_SOURCE");
  it("recovers source from parent memory via DERIVED_FROM");
  it("recovers source from temporal neighbors within 60s window");
  it("falls back to entity context descriptions");
  it("returns null when no viable source found");
  it("orders strategies by priority");
});

describe("migrateContextual", () => {
  it("processes memories in priority order (importance, category, recency)");
  it("respects batch-size and concurrency limits");
  it("skips memories that already have context (unless force)");
  it("reports accurate progress stats");
  it("handles individual memory failures without stopping batch");
  it("dry-run mode estimates cost without modifying data");
});

describe("validateMigration", () => {
  it("reports coverage percentage");
  it("detects embedding dimension mismatches");
  it("verifies contextual index queryability");
  it("returns healthy when coverage > 50% and no issues");
});
```

## Integration Tests

### 9. End-to-End Pipeline (`contextual-retrieval.e2e.test.ts`)

```typescript
describe("contextual retrieval e2e", () => {
  // Requires: Neo4j, embedding API, context LLM
  // Use mock LLM for deterministic context generation

  it("stores memory with generated context and retrieves via contextual search", async () => {
    // 1. Store a memory with source text (auto-capture path)
    // 2. Verify contextual fields populated in Neo4j
    // 3. Query and verify contextual index returns the memory
    // 4. Verify blended score is higher than original-only
  });

  it("handles decomposed memories with parent as source", async () => {
    // 1. Store a multi-entity memory
    // 2. Decompose into atomic facts
    // 3. Verify each atomic fact gets context from parent text
    // 4. Query for a specific entity and verify improved recall
  });

  it("handles mixed memories (with and without context)", async () => {
    // 1. Store some memories with context, some without
    // 2. Query and verify all memories appear in results
    // 3. Verify contextual memories tend to rank higher for relevant queries
  });

  it("migration backfills existing memories", async () => {
    // 1. Store memories without context (feature disabled)
    // 2. Enable feature
    // 3. Run migration (with episode-based source recovery)
    // 4. Verify contextual fields added
    // 5. Query and verify improved retrieval
  });

  it("gracefully degrades on context generation failure", async () => {
    // 1. Configure with invalid API key
    // 2. Store memory -- should succeed without context
    // 3. Query -- should still work with original signals
  });

  it("lazy migration enriches results on query", async () => {
    // 1. Store memories without context
    // 2. Enable feature
    // 3. Query -- should return results, fire-and-forget context gen
    // 4. Wait briefly, query again
    // 5. Verify some memories now have context
  });
});
```

## Benchmarking Strategy

### Benchmark Setup

Create a benchmark suite that measures retrieval quality before and after contextual retrieval:

```typescript
// benchmarks/contextual-retrieval-bench.ts

interface BenchmarkDataset {
  name: string;
  memories: Array<{
    text: string;
    sourceText: string;
    category: string;
  }>;
  queries: Array<{
    query: string;
    expectedMemoryIds: string[]; // ground truth
  }>;
}
```

### Datasets

1. **Conversation memories**: 500 memories extracted from sample conversations, with 50 test queries. Tests the primary auto-capture use case.
2. **Factual knowledge**: 200 fact-type memories about entities, with 30 entity-related queries. Tests decomposed atomic facts.
3. **Temporal updates**: 100 memories with supersession chains, with 20 "latest state" queries. Tests temporal disambiguation.

### Metrics

```typescript
interface BenchmarkResult {
  dataset: string;

  // Retrieval quality
  recall_at_5: number; // % of relevant items in top 5
  recall_at_10: number; // % of relevant items in top 10
  mrr: number; // Mean Reciprocal Rank
  ndcg_at_10: number; // Normalized Discounted Cumulative Gain

  // Failed retrievals (Anthropic's primary metric)
  failedRetrievals: number; // Queries where no relevant item in top 20
  failedRetrievalRate: number;

  // Latency
  avgQueryLatencyMs: number;
  p95QueryLatencyMs: number;
  p99QueryLatencyMs: number;

  // Cost (context generation)
  totalContextGenCost: number;
  avgCostPerMemory: number;
}
```

### Benchmark Configurations

Run each dataset against these configurations to measure incremental improvement:

| Config            | Description                                                        |
| ----------------- | ------------------------------------------------------------------ |
| `baseline`        | Original pipeline (no contextual retrieval)                        |
| `ctx-embed-only`  | Contextual embeddings only (signalWeight=0.7, BM25 blend disabled) |
| `ctx-bm25-only`   | Contextual BM25 only (vector blend disabled)                       |
| `ctx-both`        | Both contextual embeddings + BM25                                  |
| `ctx-both-rerank` | Both + local cross-encoder reranking                               |
| `ctx-sweep-0.3`   | signalWeight=0.3 (conservative blend)                              |
| `ctx-sweep-0.5`   | signalWeight=0.5 (balanced blend)                                  |
| `ctx-sweep-0.7`   | signalWeight=0.7 (default)                                         |
| `ctx-sweep-0.9`   | signalWeight=0.9 (aggressive blend)                                |

### Benchmark Execution

```bash
# Run full benchmark suite
pnpm test -- benchmarks/contextual-retrieval-bench.ts

# Run specific dataset
pnpm test -- benchmarks/contextual-retrieval-bench.ts -t "conversation"

# Generate comparison report
pnpm bench:contextual-report
```

### Expected Results (Based on Anthropic's Findings)

| Configuration   | Failed Retrieval Reduction | Notes                       |
| --------------- | -------------------------- | --------------------------- |
| ctx-embed-only  | ~35%                       | Semantic improvement only   |
| ctx-bm25-only   | ~20%                       | Lexical improvement only    |
| ctx-both        | ~49%                       | Combined semantic + lexical |
| ctx-both-rerank | ~67%                       | Full pipeline               |

Note: Anthropic's numbers are for traditional document-chunking RAG. Memory-neo4j's atomic memory architecture may see different (potentially smaller) improvements since memories already have some natural context boundary. The benchmark will validate actual numbers.

### Continuous Monitoring

After deployment, track these metrics per agent via the existing MetricsCollector:

```typescript
interface ContextualRetrievalMonitorMetrics {
  // Quality (sampled)
  contextGenerationSuccessRate: number;
  avgContextTokens: number;

  // Performance
  contextGenerationLatencyP50: number;
  contextGenerationLatencyP95: number;
  contextualSearchLatencyOverhead: number;

  // Cost
  contextGenerationTokensUsed: number;
  promptCacheHitRate: number;

  // Coverage
  memoriesWithContext: number;
  memoriesWithoutContext: number;
  contextCoverage: number; // percentage
}
```

## Test Data Requirements

### Mock LLM for Unit Tests

```typescript
function createMockContextLLM(): LLMClient {
  return {
    async create(params) {
      // Extract chunk from prompt
      const chunkMatch = params.messages[0].content.match(/<chunk>(.*?)<\/chunk>/s);
      const chunk = chunkMatch?.[1]?.trim() ?? "";

      // Generate deterministic mock context
      const words = chunk.split(" ").slice(0, 5).join(" ");
      const context = `This memory relates to ${words}`;

      return {
        content: [{ type: "text", text: context }],
        usage: { input_tokens: 100, output_tokens: 25 },
      };
    },
  };
}
```

### Neo4j Test Instance

Integration tests use the same Neo4j test instance as existing memory-neo4j tests. Contextual indexes are created in `beforeAll` and dropped in `afterAll`. Tests clean up all created Memory nodes after each test to maintain `--isolate=false` compatibility.
