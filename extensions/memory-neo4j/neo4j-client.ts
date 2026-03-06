/**
 * Neo4j driver wrapper for memory-neo4j plugin.
 *
 * Handles connection management and delegates all heavy operations to focused
 * sub-modules (indexes, memory, search, entity, sleep).
 *
 * Patterns adapted from ontology project Neo4j client
 * with retry-on-transient and MERGE idempotency.
 */

import neo4j, { type Driver } from "neo4j-driver";
import type { ExtractionConfig } from "./config.js";
import * as Entity from "./neo4j-client-entity.js";
import * as Indexes from "./neo4j-client-indexes.js";
import * as Memory from "./neo4j-client-memory.js";
import * as Search from "./neo4j-client-search.js";
import * as Sleep from "./neo4j-client-sleep.js";
import type { ExtractionStatus, Logger, SearchSignalResult, StoreMemoryInput } from "./schema.js";
import { escapeLucene } from "./schema.js";
import { detectCredential } from "./sleep-cycle-types.js";

// Retry configuration for transient Neo4j errors (deadlocks, etc.)
const TRANSIENT_RETRY_ATTEMPTS = 3;
const TRANSIENT_RETRY_BASE_DELAY_MS = 500;

// ============================================================================
// Neo4j Memory Client
// ============================================================================

export class Neo4jMemoryClient {
  private driver: Driver | null = null;
  private initPromise: Promise<void> | null = null;
  private indexesReady = false;

  constructor(
    private readonly uri: string,
    private readonly username: string,
    private readonly password: string,
    private readonly dimensions: number,
    private readonly logger: Logger,
  ) {}

  // --------------------------------------------------------------------------
  // Connection & Initialization
  // --------------------------------------------------------------------------

  async ensureInitialized(): Promise<void> {
    if (this.driver && this.indexesReady) {
      return;
    }
    if (this.initPromise) {
      return this.initPromise;
    }
    this.initPromise = this.doInitialize().catch((err) => {
      // Reset so subsequent calls retry instead of returning cached rejection
      this.initPromise = null;
      throw err;
    });
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    this.driver = neo4j.driver(this.uri, neo4j.auth.basic(this.username, this.password), {
      disableLosslessIntegers: true,
    });

    // Verify connection
    const session = this.driver.session();
    try {
      await session.run("RETURN 1");
      const redactedUri = (() => {
        try {
          const u = new URL(this.uri);
          if (u.password) u.password = "***";
          return u.toString();
        } catch {
          return this.uri.replace(/:\/\/[^:]+:[^@]+@/, "://<redacted>@");
        }
      })();
      this.logger.info(`memory-neo4j: connected to ${redactedUri}`);
    } finally {
      await session.close();
    }

    // Create indexes
    await Indexes.ensureIndexes(this.driver, this.dimensions, this.logger);
    this.indexesReady = true;

    // Backfill temporal fields for pre-existing memories and entity relationships (idempotent)
    const migrateSession = this.driver.session();
    try {
      await Sleep.migrateTemporalFields(migrateSession);
      await Sleep.migrateEntityRelationshipTemporalFields(migrateSession);
    } finally {
      await migrateSession.close();
    }
  }

  async close(): Promise<void> {
    if (this.driver) {
      await this.driver.close();
      this.driver = null;
      this.indexesReady = false;
      this.initPromise = null;
      this.logger.info("memory-neo4j: connection closed");
    }
  }

  /**
   * Run a raw Cypher query and return records as plain objects.
   * Keys in the RETURN clause become object properties.
   */
  async runQuery<T extends Record<string, unknown>>(
    cypher: string,
    params: Record<string, unknown> = {},
  ): Promise<T[]> {
    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      const result = await session.run(cypher, params);
      return result.records.map((r) => {
        const obj: Record<string, unknown> = {};
        for (const key of r.keys) {
          obj[key as string] = r.get(key as string);
        }
        return obj as T;
      });
    } finally {
      await session.close();
    }
  }

  async verifyConnection(): Promise<boolean> {
    if (!this.driver) {
      return false;
    }
    const session = this.driver.session();
    try {
      await session.run("RETURN 1");
      return true;
    } catch (err) {
      this.logger.error(`memory-neo4j: connection verification failed: ${String(err)}`);
      return false;
    } finally {
      await session.close();
    }
  }

  // --------------------------------------------------------------------------
  // Memory CRUD
  // --------------------------------------------------------------------------

  /**
   * Persist a memory node to Neo4j.
   *
   * Returns the stored memory ID on success.
   * If the text contains a credential-like pattern (OP-97), the memory is NOT
   * stored and a sentinel ID of the form `"blocked:credential:<timestamp>"` is
   * returned so callers do not crash. A warning is logged in this case.
   */
  async storeMemory(input: StoreMemoryInput): Promise<string> {
    await this.ensureInitialized();
    // OP-97: Write-time credential scan — reject storage of secrets
    const credentialMatch = detectCredential(input.text);
    if (credentialMatch !== null) {
      this.logger.warn(
        `memory-neo4j: storeMemory blocked — text contains a potential ${credentialMatch}. Refusing to persist.`,
      );
      // Return a sentinel ID so callers do not crash; the memory is not stored.
      return `blocked:credential:${Date.now()}`;
    }
    return this.retryOnTransient(async () => {
      const session = this.driver!.session();
      try {
        return await Memory.storeMemory(session, input);
      } finally {
        await session.close();
      }
    });
  }

  /**
   * Store multiple memories in a single Cypher UNWIND statement (OP-107).
   *
   * Used by Phase 8 tip generation to batch-store all generated tips after
   * a single embedBatch call, reducing 50×3 serial roundtrips to 2 operations.
   * Applies the same write-time credential scan as storeMemory(); any tip
   * containing a credential is silently skipped (not stored).
   *
   * @returns Number of memories actually stored
   */
  async storeManyMemories(inputs: StoreMemoryInput[]): Promise<number> {
    if (inputs.length === 0) return 0;
    await this.ensureInitialized();

    // OP-97: Write-time credential scan — filter out any secrets before persisting
    const safe = inputs.filter((inp) => {
      const match = detectCredential(inp.text);
      if (match !== null) {
        this.logger.warn(
          `memory-neo4j: storeManyMemories blocked entry — text contains a potential ${match}. Skipping.`,
        );
        return false;
      }
      // Validate embedding dimensions when a non-empty embedding is provided
      if (inp.embedding.length > 0 && inp.embedding.length !== this.dimensions) {
        this.logger.warn(
          `memory-neo4j: storeManyMemories blocked entry — embedding has ${inp.embedding.length} dims, expected ${this.dimensions}. Skipping.`,
        );
        return false;
      }
      return true;
    });

    if (safe.length === 0) return 0;

    return this.retryOnTransient(async () => {
      const session = this.driver!.session();
      try {
        return await Memory.storeManyMemories(session, safe);
      } finally {
        await session.close();
      }
    });
  }

  async deleteMemory(id: string, agentId?: string): Promise<boolean> {
    await this.ensureInitialized();
    // Validate UUID format to prevent injection
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(id)) {
      throw new Error(`Invalid memory ID format: ${id}`);
    }

    return this.retryOnTransient(async () => {
      const session = this.driver!.session();
      try {
        return await Memory.deleteMemory(session, id, agentId);
      } finally {
        await session.close();
      }
    });
  }

  async countMemories(agentId?: string): Promise<number> {
    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      return await Memory.countMemories(session, agentId);
    } finally {
      await session.close();
    }
  }

  /**
   * Get memory counts grouped by agentId and category.
   * Returns stats for building a summary table.
   */
  async getMemoryStats(
    agentId?: string,
  ): Promise<Array<{ agentId: string; category: string; count: number; avgImportance: number }>> {
    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      return await Memory.getMemoryStats(session, agentId);
    } finally {
      await session.close();
    }
  }

  /**
   * List memories by category, ordered by importance (descending).
   * Used for loading core memories at session start.
   */
  async listByCategory(
    category: string,
    limit: number,
    minImportance: number = 0,
    agentId?: string,
  ): Promise<{ id: string; text: string; category: string; importance: number }[]> {
    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      return await Memory.listByCategory(session, category, limit, minImportance, agentId);
    } finally {
      await session.close();
    }
  }

  /**
   * Load all core memories for context injection.
   *
   * Core memories are user-curated (created via explicit "remember" requests)
   * with importance locked at 1.0, so there is no meaningful ordering.
   * All core memories are returned — the user manages the size.
   */
  async listCoreForInjection(
    agentId?: string,
  ): Promise<{ id: string; text: string; category: string; importance: number }[]> {
    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      return await Memory.listCoreForInjection(session, agentId);
    } finally {
      await session.close();
    }
  }

  // --------------------------------------------------------------------------
  // Search Signals
  // --------------------------------------------------------------------------

  /**
   * Signal 1: HNSW vector similarity search.
   * Returns memories ranked by cosine similarity to the query embedding.
   */
  async vectorSearch(
    embedding: number[],
    limit: number,
    minScore: number = 0.1,
    agentId?: string,
    includeExpired?: boolean,
    asOf?: string,
  ): Promise<SearchSignalResult[]> {
    await this.ensureInitialized();
    try {
      return await this.retryOnTransient(async () => {
        const session = this.driver!.session();
        try {
          return await Search.vectorSearch(
            session,
            embedding,
            limit,
            minScore,
            agentId,
            includeExpired,
            asOf,
          );
        } finally {
          await session.close();
        }
      });
    } catch (err) {
      // Graceful degradation: return empty if vector index isn't ready or all retries exhausted
      this.logger.warn(`memory-neo4j: vector search failed: ${String(err)}`);
      return [];
    }
  }

  /**
   * Signal 2: Lucene BM25 full-text keyword search.
   * Returns memories ranked by BM25 relevance score.
   */
  async bm25Search(
    query: string,
    limit: number,
    agentId?: string,
    includeExpired?: boolean,
    asOf?: string,
  ): Promise<SearchSignalResult[]> {
    await this.ensureInitialized();
    const escaped = escapeLucene(query);
    if (!escaped.trim()) {
      return [];
    }

    try {
      return await this.retryOnTransient(async () => {
        const session = this.driver!.session();
        try {
          return await Search.bm25Search(session, escaped, limit, agentId, includeExpired, asOf);
        } finally {
          await session.close();
        }
      });
    } catch (err) {
      // Graceful degradation: return empty if all retries exhausted
      this.logger.warn(`memory-neo4j: BM25 search failed: ${String(err)}`);
      return [];
    }
  }

  /**
   * Signal 3: Graph traversal search.
   *
   * 1. Find entities matching the query via fulltext index
   * 2. Find memories directly connected to those entities (MENTIONS)
   * 3. 1-hop spreading activation through entity relationships
   *
   * Returns memories with graph-based relevance scores.
   */
  async graphSearch(
    query: string,
    limit: number,
    firingThreshold: number = 0.3,
    agentId?: string,
    maxHops: number = 2,
    includeExpired?: boolean,
    asOf?: string,
    seedCap?: number,
    relTypes?: string[] | null,
  ): Promise<SearchSignalResult[]> {
    await this.ensureInitialized();
    const escaped = escapeLucene(query);
    if (!escaped.trim()) {
      return [];
    }

    try {
      return await this.retryOnTransient(async () => {
        const session = this.driver!.session();
        try {
          return await Search.graphSearch(
            session,
            escaped,
            limit,
            firingThreshold,
            agentId,
            maxHops,
            includeExpired,
            asOf,
            seedCap,
            relTypes,
          );
        } finally {
          await session.close();
        }
      });
    } catch (err) {
      // Graceful degradation: return empty if all retries exhausted
      this.logger.warn(`memory-neo4j: graph search failed: ${String(err)}`);
      return [];
    }
  }

  /**
   * Find similar memories by vector similarity. Used for deduplication.
   * When agentId is provided, results are post-filtered to that agent
   * (HNSW indexes don't support pre-filtering, so we fetch extra candidates).
   */
  async findSimilar(
    embedding: number[],
    threshold: number = 0.95,
    limit: number = 1,
    agentId?: string,
  ): Promise<Array<{ id: string; text: string; score: number }>> {
    await this.ensureInitialized();
    try {
      return await this.retryOnTransient(async () => {
        const session = this.driver!.session();
        try {
          return await Search.findSimilar(session, embedding, threshold, limit, agentId);
        } finally {
          await session.close();
        }
      });
    } catch (err) {
      // If vector index isn't ready or all retries exhausted, return no duplicates (allow store)
      this.logger.debug?.(`memory-neo4j: similarity check failed: ${String(err)}`);
      return [];
    }
  }

  // --------------------------------------------------------------------------
  // Retrieval Tracking
  // --------------------------------------------------------------------------

  /**
   * Record retrieval events for memories. Called after search/recall.
   * Increments retrievalCount and updates lastRetrievedAt timestamp.
   */
  async recordRetrievals(memoryIds: string[]): Promise<void> {
    if (memoryIds.length === 0) {
      return;
    }

    await this.ensureInitialized();
    return this.retryOnTransient(async () => {
      const session = this.driver!.session();
      try {
        return await Search.recordRetrievals(session, memoryIds);
      } finally {
        await session.close();
      }
    });
  }

  // --------------------------------------------------------------------------
  // Layer 3: Task Metadata Operations
  // --------------------------------------------------------------------------

  /**
   * Find memories linked to a specific task ID.
   * Used by recall filter and sleep cycle to identify task-related memories.
   */
  async findMemoriesByTaskId(
    taskId: string,
    agentId?: string,
  ): Promise<Array<{ id: string; text: string; category: string; importance: number }>> {
    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      return await Memory.findMemoriesByTaskId(session, taskId, agentId);
    } finally {
      await session.close();
    }
  }

  /**
   * Bulk-clear taskId from memories (e.g., when the task-memory link is no longer needed).
   * Sets taskId to null rather than deleting the memory.
   */
  async clearTaskIdFromMemories(taskId: string, agentId?: string): Promise<number> {
    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      return await Memory.clearTaskIdFromMemories(session, taskId, agentId);
    } finally {
      await session.close();
    }
  }

  // --------------------------------------------------------------------------
  // Entity & Relationship Operations
  // --------------------------------------------------------------------------

  /**
   * Update the extraction status of a Memory node.
   * Optionally increments the extractionRetries counter (for transient failure tracking).
   */
  async updateExtractionStatus(
    id: string,
    status: ExtractionStatus,
    options?: { incrementRetries?: boolean },
  ): Promise<void> {
    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      return await Entity.updateExtractionStatus(session, id, status, options);
    } finally {
      await session.close();
    }
  }

  /**
   * Batch all entity operations from an extraction result into a single managed
   * transaction. Replaces the previous pattern of N individual session-per-call
   * operations with a single atomic write.
   */
  async batchEntityOperations(
    memoryId: string,
    entities: Array<{
      id: string;
      name: string;
      type: string;
      aliases?: string[];
      description?: string;
    }>,
    relationships: Array<{
      source: string;
      target: string;
      type: string;
      confidence: number;
    }>,
    tags: Array<{ name: string; category: string }>,
    category?: string,
  ): Promise<void> {
    await this.ensureInitialized();
    return this.retryOnTransient(async () => {
      const session = this.driver!.session();
      try {
        return await Entity.batchEntityOperations(
          session,
          memoryId,
          entities,
          relationships,
          tags,
          category,
        );
      } finally {
        await session.close();
      }
    });
  }

  /**
   * List memories with pending extraction status.
   * Used by the sleep cycle to batch-process extractions.
   */
  async listPendingExtractions(
    limit: number = 100,
    agentId?: string,
  ): Promise<Array<{ id: string; text: string; agentId: string; extractionRetries: number }>> {
    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      return await Entity.listPendingExtractions(session, limit, agentId);
    } finally {
      await session.close();
    }
  }

  /**
   * Count memories by extraction status.
   * Used for sleep cycle progress reporting.
   */
  async countByExtractionStatus(agentId?: string): Promise<Record<ExtractionStatus, number>> {
    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      return await Entity.countByExtractionStatus(session, agentId);
    } finally {
      await session.close();
    }
  }

  /**
   * List memories with completed extraction but no TAGGED relationships.
   * Used by the retroactive tagging phase to find memories that need tags.
   */
  async listUntaggedMemories(
    limit: number = 50,
    agentId?: string,
    maxRetries: number = 3,
  ): Promise<Array<{ id: string; text: string }>> {
    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      return await Entity.listUntaggedMemories(session, limit, agentId, maxRetries);
    } finally {
      await session.close();
    }
  }

  /**
   * Increment the tagging retry counter for a memory that failed retroactive tagging.
   * After maxRetries, listUntaggedMemories will skip it.
   */
  async incrementTaggingRetries(memoryId: string): Promise<void> {
    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      return await Entity.incrementTaggingRetries(session, memoryId);
    } finally {
      await session.close();
    }
  }

  // --------------------------------------------------------------------------
  // Sleep Cycle: Deduplication
  // --------------------------------------------------------------------------

  /**
   * Find clusters of near-duplicate memories by vector similarity.
   * Returns groups where each group contains memories that are duplicates of each other.
   */
  async findDuplicateClusters(
    threshold: number = 0.95,
    agentId?: string,
    returnSimilarities: boolean = false,
  ): Promise<
    Array<{
      memoryIds: string[];
      texts: string[];
      importances: number[];
      similarities?: Map<string, number>;
    }>
  > {
    await this.ensureInitialized();
    return Sleep.findDuplicateClusters(
      this.driver!,
      this.logger,
      (fn) => this.retryOnTransient(fn),
      threshold,
      agentId,
      returnSimilarities,
    );
  }

  /**
   * Merge duplicate memories by keeping the one with highest importance
   * and deleting the rest. Transfers MENTIONS relationships to the survivor.
   */
  async mergeMemoryCluster(
    memoryIds: string[],
    importances: number[],
  ): Promise<{ survivorId: string; deletedCount: number }> {
    await this.ensureInitialized();
    return this.retryOnTransient(async () => {
      const session = this.driver!.session();
      try {
        return await Sleep.mergeMemoryCluster(session, this.logger, memoryIds, importances);
      } finally {
        await session.close();
      }
    });
  }

  // --------------------------------------------------------------------------
  // Sleep Cycle: Decay & Pruning
  // --------------------------------------------------------------------------

  /**
   * Find memories that have decayed below the retention threshold.
   *
   * IMPORTANT: Core memories (category='core') and user-pinned memories
   * are EXEMPT from decay. They persist indefinitely regardless of age.
   */
  async findDecayedMemories(
    options: {
      retentionThreshold?: number;
      baseHalfLifeDays?: number;
      importanceMultiplier?: number;
      decayCurves?: Record<string, { halfLifeDays: number }>;
      agentId?: string;
      limit?: number;
    } = {},
  ): Promise<
    Array<{ id: string; text: string; importance: number; ageDays: number; decayScore: number }>
  > {
    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      return await Sleep.findDecayedMemories(session, options);
    } finally {
      await session.close();
    }
  }

  /** Delete decayed memories and decrement entity mention counts. */
  async pruneMemories(memoryIds: string[]): Promise<number> {
    if (memoryIds.length === 0) {
      return 0;
    }

    await this.ensureInitialized();
    return this.retryOnTransient(async () => {
      const session = this.driver!.session();
      try {
        return await Sleep.pruneMemories(session, memoryIds);
      } finally {
        await session.close();
      }
    });
  }

  // --------------------------------------------------------------------------
  // Sleep Cycle: Orphan Cleanup
  // --------------------------------------------------------------------------

  /** Find orphaned Entity nodes (no MENTIONS relationships from any Memory). */
  async findOrphanEntities(
    limit: number = 500,
  ): Promise<Array<{ id: string; name: string; type: string }>> {
    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      return await Sleep.findOrphanEntities(session, limit);
    } finally {
      await session.close();
    }
  }

  /** Delete orphaned entities and their relationships. */
  async deleteOrphanEntities(entityIds: string[]): Promise<number> {
    if (entityIds.length === 0) {
      return 0;
    }

    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      return await Sleep.deleteOrphanEntities(session, entityIds);
    } finally {
      await session.close();
    }
  }

  /** Find orphaned Tag nodes (no TAGGED relationships from any Memory). */
  async findOrphanTags(limit: number = 500): Promise<Array<{ id: string; name: string }>> {
    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      return await Sleep.findOrphanTags(session, limit);
    } finally {
      await session.close();
    }
  }

  /** Delete orphaned tags. */
  async deleteOrphanTags(tagIds: string[]): Promise<number> {
    if (tagIds.length === 0) {
      return 0;
    }

    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      return await Sleep.deleteOrphanTags(session, tagIds);
    } finally {
      await session.close();
    }
  }

  /**
   * Find tags with exactly 1 TAGGED relationship, older than minAgeDays.
   * Single-use tags add noise without providing useful cross-memory connections.
   */
  async findSingleUseTags(
    minAgeDays: number = 14,
    limit: number = 500,
  ): Promise<Array<{ id: string; name: string }>> {
    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      return await Sleep.findSingleUseTags(session, minAgeDays, limit);
    } finally {
      await session.close();
    }
  }

  // --------------------------------------------------------------------------
  // Sleep Cycle: Conflict Detection
  // --------------------------------------------------------------------------

  /**
   * Find memory pairs that share at least one entity (via MENTIONS relationships).
   * These are candidates for conflict resolution — the LLM decides if they truly conflict.
   * Excludes core memories (those are user-curated).
   */
  async findConflictingMemories(
    agentId?: string,
    limit: number = 50,
  ): Promise<
    Array<{
      memoryA: { id: string; text: string; importance: number; createdAt: string };
      memoryB: { id: string; text: string; importance: number; createdAt: string };
    }>
  > {
    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      return await Sleep.findConflictingMemories(session, agentId, limit);
    } finally {
      await session.close();
    }
  }

  // --------------------------------------------------------------------------
  // Pending Conflict Pairs (OP-125)
  // --------------------------------------------------------------------------

  /** Store a pending conflict pair for retry on the next sleep cycle. */
  async storePendingConflict(idA: string, idB: string): Promise<void> {
    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      return await Sleep.storePendingConflict(session, idA, idB);
    } finally {
      await session.close();
    }
  }

  /** Fetch all pending conflict pairs eligible for retry. */
  async fetchPendingConflicts(
    agentId?: string,
    limit: number = 50,
  ): Promise<
    Array<{
      memoryA: { id: string; text: string; importance: number; createdAt: string };
      memoryB: { id: string; text: string; importance: number; createdAt: string };
      retryCount: number;
    }>
  > {
    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      return await Sleep.fetchPendingConflicts(session, agentId, limit);
    } finally {
      await session.close();
    }
  }

  /** Remove the PENDING_CONFLICT relationship between two memories. */
  async clearPendingConflict(idA: string, idB: string): Promise<void> {
    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      return await Sleep.clearPendingConflict(session, idA, idB);
    } finally {
      await session.close();
    }
  }

  /** Increment the retry counter on a PENDING_CONFLICT relationship. */
  async incrementPendingConflictRetry(idA: string, idB: string): Promise<void> {
    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      return await Sleep.incrementPendingConflictRetry(session, idA, idB);
    } finally {
      await session.close();
    }
  }

  /**
   * Invalidate a memory by setting its importance to near-zero.
   * Used by conflict resolution to effectively retire the losing memory
   * without deleting it (it will be pruned naturally by the decay phase).
   */
  async invalidateMemory(id: string): Promise<void> {
    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      return await Sleep.invalidateMemory(session, id);
    } finally {
      await session.close();
    }
  }

  /**
   * Batch-invalidate multiple memories in a single Cypher query.
   * Prefer this over sequential invalidateMemory calls when retiring a list of IDs.
   */
  async invalidateMemories(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      return await Sleep.invalidateMemories(session, ids);
    } finally {
      await session.close();
    }
  }

  // --------------------------------------------------------------------------
  // Temporal Memory Operations
  // --------------------------------------------------------------------------

  /**
   * Supersede a memory: set its validUntil to now and record which memory
   * replaced it. Used by conflict detection when a newer memory updates/
   * contradicts an existing one.
   *
   * @param oldId  ID of the memory being superseded
   * @param newId  ID of the replacement memory
   */
  async supersedeMemory(oldId: string, newId: string): Promise<void> {
    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      return await Sleep.supersedeMemory(session, oldId, newId);
    } finally {
      await session.close();
    }
  }

  /**
   * Migrate existing memories to include temporal fields.
   * Sets validFrom = COALESCE(originalCreatedAt, createdAt) and
   * validUntil = null, supersededBy = null for memories that lack these fields.
   *
   * @returns Number of memories updated
   */
  async migrateTemporalFields(): Promise<number> {
    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      return await Sleep.migrateTemporalFields(session);
    } finally {
      await session.close();
    }
  }

  /**
   * Close a specific entity-to-entity relationship by setting validUntil.
   * Use this when a relationship is known to be superseded or contradicted by
   * newer information (e.g. a person changed employer).
   *
   * For bulk cleanup of relationships no longer supported by any active memory,
   * use expireOrphanedEntityRelationships instead.
   *
   * @param entityAName  Canonical name of the source entity (will be lowercased)
   * @param entityBName  Canonical name of the target entity (will be lowercased)
   * @param relType      Relationship type (must be in ALLOWED_RELATIONSHIP_TYPES)
   * @param closedAt     ISO-8601 timestamp; defaults to now
   * @returns            true if at least one relationship was closed
   */
  async closeEntityRelationship(
    entityAName: string,
    entityBName: string,
    relType: string,
    closedAt?: string,
  ): Promise<boolean> {
    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      return await Entity.closeEntityRelationship(
        session,
        entityAName,
        entityBName,
        relType,
        closedAt,
      );
    } finally {
      await session.close();
    }
  }

  /**
   * Expire entity-to-entity relationships no longer supported by active memories.
   * A relationship is expired when no active (validUntil IS NULL) memory for this
   * agent mentions both connected entities.
   *
   * @param agentId  Agent scope for the memory lookup
   * @returns        Number of relationships expired
   */
  async expireOrphanedEntityRelationships(agentId: string): Promise<number> {
    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      return await Sleep.expireOrphanedEntityRelationships(session, agentId);
    } finally {
      await session.close();
    }
  }

  /**
   * Detect conflicts between a newly stored memory and existing memories.
   * Uses vector similarity search to find candidates, then LLM to classify.
   * Supersedes any existing memories that the new memory replaces.
   *
   * @returns Number of memories superseded
   */
  async detectConflicts(
    newMemoryId: string,
    newMemoryText: string,
    newEmbedding: number[],
    agentId: string,
    config: ExtractionConfig,
    options?: {
      similarityThreshold?: number;
      maxCandidates?: number;
    },
  ): Promise<number> {
    return Sleep.detectConflicts(
      this.logger,
      config,
      newMemoryId,
      newMemoryText,
      newEmbedding,
      agentId,
      (e, t, l, a) => this.findSimilar(e, t, l, a),
      (o, n) => this.supersedeMemory(o, n),
      options,
    );
  }

  /**
   * Fetch non-superseded memories for the retroactive conflict scan (Phase 3c).
   * Returns memories with their embeddings for batch conflict detection.
   */
  async fetchMemoriesForRetroactiveConflictScan(
    minAgeDays: number = 7,
    limit: number = 50,
    agentId?: string,
  ): Promise<Array<{ id: string; text: string; embedding: number[] | null; category: string }>> {
    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      return await Sleep.fetchMemoriesForRetroactiveConflictScan(
        session,
        minAgeDays,
        limit,
        agentId,
      );
    } finally {
      await session.close();
    }
  }

  /**
   * Get a single field value from a Memory node.
   * Returns undefined if the memory or field doesn't exist.
   */
  async getMemoryField(id: string, field: string): Promise<string | undefined> {
    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      return await Sleep.getMemoryField(session, id, field);
    } finally {
      await session.close();
    }
  }

  // --------------------------------------------------------------------------
  // Reindex: re-embed all Memory nodes
  // --------------------------------------------------------------------------

  /**
   * Re-embed all Memory nodes with a new embedding model.
   * Used after changing the embedding model/provider in config.
   */
  async reindex(
    embedFn: (texts: string[]) => Promise<number[][]>,
    options?: {
      batchSize?: number;
      onProgress?: (phase: string, done: number, total: number) => void;
      agentId?: string;
    },
  ): Promise<{ memories: number }> {
    await this.ensureInitialized();
    return Indexes.reindex(this.driver!, this.dimensions, this.logger, embedFn, options);
  }

  // --------------------------------------------------------------------------
  // Health & Stats Queries
  // --------------------------------------------------------------------------

  /**
   * Get entity graph statistics: entity count, mention count, and density.
   * Density = mentionCount / max(entityCount, 1).
   */
  async getEntityGraphStats(
    agentId?: string,
  ): Promise<{ entityCount: number; mentionCount: number; density: number }> {
    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      return await Entity.getEntityGraphStats(session, agentId);
    } finally {
      await session.close();
    }
  }

  /**
   * Get decay score distribution bucketed into health categories.
   * Computes decay scores server-side and buckets them.
   */
  async getDecayDistribution(agentId?: string): Promise<Array<{ bucket: string; count: number }>> {
    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      return await Sleep.getDecayDistribution(session, agentId);
    } finally {
      await session.close();
    }
  }

  // --------------------------------------------------------------------------
  // Sleep Cycle: Entity Deduplication
  // --------------------------------------------------------------------------

  /**
   * Find entity pairs that are likely duplicates based on name containment.
   */
  async findDuplicateEntityPairs(
    agentId?: string,
    limit: number = 200,
  ): Promise<
    Array<{
      keepId: string;
      keepName: string;
      removeId: string;
      removeName: string;
      keepMentions: number;
      removeMentions: number;
    }>
  > {
    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      return await Entity.findDuplicateEntityPairs(session, agentId, limit);
    } finally {
      await session.close();
    }
  }

  /**
   * Merge two entities: transfer MENTIONS relationships from source to target,
   * update mention count, then delete the source entity.
   */
  async mergeEntityPair(keepId: string, removeId: string): Promise<boolean> {
    await this.ensureInitialized();
    return this.retryOnTransient(async () => {
      const session = this.driver!.session();
      try {
        return await Entity.mergeEntityPair(session, keepId, removeId);
      } finally {
        await session.close();
      }
    });
  }

  /**
   * Batch-merge multiple entity pairs in a single transaction (OP-106).
   *
   * @returns Number of pairs merged (equals pairs.length on success, 0 on error)
   */
  async batchMergeEntityPairs(pairs: Array<{ keepId: string; removeId: string }>): Promise<number> {
    if (pairs.length === 0) return 0;
    await this.ensureInitialized();
    return this.retryOnTransient(async () => {
      const session = this.driver!.session();
      try {
        return await Entity.batchMergeEntityPairs(session, pairs);
      } finally {
        await session.close();
      }
    });
  }

  /**
   * Delete non-core, non-pinned memories matching a regex pattern.
   * Used by the sleep cycle noise pattern cleanup.
   *
   * @returns Number of memories deleted
   */
  async deleteMemoriesByPattern(pattern: string, agentId?: string, limit = 100): Promise<number> {
    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      return await Memory.deleteMemoriesByPattern(session, pattern, agentId, limit);
    } finally {
      await session.close();
    }
  }

  /**
   * Fetch a paginated batch of memories for credential scanning.
   * Uses composite cursor-based pagination (createdAt, id) instead of SKIP (Perf-6).
   * Pass cursorTs="" and cursorId="" for the first page.
   */
  async fetchMemoriesForCredentialScan(
    cursorTs: string,
    cursorId: string,
    limit: number,
    agentId?: string,
  ): Promise<Array<{ id: string; text: string; createdAt: string }>> {
    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      return await Sleep.fetchMemoriesForCredentialScan(
        session,
        cursorTs,
        cursorId,
        limit,
        agentId,
      );
    } finally {
      await session.close();
    }
  }

  /**
   * @deprecated Use fetchMemoriesForCredentialScan with pagination instead.
   * Fetch all memories (id + text) for a given agent, or all agents.
   */
  async fetchAllMemoriesForScan(agentId?: string): Promise<Array<{ id: string; text: string }>> {
    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      return await Sleep.fetchAllMemoriesForScan(session, agentId);
    } finally {
      await session.close();
    }
  }

  /**
   * Fetch non-core memories older than minAgeDays for temporal staleness checking.
   * Only returns memories that contain date-like patterns.
   */
  async fetchMemoriesForTemporalCheck(
    minAgeDays: number = 3,
    agentId?: string,
  ): Promise<Array<{ id: string; text: string }>> {
    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      return await Sleep.fetchMemoriesForTemporalCheck(session, minAgeDays, agentId);
    } finally {
      await session.close();
    }
  }

  /**
   * Delete memories by IDs (DETACH DELETE).
   * Used by the sleep cycle credential scanner.
   *
   * @returns Number of memories deleted
   */
  async deleteMemoriesByIds(ids: string[]): Promise<number> {
    if (ids.length === 0) {
      return 0;
    }
    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      return await Memory.deleteMemoriesByIds(session, ids);
    } finally {
      await session.close();
    }
  }

  /**
   * Search memories by keywords using the fulltext (BM25) index.
   * Returns memories whose text matches any of the given keywords.
   */
  async searchMemoriesByKeywords(
    keywords: string[],
    limit: number = 50,
    agentId?: string,
  ): Promise<Array<{ id: string; text: string; category: string }>> {
    if (keywords.length === 0) {
      return [];
    }

    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      return await Memory.searchMemoriesByKeywords(session, keywords, limit, agentId);
    } finally {
      await session.close();
    }
  }

  /**
   * Reconcile mentionCount for all entities by counting actual MENTIONS relationships.
   * Fixes entities with NULL or stale mentionCount values.
   *
   * @returns Number of entities updated
   */
  async reconcileEntityMentionCounts(): Promise<number> {
    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      return await Entity.reconcileEntityMentionCounts(session);
    } finally {
      await session.close();
    }
  }

  // --------------------------------------------------------------------------
  // Retry Logic
  // --------------------------------------------------------------------------

  /**
   * Retry an operation on transient Neo4j errors (deadlocks, connection blips, etc.)
   * with exponential backoff. Adapted from ontology project.
   */
  private async retryOnTransient<T>(
    fn: () => Promise<T>,
    maxAttempts: number = TRANSIENT_RETRY_ATTEMPTS,
    baseDelay: number = TRANSIENT_RETRY_BASE_DELAY_MS,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        // Check for Neo4j transient errors (deadlocks, connection blips, service unavailable)
        const errCode =
          err instanceof Error
            ? ((err as unknown as Record<string, unknown>).code as string | undefined)
            : undefined;
        const isTransient =
          err instanceof Error &&
          (err.message.includes("DeadlockDetected") ||
            err.message.includes("TransientError") ||
            err.message.includes("ServiceUnavailable") ||
            err.message.includes("SessionExpired") ||
            err.message.includes("ConnectionRefused") ||
            err.message.includes("connection terminated") ||
            (err.constructor.name === "Neo4jError" &&
              typeof errCode === "string" &&
              (errCode.startsWith("Neo.TransientError.") ||
                errCode === "ServiceUnavailable" ||
                errCode === "SessionExpired")));

        if (!isTransient || attempt >= maxAttempts - 1) {
          throw err;
        }

        const delay = baseDelay * Math.pow(2, attempt);
        this.logger.warn(
          `memory-neo4j: transient error, retrying (${attempt + 1}/${maxAttempts}): ${String(err)}`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw lastError;
  }
}
