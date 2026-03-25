## ADDED Requirements

### Requirement: Regex extractor extracts structured properties

The system SHALL extract structured properties from memory text using regex patterns: email addresses, phone numbers, URLs, dates (ISO-8601 and natural language), and @mentions. Extracted properties SHALL be attached to candidate entity names derived from surrounding context (e.g., "Alice's email is alice@example.com" → entity "alice" with property email: "alice@example.com"). When no surrounding entity context exists, properties SHALL be returned as standalone entries.

#### Scenario: Email extraction

- **WHEN** memory text contains "reach Alice at alice@acme.com"
- **THEN** extractor returns entity "alice" with properties `{ email: "alice@acme.com" }`

#### Scenario: Phone number extraction

- **WHEN** memory text contains "Bob's number is 012-345-6789"
- **THEN** extractor returns entity "bob" with properties `{ phone: "012-345-6789" }`

#### Scenario: URL extraction

- **WHEN** memory text contains "docs are at https://docs.example.com/guide"
- **THEN** extractor returns a property `{ url: "https://docs.example.com/guide" }`

#### Scenario: No structured patterns

- **WHEN** memory text contains no emails, phones, URLs, or dates
- **THEN** extractor returns empty entities and empty properties

### Requirement: NER extractor extracts named entities via transformer model

The system SHALL use `@huggingface/transformers` with the `Xenova/bert-base-NER` model to extract named entities from memory text. CoNLL entity labels SHALL be mapped to schema entity types: B-PER/I-PER → "person", B-ORG/I-ORG → "organization", B-LOC/I-LOC → "location", B-MISC/I-MISC → "concept". Entities SHALL be normalized to lowercase. The NER model SHALL be initialized lazily on first use and cached as a singleton.

#### Scenario: Person extraction

- **WHEN** memory text contains "Met with John Smith at the conference"
- **THEN** extractor returns entity `{ name: "john smith", type: "person" }` with confidence 0.85

#### Scenario: Organization extraction

- **WHEN** memory text contains "Signed contract with Acme Corporation"
- **THEN** extractor returns entity `{ name: "acme corporation", type: "organization" }` with confidence 0.85

#### Scenario: Multiple entity types

- **WHEN** memory text contains "Alice from SpaceX visited Tokyo"
- **THEN** extractor returns entities for "alice" (person), "spacex" (organization), "tokyo" (location)

#### Scenario: Model initialization failure

- **WHEN** the NER model fails to load (network error, missing model)
- **THEN** extractor logs a warning and returns empty results (non-fatal)

#### Scenario: Long text truncation

- **WHEN** memory text exceeds 512 tokens
- **THEN** extractor processes only the first 512 tokens for NER

### Requirement: NER pipeline is lazily initialized singleton

The NER pipeline SHALL be initialized on first invocation of the local extractor and cached for subsequent calls. The initialization SHALL NOT block extension startup. The pipeline SHALL be configurable via `extraction.localNer.enabled` (default: true).

#### Scenario: First extraction call

- **WHEN** `extractLocal()` is called for the first time
- **THEN** the NER pipeline is initialized and cached, then extraction proceeds

#### Scenario: Subsequent extraction calls

- **WHEN** `extractLocal()` is called after initialization
- **THEN** the cached pipeline is reused without re-initialization

#### Scenario: Local NER disabled

- **WHEN** `extraction.localNer.enabled` is false
- **THEN** `extractLocal()` returns empty results without initializing the model

### Requirement: Local extraction results conform to ExtractionResult

The local extractor SHALL return results in the `ExtractionResult` format (`{ entities, relationships, tags, category }`). Relationships SHALL always be empty (local extractors cannot determine relationships). Tags SHALL always be empty. Category SHALL always be undefined. Only entities and their properties SHALL be populated.

#### Scenario: Output format

- **WHEN** local extraction completes with entities found
- **THEN** result has `entities: [...]`, `relationships: []`, `tags: []`, `category: undefined`
