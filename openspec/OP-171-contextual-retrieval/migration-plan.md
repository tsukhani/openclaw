# Migration Plan

## Overview

Existing memories lack contextual fields. This migration plan describes how to backfill contextual data for existing memories without disrupting the running system.

## Migration Strategy: Lazy + Background Batch

Two complementary approaches:

1. **Background batch**: Explicit migration command processes existing memories in priority order
2. **Lazy migration**: Queries that return memories without context trigger async context generation (non-blocking, best-effort)
3. **Sleep cycle phase**: Ongoing backfill during consolidation runs

## Pre-Migration Checklist

- [ ] Neo4j is accessible and healthy
- [ ] Context generation LLM is configured and reachable
- [ ] Embedding provider is accessible
- [ ] Sufficient API budget (estimate: ~$0.015/1000 memories with prompt caching)
- [ ] `contextualRetrieval.enabled` is set to `true` in config
- [ ] Contextual indexes created (Phase 1)

## Phase 1: Index Creation

Create contextual indexes before populating data:

```bash
openclaw memory migrate-contextual --phase indexes --agent <agentId>
```

This runs:

1. `ensureIndexes()` with contextual retrieval enabled
2. Verifies indexes are in `ONLINE` state
3. No data is modified

**Duration**: < 30 seconds (index creation is instant when empty)

## Phase 2: Context Generation + Embedding

### Batch Processing

```bash
openclaw memory migrate-contextual --agent <agentId> \
  [--batch-size 50] \
  [--concurrency 4] \
  [--dry-run] \
  [--force] \
  [--category core,fact,preference] \
  [--min-importance 0.3]
```

**Parameters**:

- `--batch-size`: Memories per batch (default 50)
- `--concurrency`: Parallel context generation calls (default 4)
- `--dry-run`: Estimate cost and time without modifying data
- `--force`: Re-generate context even for memories that already have it
- `--category`: Only process specific categories
- `--min-importance`: Only process memories above importance threshold

### Processing Pipeline

```typescript
async function migrateContextual(agentId: string, options: MigrateOptions): Promise<MigrateResult> {
  const stats = { processed: 0, succeeded: 0, failed: 0, skipped: 0, cost: 0 };

  // 1. Count memories needing migration
  const totalCount = await countMemoriesNeedingContext(agentId, options);
  log.info(`Migration target: ${totalCount} memories`);

  if (options.dryRun) {
    const estimatedCost = totalCount * 0.000015; // ~$0.015/1000 with caching
    const estimatedTime = (totalCount / options.batchSize) * 2; // ~2s per batch
    log.info(`Dry run: estimated cost $${estimatedCost.toFixed(2)}, time ~${estimatedTime}s`);
    return { ...stats, total: totalCount, dryRun: true };
  }

  // 2. Process in batches
  let offset = 0;
  while (offset < totalCount) {
    const batch = await fetchMemoriesBatch(agentId, offset, options.batchSize, options);

    if (batch.length === 0) break;

    // 3. Group by session for prompt caching efficiency
    const bySession = groupBy(batch, (m) => m.sessionKey ?? "none");

    for (const [sessionKey, sessionMemories] of bySession) {
      // 4. Find source text for this group
      const sourceText = await findSourceText(sessionMemories[0], sessionKey);

      if (!sourceText) {
        stats.skipped += sessionMemories.length;
        continue;
      }

      // 5. Batch generate context (shares prompt cache within session)
      const contextResults = await generateContextBatch(
        sourceText,
        sessionMemories.map((m) => m.text),
        config.contextualRetrieval,
        deps,
      );

      for (const memory of sessionMemories) {
        const context = contextResults.get(memory.text);
        if (!context) {
          stats.skipped++;
          continue;
        }

        try {
          const contextualText = buildContextualText(context, memory.text);
          const contextualEmbedding = await embed(contextualText);

          await updateMemoryContext(memory.id, {
            contextualContext: context,
            contextualText,
            contextualEmbedding,
            contextGenModel: config.contextualRetrieval.contextModel,
            contextGenAt: new Date().toISOString(),
          });

          stats.succeeded++;
        } catch (error) {
          stats.failed++;
          log.warn(`Failed to migrate memory ${memory.id}`, { error });
        }

        stats.processed++;
      }
    }

    offset += options.batchSize;

    // Progress reporting
    const pct = Math.round((offset / totalCount) * 100);
    log.info(`Migration progress: ${pct}% (${stats.processed}/${totalCount})`);

    // Rate limiting pause between batches
    await sleep(100);
  }

  return stats;
}
```

### Source Text Recovery

The biggest challenge: existing memories may not have their original source text readily available. Recovery strategies, in priority order:

```typescript
async function findSourceText(memory: MemoryNode, sessionKey?: string): Promise<string | null> {
  // Strategy 1: Episode nodes (richest source, from episodic memory tier)
  // Uses EPISODE_SOURCE relationship or session+temporal proximity
  if (memory.sessionKey || sessionKey) {
    const episodes = await session.run(
      `MATCH (m:Memory {id: $memoryId})
       OPTIONAL MATCH (m)-[:EPISODE_SOURCE]->(e:Episode)
       WITH collect(e) AS linked, m
       CALL {
         WITH linked, m
         WITH linked, m WHERE size(linked) = 0
         MATCH (e:Episode {agentId: m.agentId, sessionKey: m.sessionKey})
         WHERE abs(duration.between(datetime(m.createdAt), datetime(e.timestamp)).seconds) < 300
         RETURN collect(e) AS nearby
       }
       WITH CASE WHEN size(linked) > 0 THEN linked ELSE nearby END AS episodes
       UNWIND episodes AS ep
       RETURN ep.text AS text ORDER BY ep.timestamp`,
      { memoryId: memory.id },
    );

    if (episodes.records.length > 0) {
      return episodes.records.map((r) => r.get("text")).join("\n");
    }
  }

  // Strategy 2: Parent memory (for decomposed atomic facts)
  const parent = await session.run(
    `MATCH (m:Memory {id: $memoryId})-[:DERIVED_FROM]->(p:Memory)
     RETURN p.text AS text`,
    { memoryId: memory.id },
  );
  if (parent.records.length > 0) {
    return parent.records[0].get("text");
  }

  // Strategy 3: Temporal neighbors
  // Find memories created within the same minute (likely from same conversation)
  const neighbors = await session.run(
    `MATCH (m:Memory {id: $memoryId})
     MATCH (n:Memory {agentId: m.agentId})
     WHERE n.id <> m.id
       AND abs(duration.between(datetime(m.createdAt), datetime(n.createdAt)).seconds) < 60
     RETURN n.text AS text
     ORDER BY n.createdAt
     LIMIT 20`,
    { memoryId: memory.id },
  );
  if (neighbors.records.length >= 3) {
    return neighbors.records.map((r) => r.get("text")).join("\n\n");
  }

  // Strategy 4: Self-context with entity descriptions (fallback)
  const entities = await session.run(
    `MATCH (m:Memory {id: $memoryId})<-[:EXTRACTED_FROM]-(e:Entity)
     RETURN e.name AS name, e.description AS description, e.type AS type
     LIMIT 10`,
    { memoryId: memory.id },
  );
  if (entities.records.length > 0) {
    const entityContext = entities.records
      .map((r) => `${r.get("name")}: ${r.get("description") ?? r.get("type")}`)
      .join(". ");
    return `${entityContext}\n\n${memory.text}`;
  }

  // No viable source text found
  return null;
}
```

### Priority Order

Process memories in this order for maximum early impact:

1. **High importance** (`importance >= 0.7`) -- most likely to be retrieved
2. **Core memories** (`category = "core"`) -- always injected at session start
3. **Recent memories** (`createdAt` within last 30 days) -- most likely relevant
4. **Frequently accessed** -- proven useful
5. **All remaining** -- sorted by `createdAt` descending

```cypher
MATCH (m:Memory {agentId: $agentId})
WHERE m.contextualEmbedding IS NULL
RETURN m
ORDER BY
  m.importance DESC,
  CASE m.category WHEN 'core' THEN 0 ELSE 1 END,
  m.createdAt DESC
SKIP $offset
LIMIT $limit
```

## Phase 3: Validation

After migration, verify data integrity:

```bash
openclaw memory migrate-contextual --phase validate --agent <agentId>
```

Checks:

1. All migrated memories have non-null `contextualText` AND `contextualEmbedding`
2. `contextualEmbedding` dimensions match the vector index
3. `contextualText` starts with `contextualContext` + ": "
4. Contextual indexes are queryable and return expected results

```typescript
async function validateMigration(agentId: string): Promise<ValidationResult> {
  // Count coverage
  const total = await countMemories(agentId);
  const withContext = await countMemoriesWithContext(agentId);
  const coverage = withContext / total;

  // Spot-check embedding dimensions
  const sample = await sampleMemoriesWithContext(agentId, 10);
  const expectedDims = config.embedding.dimensions ?? 1536;
  const dimMismatch = sample.filter((m) => m.contextualEmbedding.length !== expectedDims);

  // Test contextual index queryability
  const testQuery = await contextualVectorSearch(sample[0].contextualEmbedding, 5, agentId);
  const indexWorking = testQuery.length > 0;

  return {
    totalMemories: total,
    migratedMemories: withContext,
    coverage: `${(coverage * 100).toFixed(1)}%`,
    dimensionMismatches: dimMismatch.length,
    indexQueryable: indexWorking,
    status:
      coverage > 0.5 && dimMismatch.length === 0 && indexWorking ? "healthy" : "needs-attention",
  };
}
```

## Lazy Migration (Ongoing)

For memories that weren't migrated (no source text found during batch), attempt context generation when they're retrieved:

```typescript
// In search.ts, after hybridSearch returns results:

async function lazyMigrateResults(results: HybridSearchResult[]): Promise<void> {
  if (!config.contextualRetrieval?.enabled) return;

  const needsContext = results.filter((r) => !r.contextualContext);
  if (needsContext.length === 0) return;

  // Fire-and-forget: don't block the search response
  setImmediate(async () => {
    for (const result of needsContext.slice(0, 3)) {
      // Max 3 per query
      try {
        const sourceText = await findSourceText(result);
        if (!sourceText) continue;

        const context = await generateContext(
          {
            sourceText,
            memoryText: result.text,
            agentId: result.agentId,
          },
          config.contextualRetrieval,
          deps,
        );

        const contextualEmbedding = await embed(context.contextualText);

        await updateMemoryContext(result.id, {
          contextualContext: context.context,
          contextualText: context.contextualText,
          contextualEmbedding,
          contextGenModel: context.model,
          contextGenAt: new Date().toISOString(),
        });
      } catch {
        // Silent failure -- will retry on next retrieval
      }
    }
  });
}
```

## Sleep Cycle Backfill Phase

A new optional sleep cycle phase (Phase 8) that runs after existing consolidation:

```typescript
// In sleep-cycle.ts, add to phase list:

async function phaseContextualBackfill(
  agentId: string,
  config: ContextualRetrievalConfig,
): Promise<PhaseResult> {
  if (!config.enabled) return { skipped: true };

  // Process up to 100 memories per sleep cycle
  const result = await migrateContextual(agentId, {
    batchSize: 50,
    concurrency: 2, // Lower concurrency during sleep to reduce load
    minImportance: 0.3, // Only important memories
  });

  return {
    processed: result.processed,
    succeeded: result.succeeded,
    skipped: result.skipped,
  };
}
```

This provides gradual, automated backfill without requiring manual migration commands.

## Rollback Plan

If contextual retrieval causes issues:

### Level 1: Disable Feature (Instant, Non-Destructive)

Set `contextualRetrieval.enabled = false`:

- Immediately stops querying contextual indexes
- Stops generating context for new memories
- No data loss -- contextual fields remain in Neo4j
- Can re-enable at any time

### Level 2: Remove Contextual Data

```cypher
MATCH (m:Memory {agentId: $agentId})
WHERE m.contextualContext IS NOT NULL
REMOVE m.contextualContext, m.contextualText,
       m.contextualEmbedding, m.contextGenModel, m.contextGenAt
```

### Level 3: Drop Contextual Indexes

```cypher
DROP INDEX memory_contextual_embedding_index IF EXISTS;
DROP INDEX memory_contextual_fulltext_index IF EXISTS;
```

## Cost Estimation

### Per-Agent Migration Cost

| Agent Size | Memories | Est. Context Gen Cost | Est. Embedding Cost | Est. Time |
| ---------- | -------- | --------------------- | ------------------- | --------- |
| Small      | 1,000    | $0.015                | $0.004              | ~2 min    |
| Medium     | 10,000   | $0.15                 | $0.04               | ~20 min   |
| Large      | 50,000   | $0.75                 | $0.20               | ~100 min  |

Costs assume:

- Prompt caching enabled (98.5% cost reduction for same-session memories)
- Claude Haiku 4.5 pricing
- text-embedding-3-small pricing
- 4 concurrent context generation calls
- Some memories skipped (no source text available)
- Memories grouped by session for optimal prompt cache reuse

### Storage Overhead

~11 KB per memory (context text + contextual embedding). For 10,000 memories: ~110 MB additional Neo4j storage.
