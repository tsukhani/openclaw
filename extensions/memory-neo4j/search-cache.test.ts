import { describe, expect, it, vi, beforeEach } from "vitest";
import type { HybridSearchResult } from "./schema.js";
import { QueryResultCache } from "./search-cache.js";

function makeResult(id: string, score: number): HybridSearchResult {
  return {
    id,
    text: `Memory ${id}`,
    category: "fact",
    importance: 0.8,
    createdAt: "2026-01-01T00:00:00Z",
    score,
  };
}

describe("QueryResultCache", () => {
  let cache: QueryResultCache;

  beforeEach(() => {
    cache = new QueryResultCache(3, 5000); // 3 entries, 5s TTL
  });

  it("returns undefined on cache miss", async () => {
    expect(await cache.get("query", "agent-1")).toBeUndefined();
  });

  it("returns cached results on hit", async () => {
    const results = [makeResult("m1", 0.9)];
    await cache.set("query", "agent-1", results);
    expect(await cache.get("query", "agent-1")).toEqual(results);
  });

  it("treats different agentIds as different keys", async () => {
    const r1 = [makeResult("m1", 0.9)];
    const r2 = [makeResult("m2", 0.8)];
    await cache.set("query", "agent-1", r1);
    await cache.set("query", "agent-2", r2);
    expect(await cache.get("query", "agent-1")).toEqual(r1);
    expect(await cache.get("query", "agent-2")).toEqual(r2);
  });

  it("evicts LRU entry when at capacity", async () => {
    await cache.set("q1", "a", [makeResult("m1", 0.9)]);
    await cache.set("q2", "a", [makeResult("m2", 0.8)]);
    await cache.set("q3", "a", [makeResult("m3", 0.7)]);
    // Cache is at capacity (3). Adding q4 should evict q1.
    await cache.set("q4", "a", [makeResult("m4", 0.6)]);
    expect(await cache.get("q1", "a")).toBeUndefined();
    expect(await cache.get("q4", "a")).toBeDefined();
  });

  it("refreshes LRU position on get", async () => {
    await cache.set("q1", "a", [makeResult("m1", 0.9)]);
    await cache.set("q2", "a", [makeResult("m2", 0.8)]);
    await cache.set("q3", "a", [makeResult("m3", 0.7)]);
    // Access q1 to refresh it
    await cache.get("q1", "a");
    // Adding q4 should evict q2 (now oldest), not q1
    await cache.set("q4", "a", [makeResult("m4", 0.6)]);
    expect(await cache.get("q1", "a")).toBeDefined();
    expect(await cache.get("q2", "a")).toBeUndefined();
  });

  it("expires entries after TTL", async () => {
    vi.useFakeTimers();
    try {
      await cache.set("query", "agent-1", [makeResult("m1", 0.9)]);
      expect(await cache.get("query", "agent-1")).toBeDefined();
      // Advance past TTL
      vi.advanceTimersByTime(6000);
      expect(await cache.get("query", "agent-1")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clear() removes all entries", async () => {
    await cache.set("q1", "a", [makeResult("m1", 0.9)]);
    await cache.set("q2", "a", [makeResult("m2", 0.8)]);
    expect(cache.size).toBe(2);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(await cache.get("q1", "a")).toBeUndefined();
  });

  it("invalidateAgent() clears only that agent's entries", async () => {
    await cache.set("q1", "a1", [makeResult("m1", 0.9)]);
    await cache.set("q2", "a2", [makeResult("m2", 0.8)]);
    const removed = cache.invalidateAgent("a1");
    expect(removed).toBe(1);
    expect(cache.size).toBe(1);
    // a2's entry is still intact
    expect(await cache.get("q2", "a2")).toBeDefined();
    expect(await cache.get("q1", "a1")).toBeUndefined();
  });

  it("invalidateAgent() returns 0 for unknown agent", async () => {
    await cache.set("q1", "a1", [makeResult("m1", 0.9)]);
    const removed = cache.invalidateAgent("unknown");
    expect(removed).toBe(0);
    expect(cache.size).toBe(1);
  });

  it("LRU eviction keeps secondary index in sync", async () => {
    // capacity is 3
    await cache.set("q1", "a1", [makeResult("m1", 0.9)]);
    await cache.set("q2", "a2", [makeResult("m2", 0.8)]);
    await cache.set("q3", "a1", [makeResult("m3", 0.7)]);
    // Adding q4 for a2 should evict q1 (oldest, belongs to a1)
    await cache.set("q4", "a2", [makeResult("m4", 0.6)]);
    expect(await cache.get("q1", "a1")).toBeUndefined();
    // Invalidating a1 should only remove q3 (q1 was already evicted)
    const removed = cache.invalidateAgent("a1");
    expect(removed).toBe(1);
    // a2's entries are still intact
    expect(await cache.get("q2", "a2")).toBeDefined();
    expect(await cache.get("q4", "a2")).toBeDefined();
  });

  it("clear() resets both primary cache and secondary index", async () => {
    await cache.set("q1", "a1", [makeResult("m1", 0.9)]);
    await cache.set("q2", "a2", [makeResult("m2", 0.8)]);
    cache.clear();
    expect(cache.size).toBe(0);
    // After clear, invalidateAgent should return 0 (no stale index)
    expect(cache.invalidateAgent("a1")).toBe(0);
    expect(cache.invalidateAgent("a2")).toBe(0);
  });

  it("tracks size correctly", async () => {
    expect(cache.size).toBe(0);
    await cache.set("q1", "a", [makeResult("m1", 0.9)]);
    expect(cache.size).toBe(1);
    await cache.set("q2", "a", [makeResult("m2", 0.8)]);
    expect(cache.size).toBe(2);
  });
});
