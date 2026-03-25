## ADDED Requirements

### Requirement: Rate-limit exhaustion tracking across auth profiles

The embedded agent runner SHALL track which auth profiles have been exhausted with `rate_limit` errors during a single run using a per-run set of profile IDs. When a profile is marked as failed with a rate-limit reason, its ID SHALL be added to this set.

#### Scenario: Single profile rate-limited

- **WHEN** a run has one auth profile and it returns HTTP 429 (rate_limit)
- **THEN** the profile ID is added to the exhaustion set
- **AND** the set contains exactly 1 entry

#### Scenario: Multiple profiles rate-limited sequentially

- **WHEN** a run has 3 auth profiles and each returns HTTP 429 in sequence during rotation
- **THEN** all 3 profile IDs are present in the exhaustion set after rotation fails

#### Scenario: Non-rate-limit errors do not populate the set

- **WHEN** a profile fails with a non-rate-limit error (e.g., auth, billing, timeout)
- **THEN** the profile ID is NOT added to the rate-limit exhaustion set

### Requirement: Consolidated rate-limit exhaustion log

When all auth profiles for a provider/model are exhausted with rate_limit errors and `advanceAuthProfile()` returns false, the runner SHALL emit a single `log.error` with tag `[rate-limit-exhausted]` that includes the count of exhausted profiles, the provider/model identifier, and the list of all exhausted profile IDs.

#### Scenario: All profiles exhausted with rate_limit

- **WHEN** `advanceAuthProfile()` returns false
- **AND** `rateLimitFailure` is true
- **AND** the exhaustion set is non-empty
- **THEN** a single `log.error` is emitted with format: `[rate-limit-exhausted] All N auth profile(s) exhausted with rate_limit for <provider>/<model>: [<profile1>, <profile2>, ...]`

#### Scenario: Rotation fails but not due to rate_limit

- **WHEN** `advanceAuthProfile()` returns false
- **AND** the failure reason is NOT rate_limit (e.g., auth, billing)
- **THEN** the consolidated `[rate-limit-exhausted]` log is NOT emitted

### Requirement: Cron job early termination on rate-limit exhaustion

When all auth profiles are exhausted with rate_limit errors and the run trigger is `"cron"`, the runner SHALL return immediately with an error result instead of proceeding to model fallback or surface_error.

The returned result SHALL have:

- A payload with `isError: true` and a message indicating the profile count, provider/model, and that the cron job terminated early.
- A `meta.error` with `kind: "rate_limit_exhausted"` and the same message.
- A second `log.error` with tag `[cron-rate-limit-abort]`.

#### Scenario: Cron run hits rate limit on all profiles

- **WHEN** trigger is `"cron"`
- **AND** all auth profiles are exhausted with rate_limit
- **THEN** the runner returns a result with `payloads[0].isError === true`
- **AND** `meta.error.kind === "rate_limit_exhausted"`
- **AND** a `[cron-rate-limit-abort]` log.error is emitted
- **AND** the runner does NOT proceed to the `fallbackConfigured` or `surface_error` branches

#### Scenario: Non-cron run hits rate limit on all profiles

- **WHEN** trigger is NOT `"cron"` (e.g., `"user"`, `"heartbeat"`)
- **AND** all auth profiles are exhausted with rate_limit
- **THEN** the consolidated `[rate-limit-exhausted]` log is emitted
- **AND** the runner proceeds to the existing `fallbackConfigured` or `surface_error` path as before

### Requirement: Rate-limit exhaustion error kind in type system

The `EmbeddedPiRunMeta.error.kind` type union SHALL include `"rate_limit_exhausted"` as a valid value, alongside existing kinds (`context_overflow`, `compaction_failure`, `role_ordering`, `image_size`, `retry_limit`).

#### Scenario: Type union includes rate_limit_exhausted

- **WHEN** a consumer checks `meta.error.kind`
- **THEN** `"rate_limit_exhausted"` is a valid discriminant value
- **AND** TypeScript compilation succeeds when using this value
