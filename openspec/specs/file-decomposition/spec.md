## ADDED Requirements

### Requirement: No source file exceeds 700 LOC

Every TypeScript source file in `extensions/memory-neo4j/` (excluding test files and eval/) SHALL be at most 700 lines of code. Files that currently exceed this limit SHALL be split into focused sub-modules following the existing delegation pattern.

#### Scenario: neo4j-client.ts is under 700 LOC after split

- **WHEN** conflict operations, maintenance operations, and reclassification operations are extracted into `neo4j-client-conflict.ts`, `neo4j-client-maintenance.ts`, and `neo4j-client-reclassify.ts`
- **THEN** `neo4j-client.ts` SHALL be at most 700 LOC
- **AND** the `Neo4jMemoryClient` class SHALL delegate to the extracted modules via session-passing

#### Scenario: extractor.ts is under 700 LOC after split

- **WHEN** semantic dedup, conflict resolution, importance rating, capture filtering, and decomposition are extracted into separate modules
- **THEN** `extractor.ts` SHALL be at most 700 LOC
- **AND** the extraction prompt constants and `extractEntities`/`runBackgroundExtraction` SHALL remain in `extractor.ts`

#### Scenario: cli.ts is under 700 LOC after split

- **WHEN** subcommand handler functions are extracted into `cli-commands.ts`
- **THEN** `cli.ts` SHALL be at most 700 LOC
- **AND** `registerCli()` SHALL contain only the subcommand registration table

#### Scenario: neo4j-client-sleep.ts is under 700 LOC after split

- **WHEN** decay helpers and conflict scan helpers are extracted into `neo4j-client-sleep-decay.ts` and `neo4j-client-sleep-conflict.ts`
- **THEN** `neo4j-client-sleep.ts` SHALL be at most 700 LOC

### Requirement: Split modules preserve the public API surface

All exports from the original files that are imported by other modules within the extension or re-exported from `index.ts` SHALL continue to be importable from their original paths. New sub-modules SHALL be internal implementation details.

#### Scenario: Existing imports remain valid after neo4j-client split

- **WHEN** a consumer imports `Neo4jMemoryClient` from `./neo4j-client.js`
- **THEN** the import SHALL resolve successfully
- **AND** all public methods on the class SHALL remain available with identical signatures

#### Scenario: Existing imports remain valid after extractor split

- **WHEN** a consumer imports `extractEntities`, `rateImportance`, `isSemanticDuplicate`, `shouldCapture`, or `resolveConflict` from `./extractor.js`
- **THEN** each import SHALL resolve successfully via re-exports from `extractor.ts`

#### Scenario: index.ts re-exports are unchanged

- **WHEN** the plugin's `index.ts` re-exports are evaluated
- **THEN** all currently re-exported symbols SHALL still be available
- **AND** no new symbols SHALL be added to the public API surface

### Requirement: Each sub-module has a single responsibility

Each extracted module SHALL encapsulate a single cohesive domain. Functions within a module SHALL share the same data dependencies and be called together in the same operational context.

#### Scenario: neo4j-client-conflict.ts contains only conflict operations

- **WHEN** `neo4j-client-conflict.ts` is examined
- **THEN** it SHALL contain only functions related to conflict detection, pending conflict management, memory invalidation, and supersession
- **AND** it SHALL NOT contain search, entity, or maintenance functions

#### Scenario: extractor-importance.ts contains only importance operations

- **WHEN** `extractor-importance.ts` is examined
- **THEN** it SHALL contain only `rateImportance` and `classifyTemporalStaleness`
- **AND** it SHALL NOT contain entity extraction, dedup, or decomposition logic
