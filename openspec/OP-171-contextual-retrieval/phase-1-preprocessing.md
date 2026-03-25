# Phase 1: Preprocessing Pipeline

## Overview

The preprocessing pipeline generates contextual summaries for each memory and prepends them before embedding. This is the core of the Contextual Retrieval technique, adapted for memory-neo4j's atomic memory architecture.

## New File: `contextual-retrieval.ts`

### Context Generator

```typescript
interface ContextGenerationInput {
  /** The full source text (conversation, document, parent memory) */
  sourceText: string;
  /** The individual memory/chunk text */
  memoryText: string;
  /** Agent ID for scoping */
  agentId: string;
  /** Optional session key for source grouping */
  sessionKey?: string;
}

interface ContextGenerationResult {
  /** Generated context (50-100 tokens) */
  context: string;
  /** The concatenated "{context}: {memoryText}" */
  contextualText: string;
  /** Model used for generation */
  model: string;
  /** Whether result came from cache */
  cached: boolean;
  /** Token usage (input + output) */
  tokenUsage?: { input: number; output: number };
}

async function generateContext(
  input: ContextGenerationInput,
  config: ContextualRetrievalConfig,
  deps: { llm: LLMClient; cache: ContextCache },
): Promise<ContextGenerationResult>;
```

### Prompt Template

```
<document>
{{SOURCE_TEXT}}
</document>

Here is the chunk we want to situate within the whole document:
<chunk>
{{MEMORY_TEXT}}
</chunk>

Please give a short succinct context to situate this chunk within
the overall document for the purposes of improving search retrieval
of the chunk. Answer only with the succinct context and nothing else.
```

**Adaptations for memory-neo4j's architecture**:

The Anthropic technique uses `WHOLE_DOCUMENT` as context. In memory-neo4j, memories come from conversations, not documents. The "source text" varies by capture path:

| Memory Source     | SOURCE_TEXT                                         | How to Access                            |
| ----------------- | --------------------------------------------------- | ---------------------------------------- |
| `auto-capture`    | Compacted conversation text from `agent_end` hook   | Passed through `runAutoCapture()` params |
| `user` (explicit) | Full user message containing "remember" instruction | Available in `memory_store` tool handler |
| `decomposed`      | Parent memory text (pre-decomposition)              | `DERIVED_FROM` relationship in Neo4j     |
| `import`          | Full imported document/file                         | Available at import time                 |
| `memory-watcher`  | Conversation context window at capture time         | Available in watcher hook                |

When `sourceText` is unavailable or too short (< 2x the memory text), context generation is skipped and the memory is stored without contextual fields.

### Processing Flow

```typescript
async function processMemoryWithContext(
  memory: MemoryInput,
  sourceText: string,
  config: ContextualRetrievalConfig,
  deps: Dependencies,
): Promise<ProcessedMemory> {
  // 1. Check if contextual retrieval is enabled
  if (!config.enabled) {
    return processWithoutContext(memory, deps);
  }

  // 2. Check source text viability
  if (!sourceText || sourceText.length < memory.text.length * 2) {
    return processWithoutContext(memory, deps);
  }

  // 3. Generate context (with caching)
  const result = await generateContext(
    {
      sourceText,
      memoryText: memory.text,
      agentId: memory.agentId,
      sessionKey: memory.sessionKey,
    },
    config,
    deps,
  );

  // 4. Generate dual embeddings
  const [embedding, contextualEmbedding] = await Promise.all([
    deps.embedder.embed(memory.text),
    deps.embedder.embed(result.contextualText),
  ]);

  return {
    ...memory,
    embedding,
    contextualContext: result.context,
    contextualText: result.contextualText,
    contextualEmbedding,
    contextGenModel: result.model,
    contextGenAt: new Date().toISOString(),
  };
}
```

### Error Handling

Context generation is **non-critical** -- failures never block memory storage:

```typescript
try {
  const result = await generateContext(input, config, deps);
  // Store with contextual fields
} catch (error) {
  log.warn("Context generation failed, storing without context", { error });
  // Store without contextual fields -- original pipeline continues
}
```

## New File: `contextual-cache.ts`

### Cache Strategy

Two-tier caching to minimize LLM calls:

**Tier 1: Source Document Cache (Prompt Caching)**

When using Anthropic models, leverage prompt caching for the `<document>` block. Multiple memories from the same source text share the cached document prefix. This provides the ~98.5% cost reduction cited in Anthropic's article.

```typescript
interface SourceDocumentCache {
  /** Key: xxhash64 of sourceText */
  has(sourceHash: string): boolean;
  get(sourceHash: string): CachedDocument | undefined;
  set(sourceHash: string, doc: CachedDocument): void;
  evict(sourceHash: string): void;
}

interface CachedDocument {
  sourceHash: string;
  sourceLength: number;
  cachedAt: number;
  ttl: number; // ms, default 3600000 (1 hour)
  hitCount: number;
}
```

**Tier 2: Context Result Cache (LRU)**

Cache generated contexts to avoid re-generating for identical memory+source pairs. Uses the same LRU pattern as the existing embedding cache in `embeddings.ts`.

```typescript
interface ContextResultCache {
  /** Key: xxhash64(sourceText + "\x00" + memoryText) */
  capacity: number; // default 1000
  get(key: string): string | undefined;
  set(key: string, context: string): void;
}
```

### Cache Key Design

```typescript
function contextCacheKey(sourceText: string, memoryText: string): string {
  // Uses xxhash64, consistent with existing embedding cache key strategy
  return xxhash64(sourceText + "\x00" + memoryText);
}
```

The null byte separator prevents collisions where sourceText ends with the same chars that memoryText starts with.

## LLM Client Integration

### Model Selection Priority

1. `config.contextualRetrieval.contextModel` (explicit config)
2. `config.extraction.model` (reuse extraction model as fallback)
3. Hardcoded default: `claude-haiku-4-5-20251001` via Anthropic API

### Provider Routing

Context generation reuses the existing `api.runtime.llm` injection pattern (via `setPluginLlm` in index.ts) when possible. For direct Anthropic API access (required for prompt caching), a dedicated client is created:

```typescript
function getContextLLMClient(config: ContextualRetrievalConfig): LLMClient {
  if (config.contextProvider === "anthropic") {
    return new AnthropicClient({
      apiKey: config.contextApiKey ?? config.extraction.apiKey,
      model: config.contextModel ?? "claude-haiku-4-5-20251001",
      promptCaching: config.documentCache.enabled,
    });
  }

  if (config.contextProvider === "openrouter") {
    return new OpenRouterClient({
      apiKey: config.contextApiKey ?? config.extraction.apiKey,
      baseUrl: config.contextBaseUrl ?? config.extraction.baseUrl,
      model: config.contextModel ?? "anthropic/claude-haiku-4-5",
    });
  }

  // Local model (ollama) -- uses same concurrency controls as embedding Ollama client
  return new OllamaClient({
    baseUrl: config.contextBaseUrl ?? "http://localhost:11434",
    model: config.contextModel ?? "llama3.2:3b",
  });
}
```

### Prompt Caching (Anthropic)

When using Anthropic's API with prompt caching enabled:

```typescript
async function generateContextWithCaching(
  sourceText: string,
  memoryText: string,
  client: AnthropicClient,
  cache: SourceDocumentCache,
): Promise<string> {
  const sourceHash = xxhash64(sourceText);

  // The document block is marked for caching via cache_control
  const messages = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `<document>\n${sourceText}\n</document>`,
          cache_control: { type: "ephemeral" },
        },
        {
          type: "text",
          text: `Here is the chunk we want to situate within the whole document:\n<chunk>\n${memoryText}\n</chunk>\n\nPlease give a short succinct context to situate this chunk within the overall document for the purposes of improving search retrieval of the chunk. Answer only with the succinct context and nothing else.`,
        },
      ],
    },
  ];

  const response = await client.create({
    messages,
    max_tokens: 150,
    temperature: 0,
  });

  cache.set(sourceHash, {
    sourceHash,
    sourceLength: sourceText.length,
    cachedAt: Date.now(),
    ttl: 3600000,
    hitCount: 0,
  });

  return response.content[0].text;
}
```

### Batch Processing

When multiple memories come from the same source (decomposed memories, multi-message auto-capture), batch them to maximize prompt cache utilization:

```typescript
async function generateContextBatch(
  sourceText: string,
  memories: string[],
  config: ContextualRetrievalConfig,
  deps: Dependencies,
): Promise<Map<string, string>> {
  const results = new Map<string, string>();
  const concurrency = config.contextConcurrency ?? 4;

  // Process in parallel with concurrency limit
  // This matches the extraction concurrency pattern in extractor.ts
  const chunks = chunkArray(memories, concurrency);
  for (const batch of chunks) {
    const batchResults = await Promise.allSettled(
      batch.map((memoryText) =>
        generateContext(
          {
            sourceText,
            memoryText,
            agentId: config.agentId,
          },
          config,
          deps,
        ),
      ),
    );

    for (let i = 0; i < batch.length; i++) {
      const result = batchResults[i];
      if (result.status === "fulfilled") {
        results.set(batch[i], result.value.context);
      }
      // Failures silently skipped -- memory stored without context
    }
  }

  return results;
}
```

## Output Validation

Generated context is validated before use:

```typescript
function validateContext(
  context: string,
  memoryText: string,
  config: ContextualRetrievalConfig,
): boolean {
  // Estimate tokens (conservative 4 chars/token, matching embeddings.ts pattern)
  const estimatedTokens = context.length / 4;

  // Must be within configured bounds
  if (estimatedTokens < (config.minContextLength ?? 20)) return false;
  if (estimatedTokens > (config.maxContextLength ?? 150)) return false;

  // Must not be empty or just whitespace
  if (!context.trim()) return false;

  // Must not repeat the memory text verbatim
  // (indicates model failure -- just echoed the chunk)
  if (context.trim() === memoryText.trim()) return false;

  return true;
}
```

## Contextual Text Assembly

```typescript
function buildContextualText(context: string, memoryText: string): string {
  // Format: "{context}: {original_text}"
  // The colon+space separator allows BM25 to match both parts independently
  return `${context.trim()}: ${memoryText}`;
}
```

## Integration into Existing Hooks

### `agent_end` hook modification (`plugin-hooks.ts`)

The auto-capture path passes the compacted conversation text as source context:

```typescript
// In plugin-hooks.ts, agent_end handler:

// Existing: extract and store memories from conversation
const compactedText = buildCompactedText(messages);
const memories = await runAutoCapture(compactedText, messages, agentId, sessionKey);

// The compactedText is now threaded through to context generation
// inside runAutoCapture, before storeMemory calls
```

### Auto-capture pipeline modification (`auto-capture.ts`)

```typescript
// In runAutoCapture, after importance rating and decomposition:

if (config.contextualRetrieval.enabled) {
  const contextualized = await generateContextBatch(
    compactedText, // source = compacted conversation
    memories.map((m) => m.text),
    config.contextualRetrieval,
    deps,
  );

  for (const memory of memories) {
    const context = contextualized.get(memory.text);
    if (context) {
      memory.contextualContext = context;
      memory.contextualText = buildContextualText(context, memory.text);
    }
  }
}

// Continue with existing storage pipeline (now stores contextual fields too)
```

### Decomposition integration (`extractor-decompose.ts`)

When `decomposeIntoAtomicFacts()` splits a multi-entity memory:

```typescript
// The parent memory text is the ideal source context for atomic facts
for (const atomicFact of atomicFacts) {
  if (config.contextualRetrieval.enabled) {
    try {
      const result = await generateContext(
        {
          sourceText: parentMemoryText, // the pre-decomposition text
          memoryText: atomicFact.text,
          agentId,
        },
        config.contextualRetrieval,
        deps,
      );

      atomicFact.contextualContext = result.context;
      atomicFact.contextualText = result.contextualText;
    } catch {
      // Graceful degradation
    }
  }
}
```

### Explicit `memory_store` tool path (`plugin-tools.ts`)

```typescript
// When user explicitly says "remember X":
// Source text = the full user message

async function handleExplicitMemory(userMessage: string, memoryText: string, agentId: string) {
  let contextualFields = {};

  if (config.contextualRetrieval.enabled && userMessage.length > memoryText.length * 1.5) {
    try {
      const result = await generateContext(
        {
          sourceText: userMessage,
          memoryText,
          agentId,
        },
        config.contextualRetrieval,
        deps,
      );

      contextualFields = {
        contextualContext: result.context,
        contextualText: result.contextualText,
        contextGenModel: result.model,
        contextGenAt: new Date().toISOString(),
      };
    } catch {
      // Graceful degradation
    }
  }

  // Embed both original and contextual (if available)
  const embedding = await embed(memoryText);
  const contextualEmbedding = contextualFields.contextualText
    ? await embed(contextualFields.contextualText)
    : undefined;

  await db.storeMemory({
    text: memoryText,
    embedding,
    contextualEmbedding,
    ...contextualFields,
    agentId,
  });
}
```

## Metrics and Observability

```typescript
interface ContextGenerationMetrics {
  totalGenerated: number;
  cacheHits: number;
  cacheMisses: number;
  failures: number;
  avgLatencyMs: number;
  avgContextTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  skippedNoSource: number; // Skipped: no viable source text
  skippedSourceTooShort: number; // Skipped: source < 2x memory
  skippedValidationFail: number; // Skipped: output validation failed
}
```

Metrics are tracked in the existing `MetricsCollector` system and logged at the configured interval. The metrics follow the same pattern as extraction metrics in `extractor.ts`.
