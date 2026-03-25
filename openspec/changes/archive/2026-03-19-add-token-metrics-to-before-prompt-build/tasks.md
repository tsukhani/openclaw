## 1. Type Changes

- [x] 1.1 Add optional `contextWindowTokens` and `estimatedUsedTokens` fields to `PluginHookBeforePromptBuildEvent` in `src/plugins/types.ts`

## 2. Hook Invocation Plumbing

- [x] 2.1 Add `contextWindowTokens?` and `estimatedUsedTokens?` params to `resolvePromptBuildHookResult` in `src/agents/pi-embedded-runner/run/attempt.ts` and forward them into the `before_prompt_build` event object
- [x] 2.2 Forward the same token metrics into the legacy `before_agent_start` event object within `resolvePromptBuildHookResult`
- [x] 2.3 At the call site in `attempt.ts` (~line 2421), compute `contextWindowTokens` from `params.model.contextWindow` and `estimatedUsedTokens` from `estimateMessagesTokens(activeSession.messages)` and pass them to `resolvePromptBuildHookResult`

## 3. Migrate memory-neo4j

- [x] 3.1 In `extensions/memory-neo4j/plugin-hooks.ts`, change the `api.on("before_agent_start", ...)` handler to `api.on("before_prompt_build", ...)` and update the event type from `PluginHookBeforeAgentStartEvent` to `PluginHookBeforePromptBuildEvent`
- [x] 3.2 Update the handler's return type from `PluginHookBeforeAgentStartResult` to `PluginHookBeforePromptBuildResult` (drop model/provider override fields if present)

## 4. Tests

- [x] 4.1 Add tests in `src/agents/pi-embedded-runner/run/attempt.test.ts` verifying that `resolvePromptBuildHookResult` forwards `contextWindowTokens` and `estimatedUsedTokens` to both `before_prompt_build` and `before_agent_start` hooks
- [x] 4.2 Verify memory-neo4j plugin tests still pass after the hook migration; update any test mocks that reference `before_agent_start` to use `before_prompt_build`

## 5. Verification

- [x] 5.1 Run `pnpm tsgo` to confirm no type errors
- [x] 5.2 Run `pnpm test -- src/agents/pi-embedded-runner/run/attempt.test.ts` and `pnpm test -- extensions/memory-neo4j` to confirm tests pass
- [x] 5.3 Run `pnpm check` to confirm lint/format passes
