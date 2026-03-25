## 1. Local Extractor Module

- [x] 1.1 Create `extensions/memory-neo4j/extractor-local.ts` with regex extractor (Stage 0): email, phone, URL, date, @mention patterns. Return `ExtractionResult` with entities + properties, empty relationships/tags/category
- [x] 1.2 Add NER extractor (Stage 1) using `@huggingface/transformers` `pipeline("token-classification", "Xenova/bert-base-NER")` with lazy singleton initialization. Map B-PER/I-PER→person, B-ORG/I-ORG→organization, B-LOC/I-LOC→location, B-MISC/I-MISC→concept. Normalize names to lowercase, set confidence 0.85
- [x] 1.3 Add `extractLocal()` function that runs Stage 0 then Stage 1, merges their results, and returns a combined `ExtractionResult`. Handle Stage 0/1 failures gracefully (log warning, return partial results)
- [x] 1.4 Add text truncation for NER: limit input to ~512 tokens (conservative char estimate) for the transformer model while preserving full text for other stages

## 2. Merge Function

- [x] 2.1 Add `mergeExtractionResults(local: ExtractionResult, llm: ExtractionResult): ExtractionResult` — merge entities by normalized name using higher confidence. Merge properties from local into LLM entity when LLM entity wins on confidence. Take relationships, tags, category from LLM only
- [x] 2.2 Handle edge cases: null/undefined LLM result (return local only), null/undefined local result (return LLM only), both empty (return empty)

## 3. Pipeline Orchestration

- [x] 3.1 Modify `extractEntities()` in `extractor.ts` to call `extractLocal()` before the LLM call. Pass local results to a modified LLM prompt when entities were found
- [x] 3.2 Add the pre-extracted context prompt: prepend "Previously extracted entities (verified): ..." to user message and add system instruction to focus on relationships/tags/category when local entities exist
- [x] 3.3 Merge LLM result with local result using `mergeExtractionResults()` before returning
- [x] 3.4 When local extraction finds nothing, use the original full extraction prompt (no behavioral change)

## 4. Configuration

- [x] 4.1 Add `extraction.localNer.enabled` (boolean, default true) to the config schema in `config.ts`. When false, skip Stage 0+1 entirely
- [x] 4.2 Add config UI hint for the new option in `openclaw.plugin.json`

## 5. Tests

- [x] 5.1 Unit tests for regex extractor: email, phone, URL, date extraction, no-match case, malformed input
- [x] 5.2 Unit tests for NER extractor: mock the transformers.js pipeline, verify entity type mapping, confidence assignment, lowercase normalization, long text truncation
- [x] 5.3 Unit tests for merge function: same-name higher-confidence wins, different entities combined, properties merged, LLM-only fields preserved, null handling
- [x] 5.4 Integration test for full pipeline: local finds entities → lighter LLM prompt → merged result. Local finds nothing → full LLM prompt
- [x] 5.5 Test graceful degradation: NER init failure → pipeline still works via LLM-only
