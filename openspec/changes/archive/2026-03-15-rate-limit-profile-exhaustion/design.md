## Context

The embedded agent runner (`src/agents/pi-embedded-runner/run.ts`) has a retry loop that rotates through auth profiles when API errors occur. When a rate-limit (HTTP 429) error is received, it marks the current profile with a cooldown, advances to the next profile, and retries. The `maybeBackoffBeforeOverloadFailover` function already skips backoff for `rate_limit` (only applies to `overloaded`), so rotation is fast.

The problem: when a provider-wide (account-level) rate limit is hit, every profile fails identically. Each failure triggers `handleAgentEnd` in the subscription layer, logging a separate `embedded_run_agent_end` warning. After exhaustion, non-cron runs fall through to model fallback or `surface_error` with no consolidated summary. Cron runs follow the same path and waste time on the fallback/surface_error flow when the outcome is predetermined.

**Stakeholders**: Gateway operators monitoring logs, cron job reliability.

## Goals / Non-Goals

**Goals:**

- Consolidated `[rate-limit-exhausted]` error log when all profiles fail with rate_limit for a given provider/model.
- Cron jobs terminate early with a structured error (`error.kind: "rate_limit_exhausted"`) once all profiles are exhausted, avoiding futile fallback attempts.
- The cron runner's existing `isError` payload detection (`run.ts:792`) marks the job as `status: "error"`.

**Non-Goals:**

- Changing the rotation speed or adding backoff for rate_limit (fast rotation is the desired behavior).
- Modifying per-attempt `embedded_run_agent_end` logging (those are emitted by the subscription layer and remain useful for debugging individual attempts).
- Handling non-cron runs differently beyond the consolidated log (they still proceed to model fallback or surface_error).
- Parsing `Retry-After` headers (future improvement, orthogonal to this change).

## Decisions

### 1. Track exhausted profiles with a `Set<string>`

**Choice**: A `rateLimitExhaustedProfiles` set scoped to the run loop, populated as each profile is marked failed with `rate_limit`.

**Rationale**: Minimal memory overhead, O(1) lookups, naturally deduplicates if a profile is somehow retried. The set lives alongside existing loop-scoped counters (`runLoopIterations`, `overloadFailoverAttempts`).

**Alternative considered**: Counting rate-limit failures via a simple integer counter. Rejected because the consolidated log benefits from listing the actual profile IDs for operator diagnosis.

### 2. Consolidated log placement: after `advanceAuthProfile()` returns false

**Choice**: Emit the `[rate-limit-exhausted]` error at the point where rotation fails (no more profiles), before the fallback/surface_error branch.

**Rationale**: This is the natural "all profiles exhausted" decision point. Placing it here means non-cron runs still fall through to model fallback (preserving existing behavior), while cron runs return early before that path.

### 3. Cron early termination returns a structured result, not a throw

**Choice**: Return `{ payloads: [{ text, isError: true }], meta: { error: { kind: "rate_limit_exhausted", message } } }` instead of throwing.

**Rationale**: The cron runner at `src/cron/isolated-agent/run.ts:696` catches thrown errors and converts them to `{ status: "error" }`. Returning a structured result with `isError` payloads is detected at line 792 (`hasFatalErrorPayload`) and produces a richer error status with the actual message preserved in `embeddedRunError`. Throwing would lose the structured error kind.

### 4. New error kind in the type union

**Choice**: Add `"rate_limit_exhausted"` to `EmbeddedPiRunMeta.error.kind`.

**Rationale**: Distinguishes this from `"retry_limit"` (generic retry exhaustion) so consumers can react specifically to rate-limit exhaustion (e.g., skip retry scheduling for the next cron interval).

## Risks / Trade-offs

- **[Risk] False positive on single-profile setups**: A single profile hitting rate_limit will immediately produce the consolidated log and (for cron) early termination after one attempt. **Mitigation**: This is correct behavior -- with one profile, exhaustion is immediate. The log message includes the count ("1 auth profile(s)") so operators can distinguish.

- **[Risk] Model fallback skipped for cron**: Cron early termination returns before the `fallbackConfigured` branch. **Mitigation**: If the rate limit is account-level, fallback to a different model on the same provider would also fail. Cross-provider fallback would still help, but the consolidated log gives operators enough signal to configure fallbacks explicitly. The `FailoverError` path for non-cron runs remains unchanged.

- **[Trade-off] Per-attempt warnings remain**: The subscription layer still logs `embedded_run_agent_end` for each failed attempt. The consolidated error is additive, not a replacement. **Rationale**: Per-attempt logs are useful for debugging timing and request IDs; the consolidated log adds the "all exhausted" summary that was missing.
