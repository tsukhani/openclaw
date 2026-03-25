## 1. Shared Retry Utility

- [x] 1.1 Create `extensions/memory-neo4j/retry.ts` with `retryWithBackoff` function supporting configurable maxAttempts, baseDelayMs, isRetryable callback, abortSignal, and onRetry hook
- [x] 1.2 Extract `isTransientNeo4jError` classifier from `neo4j-client.ts` into `retry.ts`
- [x] 1.3 Replace `retryOnTransient` in `neo4j-client.ts` with `retryWithBackoff` using `isTransientNeo4jError`
- [x] 1.4 Replace `withRetry` in `extractor.ts` with `retryWithBackoff` using existing LLM retryability check
- [x] 1.5 Replace inline retry loops in `embeddings.ts` (embedOpenAI, embedBatchOpenAI, embedOllama) with `retryWithBackoff`
- [x] 1.6 Write tests for `retry.ts` covering jitter, abort signal, non-retryable errors, exhaustion

## 2. Connection Error Wrapper

- [x] 2.1 Create `withConnectionGuard` wrapper function in `plugin-tools.ts` (or a shared utility)
- [x] 2.2 Replace all 7 `isNeo4jConnectionError` catch blocks in `plugin-tools.ts` with `withConnectionGuard`
- [x] 2.3 Verify each tool's error response format is preserved (different tools have different fallback shapes)

## 3. Neo4j Client Facade Grouping

- [ ] 3.1 Create sub-object classes (`MemoryOps`, `SearchOps`, `EntityOps`, `SleepOps`) with methods delegating through parent's `withSession`/`retryOnTransient` — DEFERRED: large refactor, lower priority than retry/guard extraction
- [ ] 3.2 Add lazy getter properties on `Neo4jMemoryClient`: `memory`, `search`, `entity`, `sleep` — DEFERRED
- [ ] 3.3 Migrate all callers to use sub-object access — DEFERRED
- [ ] 3.4 Mark old direct methods as `@deprecated` — DEFERRED

## 4. Verification

- [x] 4.1 Run `pnpm test -- extensions/memory-neo4j/` to verify no regressions
- [x] 4.2 Run `pnpm build` to verify no type errors
- [x] 4.3 Run `pnpm check` to verify formatting/linting
