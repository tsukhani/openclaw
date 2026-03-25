## MODIFIED Requirements

### Requirement: Phase hook event forwarding tests

The phase hook test suite SHALL verify that `before_prompt_build` events include `contextWindowTokens` and `estimatedUsedTokens` when provided by the caller.

#### Scenario: Token metrics flow through to before_prompt_build handler

- **WHEN** `runBeforePromptBuild` is called with an event containing `contextWindowTokens` and `estimatedUsedTokens`
- **THEN** the handler SHALL receive the exact values in the event object

#### Scenario: Token metrics flow through resolvePromptBuildHookResult to both hooks

- **WHEN** `resolvePromptBuildHookResult` is called with token metrics and both `before_prompt_build` and `before_agent_start` hooks are registered
- **THEN** both hook invocations SHALL receive the token metric values in their event objects

### Requirement: memory-neo4j uses before_prompt_build

The memory-neo4j plugin SHALL register its context injection handler on `before_prompt_build` instead of `before_agent_start`, eliminating the legacy hook compatibility warning.

#### Scenario: Plugin registers on before_prompt_build

- **WHEN** memory-neo4j registers its hooks
- **THEN** the core-refresh and auto-recall handler SHALL be on `before_prompt_build`, not `before_agent_start`

#### Scenario: Mid-session refresh uses token metrics from before_prompt_build

- **WHEN** the `before_prompt_build` event includes `contextWindowTokens` and `estimatedUsedTokens` above the refresh threshold
- **THEN** memory-neo4j SHALL trigger mid-session core memory refresh
