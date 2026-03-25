## Context

The memory-neo4j autocapture pipeline processes conversation messages through a multi-stage filter:

1. **Pre-filter** (`shouldCapture` in `extractor.ts`) — heuristic noise rejection on raw `msg.content`
2. **Message extraction** (`extractUserMessages`/`extractAssistantMessages` in `message-utils.ts`) — strips channel wrappers, injected context
3. **Attention gate** (`passesAttentionGate`/`passesAssistantAttentionGate` in `attention-gate.ts`) — length, word count, noise patterns
4. **Importance rating** (`rateImportance` in `extractor.ts`) — LLM-judged 1-10 score, threshold gated
5. **Dedup** (exact + semantic in `auto-capture.ts`)
6. **Post-extraction quality gate** (`extractor.ts:836-844`) — invalidates "decision"/"other" category memories after entity extraction

The problem: stages 1, 3, 4, and 6 are too aggressive and compound to reject most useful content.

## Goals / Non-Goals

**Goals:**

- Retain significantly more important memories from conversations (decisions, contextual facts, longer messages)
- Fix the pre-filter ordering so injected XML context doesn't cause false rejections
- Keep noise rejection effective — the pipeline should still filter greetings, filler, tool output, and system markup

**Non-Goals:**

- Changing the dedup pipeline (exact + semantic dedup is working correctly)
- Changing the sleep cycle or background extraction logic (besides removing the quality gate)
- Changing the `memory_store` tool behavior or explicit memory storage
- Modifying `autoCaptureAssistant` default (stays opt-in)
- Changing embedding or vector search behavior

## Decisions

### D1: Remove post-extraction quality gate entirely

**Decision:** Delete the code block at `extractor.ts:836-844` that invalidates auto-captured memories classified as "decision" or "other".

**Rationale:** The importance rating (stage 4) already filters low-value content. The quality gate double-filters using a different criterion (category) that contradicts the importance signal. A memory rated 8/10 importance but categorized "decision" gets killed — this is wrong. The "other" catch-all category covers many legitimately useful memories.

**Alternative considered:** Narrow the gate to only invalidate "other" — rejected because "other" is too broad and the importance rating already handles quality.

### D2: Move pre-filter after wrapper stripping

**Decision:** In `plugin-hooks.ts`, replace the current flow (shouldCapture on raw content → extractUserMessages) with: extract messages first (which strips wrappers), then run shouldCapture on stripped text.

**Rationale:** Raw messages may start with `<relevant-memories>`, `<system>`, or channel metadata tags. The shouldCapture SYSTEM_MARKUP pattern (`/^(HEARTBEAT_OK|NO_REPLY|<function|tool_call|...)/) and the attention gate's XML pattern (`/^<[a-z-]+>[\s\S]\*<\/[a-z-]+>$/i`) can false-positive on these. Stripping first ensures only the user's actual text is evaluated.

**Implementation:** The pre-filter currently runs per-message in the hook before `runAutoCapture`. Move the shouldCapture check into `runAutoCapture` itself, after `extractUserMessages`/`extractAssistantMessages` have stripped wrappers. This keeps it before the attention gate (preserving the layered filter order).

### D3: Lower importance thresholds to 0.6 / 0.7

**Decision:** Change user message threshold from 0.75 → 0.6, assistant from 0.8 → 0.7.

**Rationale:** The current thresholds require a score of 7.5/10+ (user) or 8/10+ (assistant). The importance prompt defines 5-6 as "Mildly useful — general facts, minor context that might occasionally help" and 7-8 as "Important." By lowering to 0.6/0.7 we capture the upper end of "mildly useful" (score 6+) and the full "important" range (7+) for assistants. This better matches the stated "30-day usefulness" test in the prompt.

### D4: Truncate over-length messages instead of rejecting

**Decision:** In the attention gates, when a message exceeds MAX_CAPTURE_CHARS (2000) or MAX_ASSISTANT_CAPTURE_CHARS (1000), truncate to the cap instead of returning false.

**Rationale:** Long messages often contain important information in the first paragraph. Rejecting entirely loses everything. Truncation preserves the most likely-useful portion (the beginning).

**Implementation:** In `passesAttentionGate` and `passesAssistantAttentionGate`, replace the `> MAX` return-false with truncation. The truncated text continues through the remaining gate checks.

### D5: Refine importance prompt for question-ending messages

**Decision:** Update the KEY RULES in the importance rating prompt to distinguish between pure questions and fact-containing messages that end with a question.

**Current rule:** "Messages ending with questions directed at the user are 1-3 unless they also contain substantial factual content"

**New rule:** "Messages ending with questions directed at the user: score the factual content on its own merit. Only score 1-3 if the message is PURELY a question with no facts worth remembering."

**Rationale:** The current wording biases the LLM toward low scores for any message with a trailing question mark. Many messages share important facts then ask for confirmation — the facts are still worth remembering.

## Risks / Trade-offs

- **More memories stored → higher storage + LLM extraction cost**: With lower thresholds and fewer rejections, the pipeline will store more memories. The extraction LLM (background) runs on each stored memory. Mitigated by: the sleep cycle's decay phase already handles pruning low-value memories over time.
- **Truncation may lose context**: Cutting at 2000/1000 chars means the end of long messages is lost. Mitigated by: decomposition (when enabled) already handles multi-fact messages, and the beginning of a message typically contains the most important content.
- **Pre-filter reordering changes the message array passed to runAutoCapture**: Currently filtered messages (post-shouldCapture) are passed. After the change, all messages are passed and shouldCapture runs inside runAutoCapture on stripped text. The functional result is the same (shouldCapture still runs) but the integration point changes. Mitigated by: existing tests cover both shouldCapture and the attention gates independently.
