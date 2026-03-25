## ADDED Requirements

### Requirement: before_prompt_build event exposes context window tokens

The `PluginHookBeforePromptBuildEvent` type SHALL include an optional `contextWindowTokens` field of type `number`, representing the resolved model's total context window size in tokens.

#### Scenario: Model has a declared context window

- **WHEN** the hook runner invokes `before_prompt_build` and the resolved model has a `contextWindow` value
- **THEN** the event object SHALL contain `contextWindowTokens` set to that value

#### Scenario: Model has no declared context window

- **WHEN** the hook runner invokes `before_prompt_build` and the resolved model has no `contextWindow`
- **THEN** the event object SHALL contain `contextWindowTokens` as `undefined`

### Requirement: before_prompt_build event exposes estimated used tokens

The `PluginHookBeforePromptBuildEvent` type SHALL include an optional `estimatedUsedTokens` field of type `number`, representing the approximate number of tokens currently consumed by session messages.

#### Scenario: Session has messages

- **WHEN** the hook runner invokes `before_prompt_build` with a non-empty session
- **THEN** the event object SHALL contain `estimatedUsedTokens` computed from the session messages using the standard token estimation heuristic

#### Scenario: Session has no messages (first turn)

- **WHEN** the hook runner invokes `before_prompt_build` with an empty session
- **THEN** the event object SHALL contain `estimatedUsedTokens` set to `0`

### Requirement: resolvePromptBuildHookResult forwards token metrics

The `resolvePromptBuildHookResult` function SHALL accept optional `contextWindowTokens` and `estimatedUsedTokens` parameters and forward them into the `before_prompt_build` event and the legacy `before_agent_start` event.

#### Scenario: Token metrics are provided

- **WHEN** `resolvePromptBuildHookResult` is called with `contextWindowTokens` and `estimatedUsedTokens`
- **THEN** both `before_prompt_build` and `before_agent_start` hook invocations SHALL receive these values in their event objects

#### Scenario: Token metrics are not provided

- **WHEN** `resolvePromptBuildHookResult` is called without token metrics
- **THEN** hooks SHALL receive `undefined` for both fields (non-breaking)

### Requirement: attempt.ts call site computes and passes token metrics

The call site in `attempt.ts` that invokes `resolvePromptBuildHookResult` SHALL compute `contextWindowTokens` from `params.model.contextWindow` and `estimatedUsedTokens` from `estimateMessagesTokens(activeSession.messages)` and pass them through.

#### Scenario: Standard agent run with resolved model

- **WHEN** the agent attempt reaches the prompt-build phase
- **THEN** it SHALL pass the model's context window and estimated message token count to `resolvePromptBuildHookResult`
