## Context

The memory-neo4j extension has three architecture debt items: (1) retry logic is implemented 3 times with inconsistent backoff strategies, (2) connection error handling is copy-pasted 7 times in plugin-tools.ts, and (3) neo4j-client.ts is a 938 LOC facade with ~60 methods that mostly delegate 1:1 to sub-modules.

## Goals / Non-Goals

**Goals:**

- Single shared retry utility with consistent jitter, configurable backoff, abort signal support, and transient error classification
- Single connection error handling wrapper for plugin-tools.ts tool execute handlers
- Reduce neo4j-client.ts from ~60 flat methods to a facade with grouped sub-objects

**Non-Goals:**

- Changing any external behavior (tool responses, search results, error messages)
- Changing the neo4j-client sub-module structure (the split into neo4j-client-memory.ts, neo4j-client-search.ts, etc. is already done)
- Changing the public plugin API surface (tool names, hook events)

## Decisions

### D1: Shared retry utility in `retry.ts`

**Choice**: Create `extensions/memory-neo4j/retry.ts` exporting a single `retryWithBackoff<T>` function:

```typescript
export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  isRetryable?: (err: unknown) => boolean;
  abortSignal?: AbortSignal;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
}

export async function retryWithBackoff<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T>;
```

Backoff formula: `baseDelay * (attempt + 1) * (0.5 + Math.random() * 0.5)` — exponential with 0-50% jitter (matching the current neo4j-client.ts implementation which is the most robust).

**Replaces:**

- `neo4j-client.ts` `retryOnTransient` → uses `isRetryable = isTransientNeo4jError`
- `extractor.ts` `withRetry` → uses `isRetryable = isRetryableLlmError`, returns `null` on exhaust via caller wrapper
- `embeddings.ts` inline retry loops → uses `isRetryable = isRetryableEmbeddingError`

**Why a function, not a class**: Retry is a single operation, not stateful. A function is simpler and more composable.

**Why not a generic library (p-retry, etc.)**: Avoids adding a dependency for ~30 lines of code. The existing implementations are already correct, they just need unification.

### D2: Connection error wrapper in plugin-tools.ts

**Choice**: Extract a `withConnectionGuard` higher-order function:

```typescript
function withConnectionGuard<T>(
  logger: Logger,
  metrics: MetricsCollector,
  operation: string,
  fn: () => Promise<T>,
  fallbackResponse: T,
): Promise<T>;
```

This replaces the 7 `try { ... } catch (err) { if (isNeo4jConnectionError(err)) { ... } throw err; }` blocks with:

```typescript
return withConnectionGuard(
  logger,
  metrics,
  "recall",
  async () => {
    // tool logic
  },
  {
    content: [{ type: "text", text: "Service temporarily unavailable." }],
    details: { error: "neo4j_connection" },
  },
);
```

### D3: Neo4j client facade grouping

**Choice**: Keep `Neo4jMemoryClient` as a single class but organize methods into logical groups using getter-based sub-objects. Each sub-object is a thin wrapper that calls `this.withSession` and delegates to the sub-module function.

```typescript
class Neo4jMemoryClient {
  get memory() {
    return (this._memory ??= new MemoryOps(this));
  }
  get search() {
    return (this._search ??= new SearchOps(this));
  }
  get entity() {
    return (this._entity ??= new EntityOps(this));
  }
  get sleep() {
    return (this._sleep ??= new SleepOps(this));
  }
  // Infrastructure methods stay on the root: ensureInitialized, close, verifyConnection
}
```

**Why lazy getters, not constructor injection**: Avoids circular references and ensures ops objects are only created when accessed.

**Why not separate classes with shared driver**: The session lifecycle (`withSession`, `retryOnTransient`, `withSearchFallback`) is the value of the facade. Splitting into independent classes would require duplicating or sharing this infrastructure. Sub-objects that delegate through the parent preserve it.

**Migration path**: Deprecate direct method access on `Neo4jMemoryClient` with `@deprecated` JSDoc comments. Callers migrate from `db.storeMemory(...)` to `db.memory.store(...)`. Both work during transition.

## Risks / Trade-offs

- [Risk] Callers throughout the codebase reference direct methods like `db.storeMemory()` → Mitigation: Keep old methods as deprecated wrappers during transition. Find-and-replace all call sites in this change.
- [Risk] Sub-object grouping may make some methods harder to discover → Mitigation: Group names match the existing sub-module file names (memory, search, entity, sleep), so the mapping is intuitive.
- [Risk] Shared retry utility may not handle all edge cases of the 3 existing implementations → Mitigation: The `isRetryable` callback makes it fully customizable per caller. Test with existing test suites to verify no regressions.
