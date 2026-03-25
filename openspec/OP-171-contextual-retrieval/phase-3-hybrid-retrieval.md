# Phase 3: Hybrid Retrieval with Rank Fusion

## Overview

The retrieval pipeline is enhanced to query both original and contextual indexes, blend the results, and feed them into the existing confidence-weighted RRF fusion engine. The reranker is updated to leverage contextual information for better relevance scoring.

## Signal Architecture (Before vs After)

### Before (4 signals)

```
+--------------------------------------------+
|              RRF Fusion                    |
|                                            |
|  Signal 1: Vector (HNSW)           w=1.0  |
|  Signal 2: BM25 (fulltext)         w=1.0  |
|  Signal 3: Graph (entity)          w=0.3  |
|  Signal 4: Freshness               w=0.2  |
+--------------------------------------------+
```

### After (4 signals, 2 enhanced with contextual sub-signals)

```
+--------------------------------------------+
|              RRF Fusion                    |
|                                            |
|  Signal 1: Vector (blended)        w=1.0  |
|    +-- 1a: Original HNSW     (0.3)        |
|    +-- 1b: Contextual HNSW   (0.7)        |
|                                            |
|  Signal 2: BM25 (blended)          w=1.0  |
|    +-- 2a: Original fulltext  (0.3)        |
|    +-- 2b: Contextual fulltext(0.7)        |
|                                            |
|  Signal 3: Graph (entity)          w=0.3  |
|  Signal 4: Freshness               w=0.2  |
+--------------------------------------------+
```

The contextual sub-signals are blended **before** entering RRF, keeping the overall RRF structure and weight tuning unchanged. This is a key design decision: it avoids increasing the number of RRF signals (which would require retuning all weights) and instead enhances existing signals.

## Sub-Signal Blending

### Vector Signal Blending

```typescript
function blendVectorResults(
  originalResults: SearchSignalResult[],
  contextualResults: SearchSignalResult[],
  contextualWeight: number = 0.7, // config: contextualRetrieval.signalWeight
): SearchSignalResult[] {
  // Fallback: no contextual results = use original at full weight
  if (contextualResults.length === 0) {
    return originalResults;
  }

  const merged = new Map<string, SearchSignalResult>();

  // Add original results with (1 - weight)
  for (const r of originalResults) {
    merged.set(r.id, {
      ...r,
      score: r.score * (1 - contextualWeight),
    });
  }

  // Blend in contextual results
  for (const r of contextualResults) {
    const existing = merged.get(r.id);
    if (existing) {
      existing.score += r.score * contextualWeight;
    } else {
      merged.set(r.id, {
        ...r,
        score: r.score * contextualWeight,
      });
    }
  }

  return [...merged.values()].sort((a, b) => b.score - a.score);
}
```

### BM25 Signal Blending

Same approach as vector blending. The BM25 scores are already min-max normalized (with 0.3 floor) in the existing `neo4j-client-search.ts` code, so blending is straightforward.

### Fallback When Contextual Indexes Are Empty

Zero degradation when contextual retrieval is enabled but migration hasn't run:

```typescript
function blendVectorResults(original, contextual, weight) {
  if (contextual.length === 0) {
    // No contextual results -- use original at full weight
    return original;
  }
  // ... normal blending
}
```

This also handles the case where an individual memory doesn't have contextual fields -- it simply won't appear in contextual results and will rely on its original signal scores.

## Search Pipeline Changes (`search.ts`)

### Modified `hybridSearch()`

```typescript
async function hybridSearch(
  query: string,
  limit: number,
  agentId: string,
  options: HybridSearchOptions,
): Promise<HybridSearchResult[]> {
  const queryType = classifyQuery(query);
  const weights = getAdaptiveWeights(queryType);

  // Embed query (single embedding, used for both original and contextual indexes)
  const queryEmbedding = await embed(query);

  // Determine contextual weight for this query type
  const contextualWeight = config.contextualRetrieval?.enabled
    ? (config.contextualRetrieval.signalWeightOverrides?.[queryType] ??
      config.contextualRetrieval.signalWeight ??
      0.7)
    : 0;

  // Collect all signals in parallel (5 queries instead of 4)
  const [originalVector, contextualVector, originalBm25, contextualBm25, graphResults] =
    await Promise.all([
      vectorSearch(queryEmbedding, limit * 2, agentId),
      contextualWeight > 0
        ? contextualVectorSearch(queryEmbedding, limit * 2, agentId)
        : Promise.resolve([]),
      bm25Search(query, limit * 2, agentId),
      contextualWeight > 0 ? contextualBm25Search(query, limit * 2, agentId) : Promise.resolve([]),
      options.graphEnabled !== false
        ? entityGraphSearch(query, queryEmbedding, limit, agentId, options)
        : Promise.resolve([]),
    ]);

  // Blend contextual sub-signals into their parent signals
  const vectorSignal = blendVectorResults(originalVector, contextualVector, contextualWeight);
  const bm25Signal = blendVectorResults(originalBm25, contextualBm25, contextualWeight);

  // Build freshness signal (unchanged)
  const allResults = deduplicateById([...vectorSignal, ...bm25Signal, ...graphResults]);
  const freshnessSignal = buildFreshnessSignal(allResults);

  // RRF fusion (unchanged algorithm)
  const fused = fuseWithConfidenceRRF(
    [vectorSignal, bm25Signal, graphResults, freshnessSignal],
    [weights.vectorW, weights.bm25W, weights.graphW, weights.freshnessW],
    { k: 60 },
  );

  // Reranking (enhanced with contextual text)
  if (config.reranker?.enabled) {
    return rerank(fused.slice(0, config.reranker.topK ?? 10), query, queryType);
  }

  return fused.slice(0, limit);
}
```

### New Query Functions (`neo4j-client-search.ts`)

```typescript
async function contextualVectorSearch(
  queryEmbedding: number[],
  limit: number,
  agentId: string,
): Promise<SearchSignalResult[]> {
  try {
    const result = await session.run(
      `CALL db.index.vector.queryNodes(
        'memory_contextual_embedding_index', $limit, $embedding
      ) YIELD node, score
      WHERE node.agentId = $agentId
        AND score >= $minScore
      RETURN node.id AS id,
             node.text AS text,
             node.contextualContext AS contextualContext,
             node.importance AS importance,
             node.category AS category,
             node.validFrom AS validFrom,
             node.createdAt AS createdAt,
             node.trustScore AS trustScore,
             score
      ORDER BY score DESC`,
      { limit, embedding: queryEmbedding, agentId, minScore: 0.1 },
    );

    return result.records.map(toSearchSignalResult);
  } catch (error) {
    // Index may not exist yet -- graceful fallback
    if (isIndexNotFoundError(error)) return [];
    throw error;
  }
}

async function contextualBm25Search(
  query: string,
  limit: number,
  agentId: string,
): Promise<SearchSignalResult[]> {
  try {
    const sanitizedQuery = escapeLucene(query);
    const result = await session.run(
      `CALL db.index.fulltext.queryNodes(
        'memory_contextual_fulltext_index', $query
      ) YIELD node, score
      WHERE node.agentId = $agentId
      WITH node, score
      ORDER BY score DESC
      LIMIT $limit
      RETURN node.id AS id,
             node.text AS text,
             node.contextualContext AS contextualContext,
             node.importance AS importance,
             node.category AS category,
             node.validFrom AS validFrom,
             node.createdAt AS createdAt,
             node.trustScore AS trustScore,
             score`,
      { query: sanitizedQuery, limit, agentId },
    );

    // Min-max normalize with 0.3 floor (same pattern as existing BM25)
    return normalizeScores(result.records.map(toSearchSignalResult), 0.3);
  } catch (error) {
    if (isIndexNotFoundError(error)) return [];
    throw error;
  }
}
```

## Adaptive Weight Tuning

The existing adaptive weights (from `classifyQuery()` in `search.ts`) are preserved. The contextual sub-signal blend weight (`signalWeight`) is independent of the RRF weights:

| Query Type            | Vector W | BM25 W | Graph W | Fresh W | Contextual Blend                              |
| --------------------- | -------- | ------ | ------- | ------- | --------------------------------------------- |
| short (1-2 words)     | 0.8      | 1.2    | 0.3     | 0.2     | 0.7                                           |
| entity (proper nouns) | 0.8      | 1.0    | 0.4     | 0.2     | 0.6 (entity names preserved in original)      |
| long (5+ words)       | 1.2      | 0.7    | 0.3     | 0.2     | 0.8 (context helps most with complex queries) |
| updates/current       | 1.0      | 1.0    | 0.3     | 0.6     | 0.7                                           |
| extraction (factual)  | 1.1      | 1.1    | 0.3     | 0.0     | 0.7                                           |
| causal (why/because)  | 0.9      | 0.7    | 0.5     | 0.1     | 0.7                                           |

For **entity queries**, the contextual blend is reduced because entity names are typically preserved in the original text. For **long queries**, it's increased because context disambiguation helps most with complex semantic queries.

## Reranker Enhancement (`reranker.ts`)

### Context-Aware Reranking

The reranker receives contextual information to make better relevance decisions:

```typescript
interface RerankerCandidate {
  id: string;
  text: string;
  contextualContext?: string; // NEW: context prefix
  score: number;
  validFrom?: string;
  category?: string;
}
```

### Local Cross-Encoder (`reranker-local.ts`)

For the local cross-encoder (default, ~100ms), the input is the **contextualText** when available, giving the model more signal:

```typescript
function prepareRerankerInput(candidate: RerankerCandidate): string {
  if (candidate.contextualContext) {
    return `${candidate.contextualContext}: ${candidate.text}`;
  }
  return candidate.text;
}
```

### LLM Reranker (`reranker-llm.ts`)

For the LLM reranker (used for temporal/causal queries), the context is included as additional metadata:

```typescript
function buildLLMRerankerPrompt(query: string, candidates: RerankerCandidate[]): string {
  const candidateList = candidates
    .map((c, i) => {
      let entry = `[${i + 1}] ${c.text}`;
      if (c.contextualContext) {
        entry += `\n    Context: ${c.contextualContext}`;
      }
      if (c.validFrom) {
        entry += `\n    Valid from: ${c.validFrom}`;
      }
      return entry;
    })
    .join("\n\n");

  return `Given the query: "${query}"

Rank these memories by relevance (most relevant first):

${candidateList}

Return only the numbers in order of relevance.`;
}
```

## Performance Characteristics

### Query Latency Impact

| Component                | Additional Latency | Notes                                         |
| ------------------------ | ------------------ | --------------------------------------------- |
| Contextual vector search | +5-15ms            | Parallel with original, Neo4j HNSW is fast    |
| Contextual BM25 search   | +2-5ms             | Parallel with original, inverted index lookup |
| Score blending           | <1ms               | In-memory map merge                           |
| Reranker (context-aware) | +0ms               | Same reranker, just longer input text         |
| **Total additional**     | **+5-15ms**        | Negligible -- all searches run in parallel    |

### Why Minimal Overhead

1. **Parallel execution**: All 5 search queries run concurrently via `Promise.all`
2. **Same query embedding**: The query doesn't need separate embedding for contextual search
3. **Blending is O(n)**: Simple map merge over result sets
4. **No extra LLM calls at query time**: Context was generated at write time
5. **Short-circuit**: When `contextualWeight === 0` or feature disabled, contextual queries are skipped entirely

## Reciprocal Rank Fusion (Unchanged)

The core RRF formula remains unchanged:

```
RRF_conf(d) = SUM_i( w_i * score_i(d) / (k + rank_i(d)) )
```

Where:

- `w_i` = signal weight (adaptive by query type)
- `score_i(d)` = normalized score for document d in signal i
- `k = 60` = rank smoothing constant
- `rank_i(d)` = rank position (1-indexed) of document d in signal i

The contextual enhancement happens **within** signals 1 and 2 (via blending), not at the RRF level. This preserves all existing RRF tuning, weight configurations, and the trust score multiplicative weight.

## Low Confidence Detection

The existing low confidence detection (flagged when top result found by single signal AND second result << top, threshold 0.35) continues to work unchanged. Contextual signals may actually reduce false low-confidence flags because they add disambiguation that reduces single-signal-only matches.

## Result Format

Search results include contextual metadata when available:

```typescript
interface HybridSearchResult {
  id: string;
  text: string;
  score: number;
  importance: number;
  category: string;
  validFrom?: string;
  createdAt: string;

  // New contextual fields
  contextualContext?: string; // The generated context prefix
  contextualScore?: number; // Score from contextual signals
  contextualContribution?: number; // How much context improved ranking

  // Existing signal metadata (unchanged)
  signals?: {
    vector: { rank: number; score: number };
    bm25: { rank: number; score: number };
    graph: { rank: number; score: number };
    freshness?: { rank: number; score: number };
  };
  rerankScore?: number;
  rrfScore?: number;
  lowConfidence?: boolean;
}
```

The `contextualContribution` field (optional, for diagnostics) shows the rank improvement from contextual signals:

```typescript
contextualContribution = (rankWithoutContextual - rankWithContextual) / rankWithoutContextual;
```

Positive values indicate context improved the result's ranking; negative values indicate context hurt it (rare but possible for highly ambiguous contexts).
