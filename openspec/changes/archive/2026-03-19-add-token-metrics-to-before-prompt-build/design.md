## Context

The plugin hook lifecycle has three hooks for pre-prompt phases:

1. `before_model_resolve` — runs early, before model resolution; only has `prompt`.
2. `before_prompt_build` — runs after session messages are loaded, before LLM submission; has `prompt` + `messages`.
3. `before_agent_start` (legacy) — combines both phases; type declares `contextWindowTokens` and `estimatedUsedTokens` but the invocation paths never actually pass them.

The `memory-neo4j` plugin uses `before_agent_start` and reads `contextWindowTokens`/`estimatedUsedTokens` to decide when to re-inject core memories mid-session (when context usage exceeds a threshold). Because:

- The legacy invocations don't pass these values, the feature is silently broken today.
- The newer `before_prompt_build` event doesn't declare these fields at all, blocking migration.

Token estimation already exists: `estimateMessagesTokens()` in `src/agents/compaction.ts` provides a rough token count from `AgentMessage[]`. The model's context window is available as `params.model.contextWindow` at the `attempt.ts` call site.

## Goals / Non-Goals

**Goals:**

- Add `contextWindowTokens` and `estimatedUsedTokens` to `PluginHookBeforePromptBuildEvent`.
- Pass computed values at the `attempt.ts` call site (`resolvePromptBuildHookResult`).
- Also fix the legacy `before_agent_start` invocation in `attempt.ts` to pass these values (it currently only sends `{ prompt, messages }`), so legacy consumers work too.
- Migrate `memory-neo4j` from `before_agent_start` to `before_prompt_build`.
- Add test coverage for the new fields.

**Non-Goals:**

- Changing the `before_model_resolve` event (token metrics aren't available at that phase).
- Changing the token estimation algorithm.
- Removing `before_agent_start` support (it remains for backward compat).
- Migrating any other plugin.

## Decisions

### 1. Optional fields on the event type

Both fields are `number | undefined` (optional), matching the legacy `before_agent_start` pattern. This keeps the hook contract non-breaking — existing `before_prompt_build` handlers that don't use these fields are unaffected.

**Alternative considered:** Required fields. Rejected because a plugin should still work if the runner can't compute token metrics (e.g. model has no declared context window).

### 2. Token estimation via `estimateMessagesTokens`

Use the existing `estimateMessagesTokens(activeSession.messages)` from `src/agents/compaction.ts`. This is the same rough heuristic used throughout the codebase for compaction decisions.

**Alternative considered:** Precise tokenizer. Rejected — too slow for a per-turn hook; the rough estimate is sufficient for threshold-based decisions (memory-neo4j uses 50%+ thresholds).

### 3. Thread token metrics through `resolvePromptBuildHookResult` params

Add `contextWindowTokens?: number` and `estimatedUsedTokens?: number` to the params object of `resolvePromptBuildHookResult`. The caller in `attempt.ts` computes them from `params.model.contextWindow` and `estimateMessagesTokens(activeSession.messages)`, then passes them through. The function forwards them into both `runBeforePromptBuild` and the legacy `runBeforeAgentStart` events.

### 4. memory-neo4j: replace `before_agent_start` with `before_prompt_build`

The handler currently registers `api.on("before_agent_start", ...)`. Replace with `api.on("before_prompt_build", ...)` and adapt the event type. The handler logic (core refresh + auto-recall) is unchanged — it just reads from `PluginHookBeforePromptBuildEvent` instead of `PluginHookBeforeAgentStartEvent`. The `messages` field is required (not optional) in the new event, which is actually more correct for the plugin's use case.

## Risks / Trade-offs

- **Token estimation accuracy** — `estimateMessagesTokens` is approximate (~4 chars/token). This is fine for the threshold-based decisions memory-neo4j makes. No mitigation needed.
- **Performance** — `estimateMessagesTokens` iterates all messages and stringifies them. This already runs for compaction; calling it once more per turn for hooks adds negligible overhead.
- **Breaking memory-neo4j on older cores** — If someone runs a newer memory-neo4j against an older core that doesn't pass token metrics, the fields will be `undefined` and the mid-session refresh feature simply won't trigger (same as today). Graceful degradation.
