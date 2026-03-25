## ADDED Requirements

### Requirement: Shared retry utility

The extension SHALL provide a single `retryWithBackoff` function in `retry.ts` that all retry-needing code paths use. The function SHALL support configurable max attempts, base delay, jitter, abort signals, and pluggable retryability classification via an `isRetryable` callback.

#### Scenario: Retry with jitter on transient error

- **WHEN** a function wrapped in `retryWithBackoff` throws a transient error
- **THEN** it retries up to `maxAttempts` times with exponential backoff and 0-50% random jitter: `baseDelay * (attempt + 1) * (0.5 + Math.random() * 0.5)`

#### Scenario: Non-retryable error throws immediately

- **WHEN** a function throws an error and `isRetryable` returns false
- **THEN** the error is thrown immediately without retry

#### Scenario: Abort signal respected

- **WHEN** an abort signal fires during a retry delay
- **THEN** the function throws an `AbortError` immediately without further retries

#### Scenario: All attempts exhausted

- **WHEN** all `maxAttempts` are exhausted
- **THEN** the last error is thrown to the caller

### Requirement: Unified Neo4j retry

The `Neo4jMemoryClient` SHALL use `retryWithBackoff` with `isRetryable = isTransientNeo4jError` instead of the inline `retryOnTransient` method.

#### Scenario: Neo4j deadlock retried

- **WHEN** a Neo4j operation throws a DeadlockDetected error
- **THEN** it is retried via the shared utility with the same 3-attempt, 500ms base delay behavior

### Requirement: Unified LLM extraction retry

The `extractor.ts` `withRetry` function SHALL be replaced by a caller that uses `retryWithBackoff` with `isRetryable = isRetryableLlmError`.

#### Scenario: LLM rate limit retried

- **WHEN** an extraction LLM call returns a 429 or 529 status
- **THEN** it is retried via the shared utility

#### Scenario: LLM 4xx client error not retried

- **WHEN** an extraction LLM call returns a 400 or 422 status
- **THEN** the error is thrown immediately (non-retryable)

### Requirement: Unified embedding retry

The `embeddings.ts` inline retry loops SHALL be replaced by calls to `retryWithBackoff`.

#### Scenario: OpenAI embedding retry with consistent jitter

- **WHEN** an OpenAI embedding call fails transiently
- **THEN** it retries with the same jitter formula as Neo4j and LLM retries (not the previous fixed `300 * 2^attempt`)

### Requirement: Connection error handler wrapper

The `plugin-tools.ts` SHALL use a shared `withConnectionGuard` wrapper instead of 7 copy-pasted `isNeo4jConnectionError` catch blocks.

#### Scenario: Connection error returns fallback

- **WHEN** a tool operation throws a Neo4j connection error
- **THEN** `withConnectionGuard` catches it, logs the error, increments the metric, and returns the fallback response

#### Scenario: Non-connection error rethrown

- **WHEN** a tool operation throws a non-connection error (e.g., code bug)
- **THEN** `withConnectionGuard` rethrows it for debugging

### Requirement: Neo4j client facade grouping

The `Neo4jMemoryClient` SHALL organize its ~60 methods into logical sub-objects accessible via lazy getters: `memory`, `search`, `entity`, `sleep`. Infrastructure methods (`ensureInitialized`, `close`, `verifyConnection`) SHALL remain on the root object.

#### Scenario: Sub-object access

- **WHEN** a caller accesses `db.memory.store(...)`
- **THEN** the call delegates through the parent's `withSession` and retry infrastructure to the sub-module function

#### Scenario: Deprecated direct access

- **WHEN** a caller uses the old `db.storeMemory(...)` pattern
- **THEN** it still works (deprecated wrapper) but the method is marked with `@deprecated` JSDoc
