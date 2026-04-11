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
import { isNeo4jConnectionError } from "./errors.js";
import { mpfpSearch, type MpfpMode, type MpfpOptions } from "./mpfp-search.js";
import * as Entity from "./neo4j-client-entity.js";
import * as Health from "./neo4j-client-health.js";
import * as Indexes from "./neo4j-client-indexes.js";
import * as Memory from "./neo4j-client-memory.js";
import * as Observation from "./neo4j-client-observation.js";
import * as Opinion from "./neo4j-client-opinion.js";
import {
  createRetrievalBufferState,
  flushRetrievalBuffer,
  recordRetrievals as recordRetrievalsImpl,
  type RetrievalBufferState,
} from "./neo4j-client-retrieval.js";
import * as Search from "./neo4j-client-search.js";
import {
  retryOnTransient as retryOnTransientImpl,
  TRANSIENT_RETRY_ATTEMPTS,
  TRANSIENT_RETRY_BASE_DELAY_MS,
  withSearchFallback as withSearchFallbackImpl,
  withSession as withSessionImpl,
} from "./neo4j-client-session.js";
import * as Sleep from "./neo4j-client-sleep.js";
import type { ExtractionStatus, Logger, SearchSignalResult, StoreMemoryInput } from "./schema.js";
import { detectCredential } from "./sleep-cycle-types.js";

export class Neo4jMemoryClient {
  private driver: Driver | null = null;
  private initPromise: Promise<void> | null = null;
  private indexesReady = false;
  private retrievalState: RetrievalBufferState = createRetrievalBufferState();
  /** Optional search result cache — set by plugin init when cache is enabled. */
  searchCache?: import("./search-cache.js").QueryResultCache;

  constructor(
    private readonly uri: string,
    private readonly username: string,
    private readonly password: string,
    private readonly dimensions: number,
    private readonly logger: Logger,
  ) {}

  // — Connection & Initialization —
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
    // Warn when using an unencrypted connection scheme (skip for loopback — TLS adds no value)
    const encrypted = ["bolt+s://", "bolt+ssc://", "neo4j+s://", "neo4j+ssc://"];
    let isLoopback = false;
    try {
      const h = new URL(this.uri).hostname;
      isLoopback = h === "localhost" || h === "127.0.0.1" || h === "[::1]";
    } catch {
      // M5: URI is not a valid URL — non-fatal, proceed with encryption warning
      this.logger.debug?.(`memory-neo4j: could not parse URI for loopback check: ${this.uri}`);
    }
    if (!isLoopback && !encrypted.some((s) => this.uri.startsWith(s))) {
      this.logger.warn(
        `memory-neo4j: connecting to Neo4j over unencrypted scheme (${this.uri.split("://")[0]}://). Consider using bolt+s:// or neo4j+s:// for TLS.`,
      );
    }
    this.driver = neo4j.driver(this.uri, neo4j.auth.basic(this.username, this.password), {
      disableLosslessIntegers: true,
      maxConnectionPoolSize: 20, // Reduced from 200 - appropriate for single-instance Neo4j
      connectionAcquisitionTimeout: 60000,
      maxTransactionRetryTime: 30000,
    });
    const session = this.driver.session();
    try {
      await session.run("RETURN 1");
      let redacted: string;
      try {
        const u = new URL(this.uri);
        if (u.password) {
          u.password = "***";
        }
        redacted = u.toString();
      } catch {
        redacted = this.uri.replace(/:\/\/[^:]+:[^@]+@/, "://<redacted>@");
      }
      this.logger.info(`memory-neo4j: connected to ${redacted}`);
    } finally {
      await session.close();
    }
    await Indexes.ensureIndexes(this.driver, this.dimensions, this.logger);
    // Ensure observation indexes (OP-183) and opinion indexes (OP-186)
    const obsSession = this.driver.session();
    try {
      await Observation.ensureObservationIndexes(obsSession);
      await Opinion.ensureOpinionIndexes(obsSession);
    } finally {
      await obsSession.close();
    }
    this.indexesReady = true;
    // Backfill temporal fields and entity agentId (idempotent)
    const ms = this.driver.session();
    try {
      await Sleep.migrateTemporalFields(ms);
      await Sleep.migrateEntityRelationshipTemporalFields(ms);
      await Sleep.migrateEntityAgentId(ms);
    } finally {
      await ms.close();
    }
  }
  async close(): Promise<void> {
    await this.flushRetrievalBuffer().catch(() => {}); // Flush pending retrieval events before close
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
   *
   * **Security note (C1):** This method accepts raw Cypher strings. All user-controlled
   * values MUST be passed via the `params` object (parameterized queries), never
   * interpolated into the `cypher` string. Callers are responsible for preventing
   * Cypher injection.
   */
  async runQuery<T extends Record<string, unknown>>(
    cypher: string,
    params: Record<string, unknown> = {},
  ): Promise<T[]> {
    return this.withSession(async (session) => {
      const result = await session.run(cypher, params);
      return result.records.map((r) => {
        const obj: Record<string, unknown> = {};
        for (const key of r.keys) {
          obj[key as string] = r.get(key as string);
        }
        return obj as T;
      });
    });
  }
  /** Create a raw Neo4j session. Caller is responsible for closing it. Used by sleep cycle phases that need multi-statement transactions. */
  async createSession(): Promise<import("neo4j-driver").Session> {
    await this.ensureInitialized();
    return Health.createSession(this.driver!);
  }
  /**
   * Lightweight status probe that verifies connectivity and fetches summary counts
   * without triggering the full ensureInitialized() (indexes + migrations).
   * Returns null if the connection fails.
   */
  async probeStatusCounts(): Promise<{
    memories: number;
    entities: number;
  } | null> {
    return Health.probeStatusCounts(this.driver, this.uri, this.username, this.password);
  }
  async verifyConnection(): Promise<boolean> {
    return Health.verifyConnection(
      this.driver,
      this.uri,
      this.username,
      this.password,
      this.logger,
    );
  }
  // — Memory CRUD —
  /**
   * Persist a memory node to Neo4j. Returns the stored memory ID on success.
   * If the text contains a credential-like pattern (OP-97), the memory is NOT
   * stored and a sentinel ID of the form `"blocked:credential:<timestamp>"` is
   * returned so callers do not crash. A warning is logged in this case.
   */
  async storeMemory(input: StoreMemoryInput): Promise<string> {
    // OP-97: Write-time credential scan — reject storage of secrets
    const credentialMatch = detectCredential(input.text);
    if (credentialMatch !== null) {
      this.logger.warn(
        `memory-neo4j: storeMemory blocked — text contains a potential ${credentialMatch}. Refusing to persist.`,
      );
      // Return a sentinel ID so callers do not crash; the memory is not stored.
      return `blocked:credential:${Date.now()}`;
    }
    // Neuro-symbolic: Capture-time consistency validation hook.
    // When constraints are defined, the consistency checker can run inline checks
    // before storage. Currently handled post-hoc via sleep Phase 16 and on-demand
    // via logic_query tool in "check" mode. Full capture-time integration requires
    // wiring constraint definitions through the plugin lifecycle.
    // See: consistency-checker.ts, plugin-tools-reasoning.ts

    // M4: Validate embedding dimensions match configured dimensions
    if (input.embedding.length > 0 && input.embedding.length !== this.dimensions) {
      this.logger.warn(
        `memory-neo4j: storeMemory blocked — embedding has ${input.embedding.length} dims, expected ${this.dimensions}. Refusing to persist.`,
      );
      return `blocked:dimension_mismatch:${Date.now()}`;
    }
    try {
      const id = await this.retryOnTransient(() =>
        this.withSession((s) => Memory.storeMemory(s, input)),
      );
      // M14: Agent-scoped cache invalidation — only clear the writing agent's cache
      if (input.agentId && this.searchCache) {
        this.searchCache.invalidateAgent(input.agentId);
      } else {
        this.searchCache?.clear();
      }
      return id;
    } catch (err) {
      if (isNeo4jConnectionError(err)) {
        this.logger.warn(
          `memory-neo4j: storeMemory failed — Neo4j connection error: ${String(err)}`,
        );
        return `blocked:connection:${Date.now()}`;
      }
      throw err;
    }
  }
  /**
   * Store multiple memories in a single Cypher UNWIND statement (OP-107).
   * Used by Phase 8 tip generation to batch-store all generated tips after a single embedBatch call.
   * Applies the same write-time credential scan as storeMemory(); any tip containing a credential is silently skipped.
   * @returns Number of memories actually stored
   */
  async storeManyMemories(inputs: StoreMemoryInput[]): Promise<number> {
    if (inputs.length === 0) {
      return 0;
    }
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
    if (safe.length === 0) {
      return 0;
    }
    const count = await this.retryOnTransient(() =>
      this.withSession((s) => Memory.storeManyMemories(s, safe)),
    );
    // C2: Invalidate search cache after batch store (same pattern as storeMemory)
    if (count > 0) {
      const agents = new Set(safe.map((inp) => inp.agentId).filter(Boolean));
      if (agents.size > 0 && this.searchCache) {
        for (const agent of agents) {
          this.searchCache.invalidateAgent(agent);
        }
      } else {
        this.searchCache?.clear();
      }
    }
    return count;
  }
  async deleteMemory(id: string, agentId?: string): Promise<boolean> {
    // Validate UUID format to prevent injection
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(id)) {
      throw new Error(`Invalid memory ID format: ${id}`);
    }
    const deleted = await this.retryOnTransient(() =>
      this.withSession((s) => Memory.deleteMemory(s, id, agentId)),
    );
    if (deleted) {
      this.searchCache?.clear();
    }
    return deleted;
  }
  async countMemories(agentId?: string): Promise<number> {
    return this.withSession((s) => Memory.countMemories(s, agentId));
  }
  /** Get memory counts grouped by agentId and category. Returns stats for building a summary table. */
  async getMemoryStats(
    agentId?: string,
  ): Promise<Array<{ agentId: string; category: string; count: number; avgImportance: number }>> {
    return this.withSession((s) => Memory.getMemoryStats(s, agentId));
  }
  /** List memories by category, ordered by importance (descending). Used for loading core memories at session start. */
  async listByCategory(
    category: string,
    limit: number,
    minImportance: number = 0,
    agentId?: string,
  ): Promise<{ id: string; text: string; category: string; importance: number }[]> {
    return this.withSession((s) =>
      Memory.listByCategory(s, category, limit, minImportance, agentId),
    );
  }
  /**
   * Load all core memories for context injection.
   * Core memories are user-curated (created via explicit "remember" requests) with importance locked at 1.0.
   * Safety cap of 200 prevents unbounded context injection payloads.
   */
  async listCoreForInjection(
    agentId?: string,
  ): Promise<{ id: string; text: string; category: string; importance: number }[]> {
    const results = await this.withSession((s) => Memory.listCoreForInjection(s, agentId));
    if (results.length >= Memory.CORE_INJECTION_LIMIT) {
      this.logger.warn(
        `memory-neo4j: listCoreForInjection hit safety cap (${Memory.CORE_INJECTION_LIMIT}) — some core memories may be excluded from context injection`,
      );
    }
    return results;
  }
  // — Search Signals —
  /** Signal 1: HNSW vector similarity search. Returns memories ranked by cosine similarity to the query embedding. */
  async vectorSearch(
    embedding: number[],
    limit: number,
    minScore: number = 0.1,
    agentId?: string,
    includeExpired?: boolean,
    asOf?: string,
    includeQuarantined?: boolean,
    abortSignal?: AbortSignal,
    dateRangeStart?: string,
    dateRangeEnd?: string,
  ): Promise<SearchSignalResult[]> {
    return this.withSearchFallback(
      "vector search",
      () =>
        this.withSession(
          (s) =>
            Search.vectorSearch(
              s,
              embedding,
              limit,
              minScore,
              agentId,
              includeExpired,
              asOf,
              includeQuarantined,
              dateRangeStart,
              dateRangeEnd,
            ),
          abortSignal,
        ),
      [],
      true,
      "warn",
      abortSignal,
    );
  }
  /** Signal 2: Lucene BM25 full-text keyword search. Returns memories ranked by BM25 relevance score. */
  async bm25Search(
    query: string,
    limit: number,
    agentId?: string,
    includeExpired?: boolean,
    asOf?: string,
    includeQuarantined?: boolean,
    abortSignal?: AbortSignal,
    dateRangeStart?: string,
    dateRangeEnd?: string,
  ): Promise<SearchSignalResult[]> {
    if (!query.trim()) {
      return [];
    }
    return this.withSearchFallback(
      "BM25 search",
      () =>
        this.withSession(
          (s) =>
            Search.bm25Search(
              s,
              query,
              limit,
              agentId,
              includeExpired,
              asOf,
              includeQuarantined,
              dateRangeStart,
              dateRangeEnd,
            ),
          abortSignal,
        ),
      [],
      true,
      "warn",
      abortSignal,
    );
  }
  /** Signal 5 (optional): Community-aware search. Queries Community nodes by fulltext match, expands to member entities, collects their connected memories. */
  async communitySearch(
    query: string,
    limit: number,
    agentId?: string,
    includeQuarantined?: boolean,
    includeExpired?: boolean,
    asOf?: string,
    abortSignal?: AbortSignal,
  ): Promise<SearchSignalResult[]> {
    // Graceful degradation — community search is optional
    return this.withSearchFallback(
      "community search",
      () =>
        this.withSession(
          (s) =>
            Search.communitySearch(
              s,
              query,
              limit,
              agentId,
              includeQuarantined,
              includeExpired,
              asOf,
            ),
          abortSignal,
        ),
      [],
      false,
      "debug",
      abortSignal,
    );
  }
  /**
   * Signal 3: Graph traversal search. Entity-type and relationship-type agnostic.
   * Queries all Entity nodes via `entity_fulltext_index` and synthesizes text from their properties.
   * Supports dynamic N-hop traversal with confidence decay (0.7 per hop).
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
    hopDecayThreshold: number = 0.15,
    queryType?: string,
    embedding?: number[],
    causalRelTypes?: string[],
    abortSignal?: AbortSignal,
    parsedChain?: import("./possessive-chain.js").PossessiveChain,
  ): Promise<SearchSignalResult[]> {
    if (!query.trim()) {
      return [];
    }
    return this.withSearchFallback(
      "graph search",
      () =>
        this.withSession(
          (s) =>
            Search.graphSearch(
              s,
              query,
              limit,
              firingThreshold,
              agentId,
              maxHops,
              includeExpired,
              asOf,
              seedCap,
              relTypes,
              hopDecayThreshold,
              queryType,
              embedding,
              causalRelTypes,
              this.driver ? () => this.driver!.session() : undefined,
              parsedChain,
            ),
          abortSignal,
        ),
      [],
      true,
      "warn",
      abortSignal,
    );
  }
  /** Signal 6 (optional): MPFP meta-path forward push search (OP-181). Traverses meta-path patterns from seed Memory node IDs. */
  async mpfpSearch(
    seedNodeIds: string[],
    agentId: string,
    mode: MpfpMode = "both",
    options: MpfpOptions = {},
    abortSignal?: AbortSignal,
  ): Promise<SearchSignalResult[]> {
    if (seedNodeIds.length === 0) {
      return [];
    }
    return this.withSearchFallback(
      "MPFP search",
      () =>
        this.withSession((s) => mpfpSearch(s, agentId, seedNodeIds, mode, options), abortSignal),
      [],
      false,
      "debug",
      abortSignal,
    );
  }
  /** Find similar memories by vector similarity. Used for deduplication. HNSW indexes don't support pre-filtering, so we fetch extra candidates when agentId is provided. */
  async findSimilar(
    embedding: number[],
    threshold: number = 0.95,
    limit: number = 1,
    agentId?: string,
  ): Promise<Array<{ id: string; text: string; score: number }>> {
    // If vector index isn't ready or all retries exhausted, return no duplicates (allow store)
    return this.withSearchFallback(
      "similarity check",
      () => this.withSession((s) => Search.findSimilar(s, embedding, threshold, limit, agentId)),
      [],
      false,
      "debug",
    );
  }
  /** Enrich memory IDs with episode metadata via EPISODE_SOURCE relationships (OP-178). */
  async episodeEnrich(
    memoryIds: string[],
    abortSignal?: AbortSignal,
  ): Promise<Search.EpisodeMetadata[]> {
    if (memoryIds.length === 0) {
      return [];
    }
    return this.withSearchFallback(
      "episode enrich",
      () => this.withSession((s) => Search.episodeEnrich(s, memoryIds), abortSignal),
      [],
      false, // non-critical — search works without episode metadata
      "debug",
      abortSignal,
    );
  }
  // — Retrieval Tracking —
  /** Record retrieval events for memories. Called after search/recall. Increments retrievalCount and updates lastRetrievedAt timestamp. */
  async recordRetrievals(memoryIds: string[]): Promise<void> {
    return recordRetrievalsImpl(
      this.retrievalState,
      memoryIds,
      () => this.flushRetrievalBuffer(),
      this.logger,
    );
  }

  private async flushRetrievalBuffer(): Promise<void> {
    return flushRetrievalBuffer(
      this.retrievalState,
      this.driver,
      this.logger,
      (fn) => this.retryOnTransient(fn),
      (fn) => this.withSession(fn),
    );
  }
  // — Entity & Relationship Operations —
  /** Update the extraction status of a Memory node. Optionally increments the extractionRetries counter. */
  async updateExtractionStatus(
    id: string,
    status: ExtractionStatus,
    options?: { incrementRetries?: boolean },
  ): Promise<void> {
    return this.withSession((s) => Entity.updateExtractionStatus(s, id, status, options));
  }
  /** Batch-update extraction status for multiple memories. Used by sleep cycle to mark a batch as failed/skipped. */
  async updateExtractionStatusBatch(
    ids: string[],
    status: ExtractionStatus,
    options?: { incrementRetries?: boolean },
  ): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    return this.withSession((s) => Entity.updateExtractionStatusBatch(s, ids, status, options));
  }
  /** Batch all entity operations from an extraction result into a single managed transaction. */
  async batchEntityOperations(
    memoryId: string,
    entities: Array<{
      id: string;
      name: string;
      type: string;
      aliases?: string[];
      description?: string;
      properties?: Record<string, string>;
    }>,
    relationships: Array<{
      source: string;
      target: string;
      type: string;
      confidence: number;
      qualifier?: string;
    }>,
    tags: Array<{ name: string; category: string }>,
    category?: string,
  ): Promise<void> {
    return this.retryOnTransient(() =>
      this.withSession((s) =>
        Entity.batchEntityOperations(s, memoryId, entities, relationships, tags, category),
      ),
    );
  }
  /** List memories with pending extraction status. Used by the sleep cycle to batch-process extractions. */
  async listPendingExtractions(
    limit: number = 100,
    agentId?: string,
  ): Promise<Array<{ id: string; text: string; agentId: string; extractionRetries: number }>> {
    return this.withSession((s) => Entity.listPendingExtractions(s, limit, agentId));
  }
  /** Count memories by extraction status. Used for sleep cycle progress reporting. */
  async countByExtractionStatus(agentId?: string): Promise<Record<ExtractionStatus, number>> {
    return this.withSession((s) => Entity.countByExtractionStatus(s, agentId));
  }
  /** Reset failed extractions back to pending so the sleep cycle retries them. */
  async resetFailedExtractions(agentId?: string): Promise<number> {
    return this.withSession((s) => Entity.resetFailedExtractions(s, agentId));
  }
  /** List memories with completed extraction but no TAGGED relationships. Used by retroactive tagging phase. */
  async listUntaggedMemories(
    limit: number = 50,
    agentId?: string,
    maxRetries: number = 3,
  ): Promise<Array<{ id: string; text: string }>> {
    return this.withSession((s) => Entity.listUntaggedMemories(s, limit, agentId, maxRetries));
  }
  /** Increment the tagging retry counter for a memory that failed retroactive tagging. */
  async incrementTaggingRetries(memoryId: string): Promise<void> {
    return this.withSession((s) => Entity.incrementTaggingRetries(s, memoryId));
  }
  /** Batch-increment tagging retry counters for multiple memories. Reduces N round-trips to 1. */
  async incrementTaggingRetriesBatch(memoryIds: string[]): Promise<void> {
    if (memoryIds.length === 0) {
      return;
    }
    return this.withSession((s) => Entity.incrementTaggingRetriesBatch(s, memoryIds));
  }
  // — Sleep Cycle: Deduplication —
  /** Find clusters of near-duplicate memories by vector similarity. Returns groups where each group contains duplicates of each other. */
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
  /** Merge duplicate memories by keeping the one with highest importance and deleting the rest. Transfers TAGGED relationships to the survivor. */
  async mergeMemoryCluster(
    memoryIds: string[],
    importances: number[],
  ): Promise<{ survivorId: string; deletedCount: number }> {
    return this.retryOnTransient(() =>
      this.withSession((s) => Sleep.mergeMemoryCluster(s, this.logger, memoryIds, importances)),
    );
  }
  // — Sleep Cycle: Decay & Pruning —
  /**
   * Find memories that have decayed below the retention threshold.
   * IMPORTANT: Core memories (category='core') and user-pinned memories are EXEMPT from decay.
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
    return this.withSession((s) => Sleep.findDecayedMemories(s, options));
  }
  /** Delete decayed memories and decrement entity mention counts. */
  async pruneMemories(memoryIds: string[]): Promise<number> {
    if (memoryIds.length === 0) {
      return 0;
    }
    return this.retryOnTransient(() => this.withSession((s) => Sleep.pruneMemories(s, memoryIds)));
  }
  // — Sleep Cycle: Orphan Cleanup —
  /** Find orphaned Entity nodes (no entity-entity relationships). */
  async findOrphanEntities(
    limit: number = 500,
  ): Promise<Array<{ id: string; name: string; type: string }>> {
    return this.withSession((s) => Sleep.findOrphanEntities(s, limit));
  }
  /** Delete orphaned entities and their relationships. */
  async deleteOrphanEntities(entityIds: string[]): Promise<number> {
    if (entityIds.length === 0) {
      return 0;
    }
    return this.withSession((s) => Sleep.deleteOrphanEntities(s, entityIds));
  }
  /** Return the most-used tag names (used by 2+ memories) for prompt vocabulary injection. */
  async getTopTagNames(limit: number = 100): Promise<string[]> {
    return this.withSession(async (session) => {
      const result = await session.executeRead((tx) =>
        tx.run(
          `MATCH (t:Tag)<-[r:TAGGED]-(:Memory)
           WITH t.name AS name, count(r) AS uses
           WHERE uses >= 2
           ORDER BY uses DESC
           LIMIT $limit
           RETURN name`,
          { limit: neo4j.int(limit) },
        ),
      );
      return result.records.map((r) => r.get("name") as string);
    });
  }
  /** Find orphaned Tag nodes (no TAGGED relationships from any Memory). */
  async findOrphanTags(limit: number = 500): Promise<Array<{ id: string; name: string }>> {
    return this.withSession((s) => Sleep.findOrphanTags(s, limit));
  }
  /** Delete orphaned tags. */
  async deleteOrphanTags(tagIds: string[]): Promise<number> {
    if (tagIds.length === 0) {
      return 0;
    }
    return this.withSession((s) => Sleep.deleteOrphanTags(s, tagIds));
  }
  /** Find tags with exactly 1 TAGGED relationship, older than minAgeDays. Single-use tags add noise. */
  async findSingleUseTags(
    minAgeDays: number = 14,
    limit: number = 500,
  ): Promise<Array<{ id: string; name: string }>> {
    return this.withSession((s) => Sleep.findSingleUseTags(s, minAgeDays, limit));
  }
  // — Sleep Cycle: Conflict Detection —
  /** Find memory pairs with high embedding similarity. Candidates for conflict resolution. Excludes core memories. */
  async findConflictingMemories(
    agentId?: string,
    limit: number = 50,
  ): Promise<
    Array<{
      memoryA: { id: string; text: string; importance: number; createdAt: string };
      memoryB: { id: string; text: string; importance: number; createdAt: string };
    }>
  > {
    return this.withSession((s) => Sleep.findConflictingMemories(s, agentId, limit));
  }
  // — Pending Conflict Pairs (OP-125) —
  /** Store a pending conflict pair for retry on the next sleep cycle. Returns false if either memory is missing. */
  async storePendingConflict(idA: string, idB: string): Promise<boolean> {
    return this.withSession((s) => Sleep.storePendingConflict(s, idA, idB));
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
    return this.withSession((s) => Sleep.fetchPendingConflicts(s, agentId, limit));
  }
  /** Remove the PENDING_CONFLICT relationship between two memories. */
  async clearPendingConflict(idA: string, idB: string): Promise<void> {
    return this.withSession((s) => Sleep.clearPendingConflict(s, idA, idB));
  }
  /** Batch-clear multiple PENDING_CONFLICT relationships. Reduces N round-trips to 1. */
  async clearPendingConflictsBatch(pairs: Array<{ idA: string; idB: string }>): Promise<void> {
    if (pairs.length === 0) {
      return;
    }
    return this.withSession((s) => Sleep.clearPendingConflictsBatch(s, pairs));
  }
  /** Increment the retry counter on a PENDING_CONFLICT relationship. */
  async incrementPendingConflictRetry(idA: string, idB: string): Promise<void> {
    return this.withSession((s) => Sleep.incrementPendingConflictRetry(s, idA, idB));
  }
  /** Invalidate a memory by setting its importance to near-zero. Used by conflict resolution to retire the losing memory. */
  async invalidateMemory(id: string): Promise<void> {
    await this.withSession((s) => Sleep.invalidateMemory(s, id));
    this.searchCache?.clear();
  }
  /** Batch-invalidate multiple memories in a single Cypher query. Prefer this over sequential invalidateMemory calls. */
  async invalidateMemories(ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    await this.withSession((s) => Sleep.invalidateMemories(s, ids));
    // H4: Invalidate cache after batch-invalidation (mirrors singular invalidateMemory above)
    this.searchCache?.clear();
  }
  // — Temporal Memory Operations —
  /**
   * Supersede a memory: set its validUntil to now and record which memory replaced it.
   * Used by conflict detection when a newer memory updates/contradicts an existing one.
   * @param oldId  ID of the memory being superseded
   * @param newId  ID of the replacement memory
   */
  async supersedeMemory(oldId: string, newId: string): Promise<void> {
    return this.withSession((s) => Sleep.supersedeMemory(s, oldId, newId));
  }
  /** Migrate existing memories to include temporal fields. @returns Number of memories updated */
  async migrateTemporalFields(): Promise<number> {
    return this.withSession((s) => Sleep.migrateTemporalFields(s));
  }
  /**
   * Close a specific entity-to-entity relationship by setting validUntil.
   * Use this when a relationship is known to be superseded or contradicted by newer information.
   * For bulk cleanup, use expireOrphanedEntityRelationships instead.
   * @param entityAName  Canonical name of the source entity (will be lowercased)
   * @param entityBName  Canonical name of the target entity (will be lowercased)
   * @param relType      Relationship type (must pass sanitizeRelationshipType validation)
   * @param closedAt     ISO-8601 timestamp; defaults to now
   * @returns            true if at least one relationship was closed
   */
  async closeEntityRelationship(
    entityAName: string,
    entityBName: string,
    relType: string,
    closedAt?: string,
  ): Promise<boolean> {
    return this.withSession((s) =>
      Entity.closeEntityRelationship(s, entityAName, entityBName, relType, closedAt),
    );
  }
  /**
   * Supersede entity relationships: close active rels of the same type from
   * source to any target OTHER than the new target.
   * @returns Number of relationships superseded
   */
  async supersedeRelationship(
    entityName: string,
    relType: string,
    newTargetName: string,
    agentId: string,
    closedAt?: string,
  ): Promise<number> {
    return this.withSession((s) =>
      Entity.supersedeRelationship(s, entityName, relType, newTargetName, agentId, closedAt),
    );
  }
  /** Expire entity-to-entity relationships where at least one endpoint is orphaned. @returns Number of relationships expired */
  async expireOrphanedEntityRelationships(agentId: string): Promise<number> {
    return this.withSession((s) => Sleep.expireOrphanedEntityRelationships(s, agentId));
  }
  // — Reclassification operations (Phase 9) —
  async listEntitiesForReclassification(limit?: number) {
    return this.withSession((s) => Entity.listEntitiesForReclassification(s, limit));
  }
  async updateEntityType(entityId: string, newType: string) {
    return this.withSession((s) => Entity.updateEntityType(s, entityId, newType));
  }
  async markEntityReclassificationComplete(entityId: string) {
    return this.withSession((s) => Entity.markEntityReclassificationComplete(s, entityId));
  }
  async markEntityReclassificationFailed(entityId: string) {
    return this.withSession((s) => Entity.markEntityReclassificationFailed(s, entityId));
  }
  async listRelatedToForReclassification(limit?: number) {
    return this.withSession((s) => Entity.listRelatedToForReclassification(s, limit));
  }
  async reclassifyRelationship(
    sourceName: string,
    targetName: string,
    oldType: string,
    newType: string,
  ) {
    return this.withSession((s) =>
      Entity.reclassifyRelationship(s, sourceName, targetName, oldType, newType),
    );
  }
  async markRelationshipReclassificationSkipped(sourceName: string, targetName: string) {
    return this.withSession((s) =>
      Entity.markRelationshipReclassificationSkipped(s, sourceName, targetName),
    );
  }
  // — Observation Operations (OP-183) —
  /** Find entities needing observation refresh (3+ memories, no or stale observation). */
  async getStaleEntities(agentId: string, limit?: number): Promise<string[]> {
    return this.withSession((s) => Observation.getStaleEntities(s, agentId, limit));
  }
  /** Create or update an Observation node for an entity. */
  async upsertObservation(
    agentId: string,
    entityName: string,
    summary: string,
    memoryCount: number,
  ): Promise<void> {
    return this.withSession((s) =>
      Observation.upsertObservation(s, agentId, entityName, summary, memoryCount),
    );
  }
  /** Fetch existing observations for a list of entity names. */
  async getObservationsForEntities(
    agentId: string,
    entityNames: string[],
  ): Promise<Array<{ entityName: string; summary: string; memoryIds: string[] }>> {
    if (entityNames.length === 0) {
      return [];
    }
    return this.withSession((s) => Observation.getObservationsForEntities(s, agentId, entityNames));
  }
  /** Collect memory texts connected to an entity via EXTRACTED_FROM. */
  async getEntityMemoryTexts(
    agentId: string,
    entityName: string,
    limit?: number,
  ): Promise<Array<{ id: string; text: string }>> {
    return this.withSession((s) => Observation.getEntityMemoryTexts(s, agentId, entityName, limit));
  }
  // — Opinion Operations (OP-186) —
  /** Create or update an Opinion node for an entity or topic. */
  async upsertOpinion(
    agentId: string,
    opinion: {
      topic: string;
      belief: string;
      confidence: number;
      entityName?: string;
      supportingMemoryIds: string[];
      contradictingMemoryIds: string[];
      archived?: boolean;
    },
  ): Promise<void> {
    return this.withSession((s) => Opinion.upsertOpinion(s, agentId, opinion));
  }
  /** Fetch opinions about a specific entity. */
  async getOpinionsForEntity(
    agentId: string,
    entityName: string,
  ): Promise<
    Array<{
      id: string;
      topic: string;
      belief: string;
      confidence: number;
      supportingMemoryIds: string[];
      contradictingMemoryIds: string[];
    }>
  > {
    return this.withSession((s) => Opinion.getOpinionsForEntity(s, agentId, entityName));
  }
  /** Fetch opinions matching topic keywords. */
  async getOpinionsForTopics(
    agentId: string,
    topics: string[],
  ): Promise<
    Array<{
      id: string;
      topic: string;
      belief: string;
      confidence: number;
      entityName: string;
      supportingMemoryIds: string[];
    }>
  > {
    if (topics.length === 0) {
      return [];
    }
    return this.withSession((s) => Opinion.getOpinionsForTopics(s, agentId, topics));
  }
  /** Find stale opinions where new evidence has arrived since last reflection. */
  async getStaleOpinions(
    agentId: string,
    limit?: number,
  ): Promise<
    Array<{
      entityName: string;
      topic: string;
      belief: string;
      confidence: number;
      supportingMemoryIds: string[];
      contradictingMemoryIds: string[];
    }>
  > {
    return this.withSession((s) => Opinion.getStaleOpinions(s, agentId, limit));
  }
  /**
   * Detect conflicts between a newly stored memory and existing memories.
   * Uses vector similarity search to find candidates, then LLM to classify.
   * Supersedes any existing memories that the new memory replaces.
   * @returns Number of memories superseded
   */
  async detectConflicts(
    newMemoryId: string,
    newMemoryText: string,
    newEmbedding: number[],
    agentId: string,
    config: ExtractionConfig,
    options?: { similarityThreshold?: number; maxCandidates?: number },
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
  /** Fetch non-superseded memories for the retroactive conflict scan (Phase 3c). Returns memories with their embeddings. */
  async fetchMemoriesForRetroactiveConflictScan(
    minAgeDays: number = 7,
    limit: number = 50,
    agentId?: string,
  ): Promise<Array<{ id: string; text: string; embedding: number[] | null; category: string }>> {
    return this.withSession((s) =>
      Sleep.fetchMemoriesForRetroactiveConflictScan(s, minAgeDays, limit, agentId),
    );
  }
  /** Get a single field value from a Memory node. Returns undefined if the memory or field doesn't exist. */
  async getMemoryField(id: string, field: string): Promise<string | undefined> {
    return this.withSession((s) => Sleep.getMemoryField(s, id, field));
  }
  // — Reindex —
  /** Re-embed all Memory nodes with a new embedding model. Used after changing the embedding model/provider in config. */
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
  // — Health & Stats Queries —
  /** Get entity graph statistics: entity count, relationship count, and density. */
  async getEntityGraphStats(
    agentId?: string,
  ): Promise<{ entityCount: number; relationshipCount: number; density: number }> {
    return this.withSession((s) => Entity.getEntityGraphStats(s, agentId));
  }
  /** Get decay score distribution bucketed into health categories. Computes decay scores server-side. */
  async getDecayDistribution(
    agentId?: string,
    options?: { baseHalfLifeDays?: number; importanceMultiplier?: number },
  ): Promise<Array<{ bucket: string; count: number }>> {
    return this.withSession((s) => Sleep.getDecayDistribution(s, agentId, options));
  }
  // — Sleep Cycle: Entity Deduplication —
  /** Find entity pairs that are likely duplicates based on name containment. */
  async findDuplicateEntityPairs(
    agentId?: string,
    limit: number = 200,
  ): Promise<
    Array<{
      keepId: string;
      keepName: string;
      removeId: string;
      removeName: string;
      keepRelationships: number;
      removeRelationships: number;
    }>
  > {
    return this.withSession((s) => Entity.findDuplicateEntityPairs(s, agentId, limit));
  }
  /** Merge two entities: delete the source entity (DETACH DELETE removes relationships). */
  async mergeEntityPair(keepId: string, removeId: string): Promise<boolean> {
    return this.retryOnTransient(() =>
      this.withSession((s) => Entity.mergeEntityPair(s, keepId, removeId)),
    );
  }
  /** Batch-merge multiple entity pairs in a single transaction (OP-106). @returns Number of pairs merged */
  async batchMergeEntityPairs(pairs: Array<{ keepId: string; removeId: string }>): Promise<number> {
    if (pairs.length === 0) {
      return 0;
    }
    return this.retryOnTransient(() =>
      this.withSession((s) => Entity.batchMergeEntityPairs(s, pairs)),
    );
  }
  /** Delete non-core, non-pinned memories matching a regex pattern. Used by sleep cycle noise pattern cleanup. @returns Number of memories deleted */
  async deleteMemoriesByPattern(pattern: string, agentId?: string, limit = 100): Promise<number> {
    return this.withSession((s) => Memory.deleteMemoriesByPattern(s, pattern, agentId, limit));
  }
  /** Fetch a paginated batch of memories for credential scanning. Uses composite cursor-based pagination (Perf-6). */
  async fetchMemoriesForCredentialScan(
    cursorTs: string,
    cursorId: string,
    limit: number,
    agentId?: string,
  ): Promise<Array<{ id: string; text: string; createdAt: string }>> {
    return this.withSession((s) =>
      Sleep.fetchMemoriesForCredentialScan(s, cursorTs, cursorId, limit, agentId),
    );
  }
  /** Fetch non-core memories older than minAgeDays for temporal staleness checking. Only returns memories with date-like patterns. */
  async fetchMemoriesForTemporalCheck(
    minAgeDays: number = 3,
    agentId?: string,
  ): Promise<Array<{ id: string; text: string }>> {
    return this.withSession((s) => Sleep.fetchMemoriesForTemporalCheck(s, minAgeDays, agentId));
  }
  /** Set temporalCheckedAt on memories that were checked for staleness. */
  async markTemporalChecked(ids: string[]): Promise<void> {
    return this.withSession((s) => Sleep.markTemporalChecked(s, ids));
  }
  /** Set conflictScannedAt on memories processed by the retroactive conflict scan. */
  async markConflictScanned(ids: string[]): Promise<void> {
    return this.withSession((s) => Sleep.markConflictScanned(s, ids));
  }
  /** Delete memories by IDs (DETACH DELETE). Used by the sleep cycle credential scanner. @returns Number of memories deleted */
  async deleteMemoriesByIds(ids: string[]): Promise<number> {
    if (ids.length === 0) {
      return 0;
    }
    return this.withSession((s) => Memory.deleteMemoriesByIds(s, ids));
  }
  /** Search memories by keywords using the fulltext (BM25) index. */
  async searchMemoriesByKeywords(
    keywords: string[],
    limit: number = 50,
    agentId?: string,
  ): Promise<Array<{ id: string; text: string; category: string }>> {
    if (keywords.length === 0) {
      return [];
    }
    return this.withSession((s) => Memory.searchMemoriesByKeywords(s, keywords, limit, agentId));
  }
  /** Reconcile relationshipCount for all entities by counting entity-entity relationships. @returns Number of entities updated */
  async reconcileEntityRelationshipCounts(): Promise<number> {
    return this.withSession((s) => Entity.reconcileEntityRelationshipCounts(s));
  }
  // — Session & Retry Logic —
  /** Run a function with a managed session (ensureInitialized + auto-close).
   *  When an AbortSignal is provided, the session is closed early on abort
   *  so the in-flight Neo4j query is cancelled and the connection returned to the pool. */
  private async withSession<T>(
    fn: (session: import("neo4j-driver").Session) => Promise<T>,
    abortSignal?: AbortSignal,
  ): Promise<T> {
    return withSessionImpl(
      fn,
      () => this.ensureInitialized(),
      () => this.driver,
      abortSignal,
    );
  }
  /**
   * Run a search operation with retry + graceful fallback on errors.
   * Connection errors are re-thrown when rethrowConnection is true (default).
   * Non-connection errors return the fallback value and log at the specified level.
   *
   * When an abortSignal is provided (from hybridSearch per-signal timeout),
   * it is threaded to retryOnTransient so zombie retries are stopped and
   * connections returned to the pool.
   */
  private async withSearchFallback<T>(
    label: string,
    fn: () => Promise<T>,
    fallback: T,
    rethrowConnection = true,
    logLevel: "warn" | "debug" = "warn",
    abortSignal?: AbortSignal,
  ): Promise<T> {
    return withSearchFallbackImpl(
      label,
      fn,
      fallback,
      this.logger,
      rethrowConnection,
      logLevel,
      abortSignal,
    );
  }
  /** Retry an operation on transient Neo4j errors (deadlocks, connection blips, etc.) with exponential backoff. */
  private async retryOnTransient<T>(
    fn: () => Promise<T>,
    maxAttempts: number = TRANSIENT_RETRY_ATTEMPTS,
    baseDelay: number = TRANSIENT_RETRY_BASE_DELAY_MS,
    abortSignal?: AbortSignal,
  ): Promise<T> {
    return retryOnTransientImpl(fn, this.logger, maxAttempts, baseDelay, abortSignal);
  }
}
