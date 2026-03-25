## Why

The memory-neo4j autocapture pipeline silently drops important information through multiple overly aggressive filters. Users report that conversations with meaningful content (decisions, contextual facts, longer messages) are not being retained in memory. The pipeline has six distinct failure points that compound to reject the majority of auto-captured content before it can be stored or recalled.

## What Changes

- Remove the post-extraction quality gate that invalidates all "decision" and "other" category auto-captured memories — these categories cover most useful information
- Move the `shouldCapture()` heuristic pre-filter to run after message wrapper stripping, so injected context tags don't cause false rejections
- Lower importance thresholds from 0.75/0.8 to 0.6/0.7 for user/assistant messages respectively
- Truncate messages exceeding length caps (2000 user / 1000 assistant) instead of silently rejecting them
- Refine the importance rating prompt so messages containing facts but ending with questions aren't blanket-scored 1-3
- Keep `autoCaptureAssistant` default as opt-in (no behavior change) but ensure it's clearly documented

## Capabilities

### New Capabilities

- `autocapture-quality-gates`: Covers the filtering, importance rating, length handling, and pre-filter ordering for the autocapture pipeline

### Modified Capabilities

(none — no existing specs to modify)

## Impact

- `extensions/memory-neo4j/extractor.ts` — post-extraction quality gate removal, importance rating prompt refinement
- `extensions/memory-neo4j/plugin-hooks.ts` — pre-filter ordering (strip before shouldCapture)
- `extensions/memory-neo4j/auto-capture.ts` — importance thresholds, length truncation logic
- `extensions/memory-neo4j/attention-gate.ts` — truncation instead of rejection for over-length messages
- No API changes, no schema changes, no breaking changes
- More memories will be stored — may increase Neo4j storage usage and extraction LLM calls slightly
