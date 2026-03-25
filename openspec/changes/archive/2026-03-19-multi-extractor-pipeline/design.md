## Context

The memory-neo4j extension extracts entities, relationships, tags, and categories from stored memories using a single-stage LLM call in `extractEntities()` (extractor.ts). This function is called by `runBackgroundExtraction()` during the sleep cycle's Phase 2. The `ExtractionResult` output (entities, relationships, tags, category) is consumed by `batchEntityOperations()` which writes to Neo4j in a single transaction.

`@huggingface/transformers` (v3.3.0) is already in `package.json` but currently unused — it was added for the local cross-encoder reranker. It bundles a WASM ONNX runtime, so no additional native dependencies are needed for neural NER models.

## Goals / Non-Goals

**Goals:**

- Reduce sleep cycle LLM costs by extracting standard named entities locally before LLM fallback
- Reduce extraction latency for memories with clear named entities (people, orgs, locations)
- Extract structured properties (emails, phones, URLs) via regex with higher precision than LLM
- Keep the pipeline transparent — log which stage produced each entity
- Preserve the existing `ExtractionResult` interface and `batchEntityOperations` contract

**Non-Goals:**

- Replacing LLM extraction entirely — relationships, tags, categories, and nuanced entity types still require LLM
- Adding new npm dependencies — use only `@huggingface/transformers` (already present)
- Changing the sleep cycle orchestration in `sleep-phases-extract.ts`
- Changing the entity storage layer in `neo4j-client-entity.ts`
- GLiNER or spaCy integration (no JS port with acceptable maintenance/dep cost)

## Decisions

### D1: 3-stage pipeline inside `extractEntities()`

The pipeline runs inside `extractEntities()`, replacing the single LLM call with:

1. **Stage 0 (regex):** Extract structured properties and candidate entity names from patterns (emails, phones, URLs, dates, @mentions, capitalized multi-word sequences). ~0.1ms, zero cost.
2. **Stage 1 (NER):** Run `Xenova/bert-base-NER` via `@huggingface/transformers` pipeline API. Maps CoNLL labels (PER→person, ORG→organization, LOC→location, MISC→concept). ~50-100ms, zero cost.
3. **Stage 2 (LLM):** If local stages found entities, send them as context in a modified prompt that focuses on relationships, tags, and category. If nothing found, fall back to full extraction prompt. ~500ms, API cost.

**Why inside `extractEntities()` not `runBackgroundExtraction()`:** Keeps the pipeline encapsulated. `runBackgroundExtraction` just calls `extractEntities` and handles the result — no reason to change that contract.

**Alternative considered:** Running stages in parallel and merging. Rejected because Stage 2's prompt benefits from Stage 0+1 output as context, and the local stages are fast enough (<100ms combined) that sequential is fine.

### D2: `@huggingface/transformers` token-classification pipeline

Use the `pipeline("token-classification", "Xenova/bert-base-NER")` API from transformers.js. The model is downloaded and cached on first use (~100MB quantized).

**Why not compromise.js or wink-nlp:** Both are less accurate than BERT-based NER and would add new dependencies. transformers.js is already paid for.

**Why not GLiNER:** The `gliner` npm package has 92 weekly downloads and requires a separate 220MB `onnxruntime-node`. transformers.js already bundles ONNX runtime.

### D3: Lazy model initialization with singleton

The NER pipeline is initialized lazily on first extraction call and cached as a module-level singleton. This avoids the ~2-3s model load time on startup when extraction may not be needed, and shares the loaded model across all sleep cycle batches.

### D4: Confidence-based merge

When both local and LLM produce the same entity (by normalized name), keep the one with higher confidence. Local extractors get a fixed confidence of 0.85 (BERT-base-NER precision on CoNLL-2003). LLM confidence comes from its output. Relationships, tags, and category always come from the LLM (local extractors cannot produce these).

### D5: Modified LLM prompt with pre-extracted context

When local extractors find entities, prepend them to the user message:

```
Previously extracted entities (verified): alice (person), acme corp (organization)

Memory text:
<original text>
```

And add to the system prompt: `"Some entities have already been extracted. Focus on relationships between entities, tags, and category classification. Add any entities the pre-extraction missed."`

This reduces LLM token generation (fewer entities to re-extract) and improves relationship extraction accuracy (entities are already identified).

### D6: Configurable pipeline stages

Add `extraction.localNer.enabled` config option (default: `true`). When disabled, falls back to LLM-only extraction (current behavior). This allows disabling local NER if the model download is undesirable or if accuracy issues emerge.

## Risks / Trade-offs

- **Model download on first use (~100MB):** The quantized BERT model downloads on first extraction. Environments without internet access during sleep cycle will fail Stage 1 gracefully (logs warning, proceeds to LLM). → Mitigation: Model is cached after first download. Stage 1 failure is non-fatal.
- **CoNLL-2003 entity types are limited (PER/ORG/LOC/MISC):** Cannot extract tool, software, product, service, event types locally. → Mitigation: LLM fallback handles these. Local extraction is additive, not exclusive.
- **BERT-base tokenizer has 512 token limit:** Long memories may be truncated for NER. → Mitigation: Truncate to first 512 tokens for NER (most entities appear early in text). LLM still sees full text.
- **WASM ONNX runtime performance varies by platform:** ARM (Apple Silicon) may be slower than x86. → Mitigation: Stage 1 is optional and has graceful fallback. 50-200ms is acceptable.

## Open Questions

None — design is straightforward given the existing dependency and architecture.
