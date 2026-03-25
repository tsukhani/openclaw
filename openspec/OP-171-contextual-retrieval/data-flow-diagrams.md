# Data Flow Diagrams

## 1. Context Generation Pipeline (Write Path)

```mermaid
sequenceDiagram
    participant U as User/AutoCapture
    participant H as PluginHooks
    participant AC as AutoCapture
    participant CG as ContextGenerator
    participant CC as ContextCache
    participant E as Embeddings
    participant N as Neo4jClient

    U->>H: agent_end hook (conversation complete)
    H->>AC: runAutoCapture(compactedText, messages)
    AC->>AC: passesAttentionGate()
    AC->>AC: rateImportance()
    AC->>AC: decomposeIntoAtomicFacts()
    Note over AC: parentText becomes sourceText<br/>for decomposed memories

    loop For each memory
        AC->>CG: generateContext(sourceText, memoryText)
        CG->>CC: check resultCache(xxhash64(source + mem))

        alt Cache hit
            CC-->>CG: cached context
        else Cache miss
            CG->>CG: Build prompt<br/>(document + chunk template)
            CG->>CG: Call LLM<br/>(haiku-4.5 / local model)
            CG->>CG: validateContext()<br/>(50-100 tokens, no echo)
            CG->>CC: cache result
        end

        CG-->>AC: ContextGenerationResult

        AC->>AC: buildContextualText<br/>("{context}: {text}")

        par Dual Embedding
            AC->>E: embed(text) -> embedding
            AC->>E: embed(contextualText) -> contextualEmbedding
        end

        AC->>N: storeMemory({<br/>  text, embedding,<br/>  contextualText,<br/>  contextualEmbedding,<br/>  contextualContext,<br/>  contextGenModel,<br/>  contextGenAt<br/>})
    end

    Note over N: Neo4j auto-indexes:<br/>HNSW on embedding<br/>HNSW on contextualEmbedding<br/>Fulltext on text<br/>Fulltext on contextualText
```

## 2. Hybrid Retrieval Pipeline (Read Path)

```mermaid
sequenceDiagram
    participant Q as Query (memory_recall)
    participant S as Search Orchestrator
    participant E as Embeddings
    participant V1 as VectorSearch (original)
    participant V2 as VectorSearch (contextual)
    participant B1 as BM25Search (original)
    participant B2 as BM25Search (contextual)
    participant G as GraphSearch
    participant F as FreshnessSignal
    participant BL as Blender
    participant RRF as RRF Fusion
    participant R as Reranker

    Q->>S: hybridSearch(query, limit, agentId)
    S->>S: classifyQuery(query)
    S->>E: embed(query) -> queryEmbedding

    par Signal Collection (5 parallel queries)
        S->>V1: vectorSearch(queryEmb, memory_embedding_index)
        V1-->>S: originalVectorResults

        S->>V2: contextualVectorSearch(queryEmb, memory_contextual_embedding_index)
        V2-->>S: contextualVectorResults

        S->>B1: bm25Search(query, memory_fulltext_index)
        B1-->>S: originalBm25Results

        S->>B2: contextualBm25Search(query, memory_contextual_fulltext_index)
        B2-->>S: contextualBm25Results

        S->>G: entityGraphSearch(query, queryEmb)
        G-->>S: graphResults
    end

    S->>BL: blendVectorResults(original, contextual, weight=0.7)
    BL-->>S: blendedVectorSignal

    S->>BL: blendBm25Results(original, contextual, weight=0.7)
    BL-->>S: blendedBm25Signal

    S->>F: buildFreshnessSignal(allResults)
    F-->>S: freshnessSignal

    S->>RRF: fuseWithConfidenceRRF(<br/>  [vectorSignal, bm25Signal, graphSignal, freshnessSignal],<br/>  [w_vec, w_bm25, w_graph, w_fresh]<br/>)
    RRF-->>S: fusedResults

    alt Reranker enabled
        S->>R: rerank(fusedResults, query)
        Note over R: Uses contextualText for<br/>cross-encoder when available
        R-->>S: rerankedResults
    end

    S-->>Q: final results with contextualContext metadata
```

## 3. Sub-Signal Blending Detail

```mermaid
flowchart LR
    subgraph Vector Signal
        V1[Original HNSW<br/>score x 0.3] --> BLEND_V[Blend by ID]
        V2[Contextual HNSW<br/>score x 0.7] --> BLEND_V
        BLEND_V --> VS[Blended Vector<br/>Signal]
    end

    subgraph BM25 Signal
        B1[Original Fulltext<br/>score x 0.3] --> BLEND_B[Blend by ID]
        B2[Contextual Fulltext<br/>score x 0.7] --> BLEND_B
        BLEND_B --> BS[Blended BM25<br/>Signal]
    end

    subgraph Unchanged Signals
        GS[Graph Traversal<br/>Signal]
        FS[Freshness/Temporal<br/>Signal]
    end

    VS --> RRF[Confidence-Weighted<br/>RRF Fusion<br/>k=60]
    BS --> RRF
    GS --> RRF
    FS --> RRF

    RRF --> RANK[Reranker<br/>optional]
    RANK --> OUT[Final Results]
```

## 4. Memory Sources and Context Recovery

```mermaid
flowchart TD
    subgraph Memory Origins
        AC[Auto-Capture<br/>source: agent_end hook]
        US[User Explicit<br/>source: 'remember X']
        DC[Decomposed<br/>source: parent memory]
        IM[Import<br/>source: file/document]
        MW[Memory Watcher<br/>source: context window]
    end

    subgraph Source Text Strategy
        AC -->|compactedText| SRC[Source Text<br/>for Context Gen]
        US -->|full user message| SRC
        DC -->|parent memory text| SRC
        IM -->|full document| SRC
        MW -->|context window| SRC
    end

    subgraph Source Recovery for Migration
        EP[Episode Nodes<br/>EPISODE_SOURCE rel]
        PM[Parent Memory<br/>DERIVED_FROM rel]
        TN[Temporal Neighbors<br/>same-minute memories]
        EN[Entity Context<br/>related entity descriptions]
    end

    SRC --> CG[Context Generator]
    EP -->|Strategy 1| CG
    PM -->|Strategy 2| CG
    TN -->|Strategy 3| CG
    EN -->|Strategy 4 fallback| CG

    CG --> CTX[Generated Context<br/>50-100 tokens]
    CTX --> CT[contextualText<br/> = context + ': ' + text]
```

## 5. Sleep Cycle Integration

```mermaid
flowchart TD
    SC[Sleep Cycle Starts<br/>cron or manual trigger]

    SC --> P1[Phase 1: Dedup Scan]
    P1 --> P2[Phase 2: Extraction]

    subgraph Phase 2 Enhanced
        P2 --> P2a[2a: Entity Extraction]
        P2 --> P2b[2b: Relationship Extraction]
        P2 --> P2c[2c: Decomposition]
        P2c -->|parent text as source| CTX_GEN[Context Generation<br/>for decomposed facts]
    end

    P2 --> P3[Phase 3: Conflict Detection]
    P3 --> P4[Phase 4: Temporal Decay]
    P4 --> P5[Phase 5: Community Detection]
    P5 --> P6[Phase 6: Metrics]
    P6 --> P7[Phase 7: Cleanup]

    P7 --> CTX_BACKFILL[Phase 8 NEW:<br/>Contextual Backfill<br/>- Process memories without context<br/>- Use episode/neighbor recovery<br/>- Batch with prompt caching<br/>- Low priority, rate-limited]

    CTX_BACKFILL --> DONE[Sleep Cycle Complete]
```

## 6. Prompt Caching Flow (Anthropic API)

```mermaid
sequenceDiagram
    participant CG as ContextGenerator
    participant SC as SourceCache
    participant API as Anthropic API

    Note over CG: Processing batch of memories<br/>from same conversation

    CG->>SC: has(xxhash64(conversationText))

    alt First memory from this conversation
        SC-->>CG: cache miss
        CG->>API: create({<br/>  messages: [{<br/>    content: [<br/>      { text: '<document>...', cache_control: 'ephemeral' },<br/>      { text: '<chunk>memory1</chunk>...' }<br/>    ]<br/>  }],<br/>  max_tokens: 150<br/>})
        Note over API: Caches the <document> block<br/>(~98.5% cost reduction<br/>for subsequent calls)
        API-->>CG: context for memory1
        CG->>SC: set(hash, { cachedAt, ttl: 1h })
    else Subsequent memory from same conversation
        SC-->>CG: cache hit (document already cached)
        CG->>API: create({<br/>  messages: [{<br/>    content: [<br/>      { text: '<document>...', cache_control: 'ephemeral' },<br/>      { text: '<chunk>memory2</chunk>...' }<br/>    ]<br/>  }]<br/>})
        Note over API: Reads document from cache<br/>Only charges for chunk + output
        API-->>CG: context for memory2
    end
```

## 7. Migration Pipeline

```mermaid
flowchart TD
    START[openclaw memory migrate-contextual]

    START --> PHASE[Select Phase]

    PHASE -->|--phase indexes| IX[Create Contextual Indexes<br/>HNSW + Fulltext]
    IX --> IX_VERIFY[Verify indexes ONLINE]

    PHASE -->|--phase migrate| QUERY[Query memories<br/>WHERE contextualEmbedding IS NULL<br/>ORDER BY importance DESC]

    QUERY --> BATCH[Fetch batch of N memories]

    BATCH --> FIND[Find source text<br/>1. Episode nodes<br/>2. Parent memory<br/>3. Temporal neighbors<br/>4. Entity context]

    FIND -->|source found| GEN[Generate context via LLM]
    FIND -->|no source| SKIP[Skip, increment skipped counter]

    GEN --> EMBED[Embed contextualText]
    EMBED --> UPDATE[updateMemoryContext()]
    UPDATE --> NEXT{More batches?}

    SKIP --> NEXT

    NEXT -->|yes| BATCH
    NEXT -->|no| STATS[Report: processed, succeeded,<br/>failed, skipped, cost]

    PHASE -->|--phase validate| VAL[Validate Migration]
    VAL --> VAL_CHECK[Check:<br/>- contextual field consistency<br/>- embedding dimensions<br/>- index queryability<br/>- coverage percentage]
    VAL_CHECK --> VAL_REPORT[Report: healthy / needs-attention]
```
