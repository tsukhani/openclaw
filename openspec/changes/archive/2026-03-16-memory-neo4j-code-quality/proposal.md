## Why

A comprehensive code review graded memory-neo4j's code quality at B+ — the lowest category score. Four source files exceed 1000 LOC (project guideline: ~700), config parsing is 837 LOC of hand-rolled validation despite TypeBox already being a dependency, test coverage has structural gaps (no E2E plugin lifecycle test, no dedicated community detection or episodic memory unit tests), and several minor bugs and hardcoded values reduce maintainability. Addressing these issues raises code quality to match the A/A- grades in architecture, retrieval, security, and performance.

## What Changes

- Split 4 oversized files into focused sub-modules: `neo4j-client.ts` (1709 LOC), `extractor.ts` (1191 LOC), `neo4j-client-sleep.ts` (1196 LOC), `cli.ts` (1095 LOC)
- Migrate `config.ts` (837 LOC) from hand-rolled validation to TypeBox schemas, leveraging the `@sinclair/typebox` dependency already in `package.json`
- Add E2E plugin lifecycle test exercising register -> start -> tool calls -> stop
- Add dedicated unit tests for community detection (`neo4j-client-community.ts`, `sleep-phases-community.ts`) and episodic memory (`neo4j-client-episode.ts`)
- Fix `selfEntityCache` in `plugin-hooks.ts` to invalidate when USER.md changes (currently persists stale names for entire process lifetime)
- Make `CAUSAL_RELATIONSHIP_TYPES` in `neo4j-client-search.ts` configurable via the existing `graphRelTypes` config pattern instead of hardcoded in Cypher templates
- Combine sequential attention gate regex patterns into fewer composite patterns for reduced iteration overhead
- Change default extraction model from `anthropic/claude-opus-4-6` to a cheaper default and add prominent documentation about cost implications

## Capabilities

### New Capabilities

- `file-decomposition`: Rules and boundaries for splitting oversized memory-neo4j source files into focused sub-modules while preserving the public API surface
- `config-typebox-migration`: Specification for migrating config.ts from hand-rolled parsing to TypeBox schema validation
- `plugin-lifecycle-tests`: Requirements for E2E and unit test coverage gaps (plugin lifecycle, community detection, episodic memory)

### Modified Capabilities

- `community-detection`: Add requirement for dedicated unit tests covering label propagation, community merge, stale link cleanup
- `episodic-memory`: Add requirement for dedicated unit tests covering episode merge, linking, querying, and TTL cleanup

## Impact

- **Code**: All changes scoped to `extensions/memory-neo4j/`. No changes to core OpenClaw or other extensions.
- **Public API**: No changes to tool interfaces (`memory_recall`, `memory_store`, `memory_forget`, `memory_episodes`). No breaking changes to plugin config schema (TypeBox migration preserves identical runtime behavior).
- **Dependencies**: No new dependencies. Leverages existing `@sinclair/typebox` more extensively.
- **Risk**: File splits carry moderate risk of import path breakage in downstream consumers. TypeBox migration must produce identical parse results for all existing config shapes. Both should be validated by the existing test suite plus new E2E tests.
