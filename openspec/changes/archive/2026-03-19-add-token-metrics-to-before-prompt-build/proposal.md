## Why

The `before_prompt_build` hook event is missing `contextWindowTokens` and `estimatedUsedTokens` fields that the legacy `before_agent_start` already exposes. This blocks plugins like `memory-neo4j` from migrating off the deprecated `before_agent_start` hook — its mid-session core-memory refresh feature needs token usage metrics to decide when to re-inject memories. Additionally, the current invocation paths don't actually pass these values even to `before_agent_start`, so the feature is silently broken today.

## What Changes

- Add `contextWindowTokens` and `estimatedUsedTokens` as optional fields to `PluginHookBeforePromptBuildEvent`.
- Compute and pass these values at the `before_prompt_build` call site in `attempt.ts` (the prompt-build phase where model resolution is already complete and token counts are available).
- Also fix the `before_agent_start` legacy invocation in `attempt.ts` to pass these values (it currently only passes `{ prompt, messages }`).
- Migrate `memory-neo4j` from `before_agent_start` to `before_prompt_build`, removing the legacy hook warning from `openclaw status`.

## Capabilities

### New Capabilities

- `prompt-build-token-metrics`: Expose context window and estimated token usage in the `before_prompt_build` hook event, enabling plugins to make token-budget-aware decisions during prompt construction.

### Modified Capabilities

- `plugin-lifecycle-tests`: Add test coverage for the new fields flowing through `before_prompt_build`.

## Impact

- **Types**: `PluginHookBeforePromptBuildEvent` in `src/plugins/types.ts` gains two optional fields (non-breaking).
- **Hook invocation**: `src/agents/pi-embedded-runner/run/attempt.ts` — `resolvePromptBuildHookResult` must source and forward token metrics.
- **Plugin migration**: `extensions/memory-neo4j/plugin-hooks.ts` — handler moves from `before_agent_start` to `before_prompt_build`.
- **Tests**: `src/plugins/hooks.phase-hooks.test.ts` and `extensions/memory-neo4j` tests need updates.
