## Context

The memory-neo4j extension has grown organically to ~18K source LOC. A code review identified code quality as the weakest area (B+). The four largest files have accumulated responsibility beyond their original scope:

- `neo4j-client.ts` (1709 LOC): Started as a driver wrapper but accumulated ~70 methods spanning connection management, CRUD, search delegation, conflict detection, entity graph ops, credential scan helpers, and retrieval tracking.
- `extractor.ts` (1191 LOC): Mixes entity extraction, importance rating, semantic dedup, conflict resolution, decomposition, background extraction orchestration, and noise filtering.
- `neo4j-client-sleep.ts` (1196 LOC): Contains helpers for decay calculation, temporal staleness, conflict scan, entity operations, and memory pattern matching — all consumed by sleep phase files.
- `cli.ts` (1095 LOC): Single `registerCli()` function containing all subcommand handlers inline.

The codebase already demonstrates good decomposition patterns (search signals in `neo4j-client-search.ts`, entity ops in `neo4j-client-entity.ts`, sleep phases in individual files). The oversized files are the exceptions that didn't follow the established pattern.

## Goals / Non-Goals

**Goals:**

- Reduce all source files to under ~700 LOC following existing decomposition patterns
- Replace hand-rolled config validation with TypeBox schemas (already a dependency)
- Close the three test coverage gaps: plugin lifecycle E2E, community detection units, episodic memory units
- Fix the stale selfEntityCache bug
- Make causal relationship types configurable
- Reduce attention gate iteration overhead
- Change default extraction model to a cost-appropriate option

**Non-Goals:**

- Backend abstraction layer (Neo4j lock-in is a known trade-off, not addressed here)
- New features or behavioral changes to search/retrieval
- Changes to the plugin config schema shape (TypeBox migration must be behavior-identical)
- Changes outside `extensions/memory-neo4j/`

## Decisions

### D1: neo4j-client.ts split strategy

**Decision:** Extract method groups into domain-focused modules that the class delegates to, following the existing pattern of `neo4j-client-search.ts` and `neo4j-client-entity.ts`.

**New modules:**

- `neo4j-client-conflict.ts`: `detectConflicts`, `findConflictingMemories`, `storePendingConflict`, `fetchPendingConflicts`, `clearPendingConflict*`, `incrementPendingConflictRetry`, `invalidateMemory`, `invalidateMemories`, `supersedeMemory`, `fetchMemoriesForRetroactiveConflictScan` (~250 LOC)
- `neo4j-client-maintenance.ts`: `findDuplicateClusters`, `mergeMemoryCluster`, `findDecayedMemories`, `pruneMemories`, `findOrphan*`, `deleteOrphan*`, `findSingleUseTags`, `reconcileEntityMentionCounts`, `migrateTemporalFields`, `deleteMemoriesByPattern`, `deleteMemoriesByIds`, `fetchMemoriesForCredentialScan`, `fetchAllMemoriesForScan`, `fetchMemoriesForTemporalCheck` (~350 LOC)
- `neo4j-client-reclassify.ts`: `listEntitiesForReclassification`, `updateEntityType`, `markEntityReclassification*`, `listRelatedToForReclassification`, `reclassifyRelationship`, `markRelationshipReclassification*`, `closeEntityRelationship`, `expireOrphanedEntityRelationships` (~200 LOC)

**Remaining in neo4j-client.ts (~600 LOC):** Driver lifecycle, `ensureInitialized`, `createSession`, `verifyConnection`, `storeMemory`, `storeManyMemories`, `deleteMemory`, `countMemories`, `getMemoryStats`, `listByCategory`, `listCoreForInjection`, `searchMemoriesByKeywords`, retrieval tracking (buffer + flush), delegation methods to sub-modules, `retryOnTransient`.

**Alternative considered:** Splitting the class entirely into a facade + service objects. Rejected because the class already delegates to stateless module functions — the remaining methods are thin session-lifecycle wrappers that benefit from sharing the driver instance.

### D2: extractor.ts split strategy

**Decision:** Group by domain responsibility.

**New modules:**

- `extractor-dedup.ts`: `isSemanticDuplicate`, `SEMANTIC_DEDUP_VECTOR_THRESHOLD`, related constants (~80 LOC)
- `extractor-conflict.ts`: `resolveConflict` and conflict classification prompt (~100 LOC)
- `extractor-importance.ts`: `rateImportance`, `classifyTemporalStaleness` (~150 LOC)
- `extractor-capture.ts`: `shouldCapture`, `NOISE_PATTERNS` (the pre-filter, not the attention gate) (~80 LOC)
- `extractor-decompose.ts`: `decomposeIntoAtomicFacts` (~80 LOC)

**Remaining in extractor.ts (~600 LOC):** `extractEntities`, `extractTagsOnly`, `groundEntityDescription`, `runBackgroundExtraction`, `withRetry`, `stripCodeFences`, `sanitizeMemoryText`, `MAX_EXTRACTION_TEXT_CHARS`, extraction prompt constants.

### D3: cli.ts split strategy

**Decision:** Extract each subcommand handler into a function in a separate module.

**New module:**

- `cli-commands.ts`: Individual exported functions for each subcommand handler (stats, search, recall, store, forget, entities, sleep, reindex, export/import, etc.)

**Remaining in cli.ts (~300 LOC):** `registerCli()` with subcommand registration table calling into `cli-commands.ts`.

**Alternative considered:** One file per subcommand (cli-stats.ts, cli-search.ts, etc.). Rejected as over-fragmentation — the handlers share deps and types, and a single file keeps them greppable.

### D4: neo4j-client-sleep.ts split strategy

**Decision:** This file contains helper functions consumed by `sleep-phases-*.ts`. Group by the phase they serve.

**New modules:**

- `neo4j-client-sleep-decay.ts`: Decay calculation helpers, temporal staleness queries (~300 LOC)
- `neo4j-client-sleep-conflict.ts`: Conflict scan queries, pending conflict helpers (~300 LOC)

**Remaining in neo4j-client-sleep.ts (~600 LOC):** Extraction helpers, entity batch ops, noise/credential queries, memory pattern matching.

### D5: config.ts TypeBox migration

**Decision:** Replace the hand-rolled `memoryNeo4jConfigSchema.parse()` with a TypeBox schema that produces the same `MemoryNeo4jConfig` type. Use `Type.Transform` for env var resolution and `Type.Object` with `additionalProperties: false` to replicate `assertAllowedKeys`.

**Approach:**

1. Define the TypeBox schema alongside the existing parser (both in config.ts)
2. Add a conformance test that feeds all existing test configs through both parsers and asserts identical output
3. Once green, remove the hand-rolled parser
4. The TypeBox schema doubles as the JSON Schema for `openclaw.plugin.json` validation

**Risk mitigation:** The conformance test catches any behavioral divergence before the old parser is removed.

### D6: selfEntityCache invalidation

**Decision:** Use `fs.watch` on the USER.md file path (when it exists) to invalidate the cache entry on change. Fall back to TTL-based invalidation (5 min) if `fs.watch` is unavailable or the file doesn't exist yet.

**Alternative considered:** TTL-only (simpler). Rejected because a 5-minute stale window is still surprising for a file the user edits during a session. `fs.watch` provides instant invalidation for the common case.

### D7: Configurable causal relationship types

**Decision:** Add a `graphCausalRelTypes` config key (string array, defaults to the current hardcoded list). The causal chain search function reads from config instead of the module constant. Validation uses the existing `sanitizeRelationshipType()`.

**Why not reuse `graphRelTypes`:** That controls which relationship types are traversed in the general graph search. Causal types control a separate, directed traversal mode. Mixing them would be confusing.

### D8: Attention gate pattern optimization

**Decision:** Combine patterns within each category (noise, narration, system) into a single composite regex using alternation (`|`). Keep categories separate for debuggability (knowing _which_ category rejected a message is useful for tuning).

**Before:** ~85 individual `RegExp.test()` calls in a `some()` loop.
**After:** ~6 composite regexes (one per category), each tested once.

**Risk:** Composite patterns are harder to read and modify. Mitigate with inline comments per alternation branch and a test that exercises each branch independently.

### D9: Default extraction model

**Decision:** Change from `anthropic/claude-opus-4-6` to `anthropic/claude-haiku-4-5-20251001`. Add a prominent comment in `config.ts` and a log message at startup when extraction is enabled showing the active model and a cost warning.

**Rationale:** Haiku is ~50x cheaper than Opus for extraction tasks (entity/relationship/tag extraction, importance rating, dedup classification). Extraction quality is sufficient for structured JSON extraction — it doesn't need Opus-level reasoning. Users who want higher quality can explicitly set `extraction.model`.

## Risks / Trade-offs

- **[Import path breakage]** File splits change import paths for any external consumer importing from sub-modules directly. Mitigation: Re-export from the original module path. The plugin's public API surface (via `index.ts` re-exports) is unaffected.
- **[TypeBox migration parity]** Any behavioral difference between old and new parser would silently change config interpretation. Mitigation: Conformance test suite running both parsers on identical inputs before removing the old one.
- **[fs.watch reliability]** `fs.watch` has known platform quirks (double-fire on Linux, different event names). Mitigation: Debounce invalidation (100ms), fall back to TTL if watch errors.
- **[Composite regex maintainability]** Merged attention gate patterns are harder to read than individual patterns. Mitigation: Comment each alternation branch, test each branch independently, keep categories separate.
- **[Default model change]** Existing users relying on implicit Opus quality may see extraction quality changes. Mitigation: Log the active model prominently at startup so the change is visible. Document in changelog.

## Open Questions

- Should the conformance test for TypeBox migration be kept permanently (testing both parsers) or removed after migration is validated? Recommendation: keep as a snapshot test of expected parse behavior.
- Should `graphCausalRelTypes` also affect the `WELL_KNOWN_RELATIONSHIP_TYPES` constant used in extraction prompts, or remain search-only? Recommendation: search-only; extraction prompts should remain broad.
