## Why

The memory-neo4j sleep cycle extraction phase uses LLM-only entity extraction, costing ~500ms and API tokens per memory. Standard named entities (people, organizations, locations) and structured patterns (emails, phones, URLs) can be extracted locally with near-zero latency and cost. `@huggingface/transformers` is already a dependency but unused — adding a local NER stage before the LLM fallback reduces sleep cycle cost by 30-50% and latency by 60-70% for memories with clear named entities.

## What Changes

- Add a regex/heuristic pre-extractor (Stage 0) for structured patterns: emails, phone numbers, URLs, dates, @mentions
- Add a transformer-based NER extractor (Stage 1) using `@huggingface/transformers` with `Xenova/bert-base-NER` for PER, ORG, LOC, MISC entities
- Add a decision gate that skips or lightens the LLM prompt when local extractors find entities
- Modify the existing LLM extraction (Stage 2) to accept pre-extracted entities as context, focusing its prompt on relationships, tags, and category classification
- Add a confidence-based merge function that combines results from all stages
- The storage layer (`batchEntityOperations`) and sleep cycle orchestration (`sleep-phases-extract.ts`) remain unchanged

## Capabilities

### New Capabilities

- `local-entity-extraction`: Regex/heuristic and transformer-based local entity extraction pipeline that runs before LLM fallback
- `extraction-pipeline-orchestration`: 3-stage pipeline coordinator with decision gate, context passing, and confidence-based merge

### Modified Capabilities

## Impact

- **New file**: `extensions/memory-neo4j/extractor-local.ts` — regex patterns, transformers.js NER wrapper, merge function
- **Modified file**: `extensions/memory-neo4j/extractor.ts` — orchestrate 3-stage pipeline instead of direct LLM call
- **Dependencies**: No new dependencies (`@huggingface/transformers` already in package.json)
- **Model download**: `Xenova/bert-base-NER` (~100MB quantized) downloaded and cached on first use
- **No breaking changes**: `ExtractionResult` interface unchanged, `batchEntityOperations` input unchanged
