## ADDED Requirements

### Requirement: Pre-filter runs on stripped message content

The `shouldCapture` heuristic pre-filter SHALL run on message text after wrapper stripping (channel metadata, injected memory context, system tags) has been applied, not on raw message content.

#### Scenario: Message with injected memory context passes pre-filter

- **WHEN** a user message has raw content starting with `<relevant-memories>...</relevant-memories>` followed by meaningful text
- **THEN** the pre-filter SHALL evaluate only the text after the memory context tags are stripped

#### Scenario: Message with channel wrapper passes pre-filter

- **WHEN** a user message has raw content starting with `[Telegram ...]` wrapper followed by meaningful text
- **THEN** the pre-filter SHALL evaluate only the text after the channel wrapper is stripped

### Requirement: Over-length messages are truncated not rejected

The attention gates SHALL truncate messages that exceed the maximum character limit instead of rejecting them entirely. User messages SHALL be truncated to 2000 characters. Assistant messages SHALL be truncated to 1000 characters.

#### Scenario: User message exceeding 2000 chars is truncated

- **WHEN** a user message is 3500 characters long with important content in the first paragraph
- **THEN** the attention gate SHALL truncate it to 2000 characters and continue evaluating the truncated text through remaining gate checks

#### Scenario: Assistant message exceeding 1000 chars is truncated

- **WHEN** an assistant message is 1500 characters long
- **THEN** the attention gate SHALL truncate it to 1000 characters and continue evaluating the truncated text through remaining gate checks

#### Scenario: Message under length limit is unchanged

- **WHEN** a user message is 500 characters long
- **THEN** the attention gate SHALL process it without truncation

### Requirement: Importance thresholds allow moderately useful content

The autocapture pipeline SHALL use an importance threshold of 0.6 for user messages and 0.7 for assistant messages (when extraction is enabled).

#### Scenario: User message rated 6/10 is stored

- **WHEN** a user message receives an importance score of 6 from the LLM rater (normalized to 0.6)
- **THEN** the pipeline SHALL store it (0.6 meets the 0.6 threshold)

#### Scenario: User message rated 5/10 is rejected

- **WHEN** a user message receives an importance score of 5 from the LLM rater (normalized to 0.5)
- **THEN** the pipeline SHALL reject it (0.5 is below the 0.6 threshold)

#### Scenario: Assistant message rated 7/10 is stored

- **WHEN** an assistant message receives an importance score of 7 from the LLM rater (normalized to 0.7)
- **THEN** the pipeline SHALL store it (0.7 meets the 0.7 threshold)

#### Scenario: Assistant message rated 6/10 is rejected

- **WHEN** an assistant message receives an importance score of 6 from the LLM rater (normalized to 0.6)
- **THEN** the pipeline SHALL reject it (0.6 is below the 0.7 threshold)

### Requirement: Post-extraction gate does not invalidate decision or other categories

The background extraction pipeline SHALL NOT invalidate auto-captured memories based on their extracted category. Memories categorized as "decision" or "other" SHALL remain valid after extraction.

#### Scenario: Auto-captured memory classified as decision is retained

- **WHEN** an auto-captured memory is classified as category "decision" during background extraction
- **THEN** the memory SHALL remain valid with its original importance score and entity graph SHALL be written

#### Scenario: Auto-captured memory classified as other is retained

- **WHEN** an auto-captured memory is classified as category "other" during background extraction
- **THEN** the memory SHALL remain valid with its original importance score and entity graph SHALL be written

#### Scenario: Explicitly stored memory is unaffected

- **WHEN** a memory stored via the `memory_store` tool is classified as any category
- **THEN** the memory SHALL remain valid (no change from current behavior)

### Requirement: Importance rating handles question-ending messages fairly

The importance rating prompt SHALL score messages containing facts that end with questions based on the factual content's merit, not penalize them for ending with a question.

#### Scenario: Factual message ending with confirmation question

- **WHEN** a message says "My birthday is March 15th and I live in Kuala Lumpur. Does that help?"
- **THEN** the importance rater SHALL score based on the personal facts (birthday, location) regardless of the trailing question, resulting in a score of 7+

#### Scenario: Pure question with no factual content

- **WHEN** a message says "What do you think about that?"
- **THEN** the importance rater SHALL score 1-3 as it contains no standalone facts
