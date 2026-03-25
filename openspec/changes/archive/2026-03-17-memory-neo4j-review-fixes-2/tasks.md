## 1. Regex DoS guard in deleteMemoriesByPattern

- [x] 1.1 Add `isUnsafeRegex(pattern)` helper in `neo4j-client-memory.ts` that detects nested quantifiers and excessive alternation (>10 pipes)
- [x] 1.2 Call `isUnsafeRegex()` before the Neo4j query in `deleteMemoriesByPattern()`, throwing a descriptive error on rejection
- [x] 1.3 Add tests for nested quantifier rejection (`(a+)+$`, `(.*a{1,})*`), alternation rejection (>10 pipes), and acceptance of simple valid patterns

## 2. Batched entity property writes

- [x] 2.1 Replace the per-entity `tx.run()` loop in `batchEntityOperations()` (neo4j-client-entity.ts:137-149) with a single UNWIND query using `n += row.props` map merge
- [x] 2.2 Add/update tests verifying multiple entities with properties are written in one query and entities without properties are unaffected

## 3. Inline contradiction check at auto-capture

- [x] 3.1 Import `isContradiction` from `extractor.ts` in `auto-capture.ts` (or add if not yet exported)
- [x] 3.2 Extend the semantic dedup loop in `captureMessage()` to call `isContradiction()` when `isSemanticDuplicate()` returns false for candidates in the 0.75-0.95 band
- [x] 3.3 When contradiction detected: set `supersededBy` and `validUntil` on the older memory via `db.supersedeMemory()`, then store the new memory normally
- [x] 3.4 Add tests in `auto-capture.test.ts` for contradiction supersession, non-contradiction passthrough, and skipping when extraction is disabled

## 4. Robust connection error classification

- [x] 4.1 Refactor `isNeo4jConnectionError()` in `errors.ts` to check `err.code` for Neo4j driver codes and OS-level errno codes as the primary classification tier
- [x] 4.2 Move string-based `includes()` checks to a fallback tier, only reached when no structured code property is available
- [x] 4.3 Add/update tests covering code-based detection (ServiceUnavailable, ECONNREFUSED), string fallback (connection acquisition timed out), and rejection of non-connection errors (SyntaxError)
