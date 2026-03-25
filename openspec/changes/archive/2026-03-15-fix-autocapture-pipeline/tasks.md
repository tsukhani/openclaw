## 1. Remove post-extraction quality gate

- [x] 1.1 Delete the quality gate block in `extractor.ts` (lines 833-845) that invalidates auto-captured memories with category "decision" or "other"
- [x] 1.2 Update/remove related tests in `extractor.test.ts` that assert the invalidation behavior

## 2. Move pre-filter after wrapper stripping

- [x] 2.1 Remove the `shouldCapture` pre-filter loop from `plugin-hooks.ts` (lines 565-583) — pass all messages to `runAutoCapture`
- [x] 2.2 Add `shouldCapture` filtering inside `runAutoCapture` in `auto-capture.ts`, applied to the stripped text output of `extractUserMessages`/`extractAssistantMessages`
- [x] 2.3 Update tests in `auto-capture.test.ts` and `plugin-hooks.test.ts` to reflect the new filter location

## 3. Lower importance thresholds

- [x] 3.1 Change user message importance threshold from 0.75 to 0.6 in `auto-capture.ts` (line 357/364/368)
- [x] 3.2 Change assistant message importance threshold from 0.8 to 0.7 in `auto-capture.ts` (line 373)
- [x] 3.3 Update any tests that assert the old threshold values

## 4. Truncate over-length messages

- [x] 4.1 In `passesAttentionGate` (`attention-gate.ts`), replace the `> MAX_CAPTURE_CHARS` rejection with truncation — mutate the text to the cap length and continue evaluation
- [x] 4.2 In `passesAssistantAttentionGate` (`attention-gate.ts`), replace the `> MAX_ASSISTANT_CAPTURE_CHARS` rejection with truncation
- [x] 4.3 Refactor both gate functions to return the (possibly truncated) text instead of just a boolean, so downstream consumers use the truncated version
- [x] 4.4 Update `runAutoCapture` in `auto-capture.ts` to use the returned text from the gate functions
- [x] 4.5 Add tests for truncation behavior in attention gate tests

## 5. Refine importance rating prompt

- [x] 5.1 Update the question-ending rule in `IMPORTANCE_RATING_SYSTEM` prompt in `extractor.ts` to score factual content on its own merit regardless of trailing questions
- [x] 5.2 Update importance rating tests if any assert on the old prompt text

## 6. Verify and build

- [x] 6.1 Run `pnpm build` to verify no type errors
- [x] 6.2 Run `pnpm test -- extensions/memory-neo4j/` to verify all tests pass
- [x] 6.3 Run `pnpm check` to verify lint/format
