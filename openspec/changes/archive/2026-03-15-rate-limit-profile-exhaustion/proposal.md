## Why

When the Anthropic API returns HTTP 429 (account-level rate limit), the embedded agent runner rotates through auth profiles one by one, each hitting the same limit. Every failed attempt logs a noisy `embedded_run_agent_end` warning with no consolidated summary. Cron jobs waste their entire retry budget against an unrecoverable provider-wide limit instead of terminating early. This produces log spam, delays error surfacing, and burns API quota headroom.

## What Changes

- Track which auth profiles have been exhausted with `rate_limit` errors during a single embedded agent run.
- When all profiles are exhausted with the same rate-limit error, emit a single consolidated `log.error` with `[rate-limit-exhausted]` tag listing all failed profiles, replacing per-attempt noise.
- For cron-triggered runs (`trigger === "cron"`), return immediately with an `isError` payload and `error.kind: "rate_limit_exhausted"` once all profiles are exhausted, so the cron runner marks the job as `status: "error"` and terminates cleanly.
- Add `"rate_limit_exhausted"` to the `EmbeddedPiRunMeta.error.kind` type union.

## Capabilities

### New Capabilities

- `rate-limit-profile-exhaustion`: Consolidated rate-limit detection across auth profiles with structured error reporting and cron early termination.

### Modified Capabilities

<!-- No existing spec-level behavior changes. The profile rotation mechanism itself is unchanged; only the exhaustion reporting and cron termination are new. -->

## Impact

- **Code**: `src/agents/pi-embedded-runner/run.ts` (retry loop, profile rotation path), `src/agents/pi-embedded-runner/types.ts` (error kind union).
- **Behavior**: Cron jobs that hit provider-wide rate limits will terminate earlier instead of retrying all profiles and falling through to surface_error. Non-cron runs still fall through to model fallback or surface_error as before.
- **Logging**: Operators will see one `[rate-limit-exhausted]` error per run instead of N per-profile warnings, plus a `[cron-rate-limit-abort]` error for cron terminations.
- **APIs/Dependencies**: No external API changes. The new error kind is internal to `EmbeddedPiRunMeta`.
