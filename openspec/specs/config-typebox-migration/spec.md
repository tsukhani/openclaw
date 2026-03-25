## ADDED Requirements

### Requirement: Config parsing uses TypeBox schema validation

The `memoryNeo4jConfigSchema.parse()` method SHALL be implemented using TypeBox (`@sinclair/typebox`) schema definitions instead of hand-rolled validation logic. The TypeBox schema SHALL produce the identical `MemoryNeo4jConfig` type.

#### Scenario: TypeBox schema parses a valid full config

- **WHEN** a config object with all sections populated is passed to `memoryNeo4jConfigSchema.parse()`
- **THEN** the returned `MemoryNeo4jConfig` SHALL match the result produced by the previous hand-rolled parser for the same input

#### Scenario: TypeBox schema rejects unknown keys

- **WHEN** a config object contains unknown keys (e.g., `{"neo4j": {...}, "unknownField": true}`)
- **THEN** `parse()` SHALL throw an error listing the unknown keys
- **AND** the error message SHALL match the format of the previous `assertAllowedKeys` errors

#### Scenario: TypeBox schema resolves environment variables

- **WHEN** a config value contains `${NEO4J_PASSWORD}` and that env var is set
- **THEN** the parsed value SHALL contain the resolved env var value
- **AND** env vars not matching the allowlist (`NEO4J_`, `OPENAI_`, `ANTHROPIC_`, `OLLAMA_`, `MEMORY_`, `OPENCLAW_`) SHALL cause an error

#### Scenario: TypeBox schema applies defaults for omitted optional fields

- **WHEN** a minimal config with only `neo4j` and `embedding` sections is provided
- **THEN** `autoCapture` SHALL default to `true`
- **AND** `autoRecall` SHALL default to `true`
- **AND** `autoRecallMinScore` SHALL default to `0.25`
- **AND** `graphSearchDepth` SHALL default to `4`
- **AND** `recencyWeight` SHALL default to `0.1`
- **AND** all other optional fields SHALL have their documented defaults

### Requirement: Conformance test validates migration parity

A conformance test SHALL verify that the TypeBox-based parser and the hand-rolled parser produce identical results for a comprehensive set of config inputs. This test SHALL be kept permanently as a regression guard.

#### Scenario: Conformance test covers all config shapes

- **WHEN** the conformance test runs
- **THEN** it SHALL feed at least 10 distinct config shapes through both parsers
- **AND** assert deep equality of the output `MemoryNeo4jConfig` objects
- **AND** cover: minimal config, full config, env var resolution, regex patterns, all embedding providers, all extraction routing paths, and edge cases (empty password, unknown model)

#### Scenario: Conformance test covers error paths

- **WHEN** the conformance test runs invalid configs
- **THEN** both parsers SHALL throw errors with matching semantics
- **AND** cover: missing neo4j section, invalid URI scheme, unknown embedding provider, out-of-range values, invalid regex patterns, invalid timezone

### Requirement: Config LOC is reduced

After migration, `config.ts` SHALL be at most 500 LOC (reduced from 837). The TypeBox schema definitions SHALL replace the verbose manual parsing, type coercion, and validation logic.

#### Scenario: config.ts line count after migration

- **WHEN** `config.ts` is measured after the TypeBox migration is complete
- **THEN** the file SHALL be at most 500 LOC
