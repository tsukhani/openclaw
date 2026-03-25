## 1. Type System

- [x] 1.1 Add `"rate_limit_exhausted"` to the `EmbeddedPiRunMeta.error.kind` type union in `src/agents/pi-embedded-runner/types.ts`

## 2. Core Implementation

- [x] 2.1 Add `rateLimitExhaustedProfiles` set (scoped to the run loop) in `src/agents/pi-embedded-runner/run.ts` alongside existing loop counters
- [x] 2.2 Populate the set when a profile fails with `rateLimitFailure` inside the `shouldRotate` block, after `maybeMarkAuthProfileFailure`
- [x] 2.3 After `advanceAuthProfile()` returns false, emit consolidated `[rate-limit-exhausted]` log.error when `rateLimitFailure` is true and the exhaustion set is non-empty
- [x] 2.4 For cron triggers (`params.trigger === "cron"`), return early with `isError` payload and `meta.error.kind: "rate_limit_exhausted"` inside the consolidated-log block, before the `fallbackConfigured` branch
- [x] 2.5 Emit `[cron-rate-limit-abort]` log.error on cron early termination

## 3. Verification

- [x] 3.1 Run `pnpm build` and confirm no type errors
- [x] 3.2 Run auth-profile rotation e2e tests: `pnpm test -- src/agents/pi-embedded-runner.run-embedded-pi-agent.auth-profile-rotation.e2e.test.ts`
- [x] 3.3 Run model-fallback tests: `pnpm test -- src/agents/model-fallback.test.ts src/agents/model-fallback.probe.test.ts src/agents/model-fallback.run-embedded.e2e.test.ts`
- [x] 3.4 Run cron isolated-agent tests: `pnpm test -- src/cron/isolated-agent/run.test-harness.ts src/cron/isolated-agent/run.skill-filter.test.ts`
- [x] 3.5 Run lint/format: `pnpm check`
