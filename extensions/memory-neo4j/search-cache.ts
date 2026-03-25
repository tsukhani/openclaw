/**
 * LRU cache for hybrid search results.
 *
 * Follows the EmbeddingCache pattern from embeddings.ts:
 * Map-based LRU with xxhash64 key hashing and TTL expiry.
 *
 * L1: xxhash64 is non-cryptographic with ~1/2^64 collision probability.
 * Acceptable for a TTL-bounded search cache — a collision would serve
 * stale results for one query until TTL expiry, not a correctness risk.
 */

import xxhashInit from "xxhash-wasm";
import type { HybridSearchResult } from "./schema.js";

/** Options that affect search results and must be included in the cache key. */
export type SearchCacheOptions = {
  includeExpired?: boolean;
  asOf?: string;
  limit?: number;
  includeQuarantined?: boolean;
  recencyWeight?: number;
  graphSearchDepth?: number;
  graphSeedCap?: number;
};

// H4: Use singleton promise pattern to prevent concurrent xxhashInit() calls.
// Without this, two concurrent callers could both see h64ToString === null,
// both call xxhashInit(), and race on assignment.
let h64ToString: ((input: string) => string) | null = null;
let h64InitPromise: Promise<void> | null = null;
async function getH64ToString(): Promise<(input: string) => string> {
  if (h64ToString) return h64ToString;
  if (!h64InitPromise) {
    h64InitPromise = xxhashInit().then((xxhash) => {
      h64ToString = xxhash.h64ToString;
    });
  }
  await h64InitPromise;
  return h64ToString!;
}

export class QueryResultCache {
  private readonly map = new Map<
    string,
    { results: HybridSearchResult[]; expiresAt: number; agentId: string }
  >();
  /** Secondary index: agentId → Set<cacheKey> for O(k) agent-scoped invalidation. */
  private readonly agentKeys = new Map<string, Set<string>>();
  private readonly maxSize: number;
  private readonly ttlMs: number;

  constructor(maxSize: number = 200, ttlMs: number = 300_000) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  private static async hashKey(
    query: string,
    agentId: string,
    options?: SearchCacheOptions,
  ): Promise<string> {
    const hash = await getH64ToString();
    const optStr = options
      ? JSON.stringify({
          includeExpired: options.includeExpired,
          asOf: options.asOf,
          limit: options.limit,
          includeQuarantined: options.includeQuarantined,
          recencyWeight: options.recencyWeight,
          graphSearchDepth: options.graphSearchDepth,
          graphSeedCap: options.graphSeedCap,
        })
      : "";
    return hash(`${query}:${agentId}:${optStr}`);
  }

  /**
   * Get cached results for a query+agentId+options tuple.
   * Returns undefined on cache miss or TTL expiry.
   */
  async get(
    query: string,
    agentId: string,
    options?: SearchCacheOptions,
  ): Promise<HybridSearchResult[] | undefined> {
    const key = await QueryResultCache.hashKey(query, agentId, options);
    const cached = this.map.get(key);

    if (!cached) return undefined;

    // Check TTL
    if (Date.now() >= cached.expiresAt) {
      this.map.delete(key);
      this.removeFromAgentIndex(cached.agentId, key);
      return undefined;
    }

    // Move to end (most recently used)
    this.map.delete(key);
    this.map.set(key, cached);
    // C2: Return a shallow copy so callers cannot mutate the cached array
    return [...cached.results];
  }

  /**
   * Cache search results for a query+agentId+options tuple.
   */
  async set(
    query: string,
    agentId: string,
    results: HybridSearchResult[],
    options?: SearchCacheOptions,
  ): Promise<void> {
    const key = await QueryResultCache.hashKey(query, agentId, options);

    // Remove existing entry if present (for re-insertion at end)
    if (this.map.has(key)) {
      this.map.delete(key);
      // Key stays in agentKeys — will be re-added below
    } else if (this.map.size >= this.maxSize) {
      // Evict oldest (first) entry and remove from secondary index
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) {
        const evicted = this.map.get(oldest);
        this.map.delete(oldest);
        if (evicted) {
          this.removeFromAgentIndex(evicted.agentId, oldest);
        }
      }
    }

    // C2: Store a shallow copy so the caller's subsequent mutations cannot corrupt the cache
    this.map.set(key, { results: [...results], expiresAt: Date.now() + this.ttlMs, agentId });
    this.addToAgentIndex(agentId, key);
  }

  /**
   * Invalidate cache entries for a specific agent only.
   * Other agents' entries are unaffected.
   */
  invalidateAgent(agentId: string): number {
    const keys = this.agentKeys.get(agentId);
    if (!keys) return 0;
    let removed = 0;
    for (const key of keys) {
      if (this.map.delete(key)) removed++;
    }
    this.agentKeys.delete(agentId);
    return removed;
  }

  /** Clear the entire cache and secondary index. */
  clear(): void {
    this.map.clear();
    this.agentKeys.clear();
  }

  get size(): number {
    return this.map.size;
  }

  private addToAgentIndex(agentId: string, key: string): void {
    let keys = this.agentKeys.get(agentId);
    if (!keys) {
      keys = new Set();
      this.agentKeys.set(agentId, keys);
    }
    keys.add(key);
  }

  private removeFromAgentIndex(agentId: string, key: string): void {
    const keys = this.agentKeys.get(agentId);
    if (!keys) return;
    keys.delete(key);
    if (keys.size === 0) this.agentKeys.delete(agentId);
  }
}
