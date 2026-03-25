## ADDED Requirements

### Requirement: Memory nodes have a numeric trust score

Every Memory node SHALL have a `trustScore` property (float, 0.0 to 1.0) indicating the confidence in the memory's reliability and provenance. The trust score SHALL default to `1.0` for existing memories without an explicit score (backward compatible). Higher scores indicate more trustworthy sources.

#### Scenario: Manually stored memory gets maximum trust

- **WHEN** a memory is stored via the `memory_store` tool
- **THEN** the Memory node SHALL have `trustScore: 1.0`

#### Scenario: Auto-captured user message gets default source trust

- **WHEN** a memory is auto-captured from a user message
- **THEN** the Memory node SHALL have `trustScore` set to the configured default for source `"auto-capture"` (default 0.8)

#### Scenario: Auto-captured assistant message gets its source trust

- **WHEN** a memory is auto-captured from an assistant response
- **THEN** the Memory node SHALL have `trustScore` set to the configured default for source `"auto-capture-assistant"` (default 0.7)

#### Scenario: Existing memories without trustScore default to 1.0

- **WHEN** a memory was stored before trust scoring was enabled and has no `trustScore` property
- **THEN** queries SHALL treat the missing value as `1.0`

### Requirement: Trust scores are configurable per source type

The config SHALL accept a `trustScoring.sourceDefaults` map from MemorySource values to default trust scores. Sources not listed SHALL default to `1.0`. The supported source types are: `"user"`, `"auto-capture"`, `"auto-capture-assistant"`, `"memory-watcher"`, `"import"`, `"decomposed"`.

#### Scenario: Custom source defaults are applied

- **WHEN** config specifies `trustScoring.sourceDefaults: { "import": 0.5, "auto-capture": 0.9 }`
- **AND** a memory is auto-captured
- **THEN** the Memory SHALL have `trustScore: 0.9`

#### Scenario: Unlisted source defaults to 1.0

- **WHEN** config specifies `trustScoring.sourceDefaults: { "import": 0.5 }`
- **AND** a memory is stored via the `memory_store` tool (source: "user")
- **THEN** the Memory SHALL have `trustScore: 1.0` (unlisted source default)

### Requirement: Trust score weights retrieval ranking

The hybrid search RRF fusion SHALL incorporate trust scores as a multiplicative weight on the final fused score. A memory with `trustScore: 0.5` SHALL receive half the ranking weight of an otherwise identical memory with `trustScore: 1.0`.

#### Scenario: Higher trust memory ranks above lower trust for equal relevance

- **WHEN** memory A has `trustScore: 1.0` and RRF score 0.8
- **AND** memory B has `trustScore: 0.5` and RRF score 0.8
- **THEN** memory A SHALL rank above memory B in the final results
- **AND** memory A's weighted score SHALL be 0.8 and memory B's SHALL be 0.4

#### Scenario: High relevance overcomes low trust

- **WHEN** memory A has `trustScore: 0.3` and RRF score 0.9
- **AND** memory B has `trustScore: 1.0` and RRF score 0.2
- **THEN** memory A SHALL rank above memory B (0.27 > 0.2)

### Requirement: Quarantined memories are excluded from default recall

Memories with `trustScore: 0.0` SHALL be treated as quarantined and excluded from `memory_recall` results by default. An optional `includeQuarantined` parameter on `memory_recall` SHALL allow retrieval of quarantined memories when explicitly requested.

#### Scenario: Quarantined memory excluded from default recall

- **WHEN** a memory has `trustScore: 0.0`
- **AND** `memory_recall` is called without `includeQuarantined`
- **THEN** the quarantined memory SHALL NOT appear in results

#### Scenario: Quarantined memory included when explicitly requested

- **WHEN** a memory has `trustScore: 0.0`
- **AND** `memory_recall` is called with `includeQuarantined: true`
- **THEN** the quarantined memory SHALL appear in results with its trust score visible

### Requirement: Trust scoring is enabled by default with safe defaults

Trust scoring SHALL be enabled by default (`trustScoring.enabled: true`). All source types SHALL default to `trustScore: 1.0` unless overridden, ensuring no behavioral change for existing deployments that do not configure source defaults.

#### Scenario: Default config preserves existing behavior

- **WHEN** no `trustScoring` config section is provided
- **THEN** all memories SHALL receive `trustScore: 1.0`
- **AND** retrieval ranking SHALL be identical to pre-trust-scoring behavior
