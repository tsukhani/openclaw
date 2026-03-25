## 1. Index Infrastructure

- [ ] 1.1 Add `structured_entity_fulltext_index` creation in `neo4j-client-indexes.ts` covering labels: person, organization, location, event, tool, software (on `name` property)
- [ ] 1.2 Ensure index creation is additive — existing `entity_fulltext_index` unchanged
- [ ] 1.3 Add index existence check to avoid recreation on every startup

## 2. Structured Entity Lookup

- [ ] 2.1 Create `structuredGraphSearch()` function in `neo4j-client-search.ts` that queries `structured_entity_fulltext_index`
- [ ] 2.2 Implement schema-agnostic property enumeration: `keys(n)` with internal field blocklist (embedding, updatedAt, createdAt, agentId, id)
- [ ] 2.3 Implement text synthesis: `{label} {name} — key1: value1, key2: value2, ...`
- [ ] 2.4 Implement N-hop relationship traversal from matched structured nodes following `ALLOWED_RELATIONSHIP_TYPES`
- [ ] 2.5 Apply confidence decay per hop (score × 0.7 per hop) matching existing graph signal scoring
- [ ] 2.6 Return results as `SearchSignalResult[]` with: id (node element id), text (synthesized), category (node label), importance (0.8 default), createdAt, score

## 3. Graph Search Integration

- [ ] 3.1 Update `graphSearch()` to call both `structuredGraphSearch()` and the legacy Entity→MENTIONS→Memory path
- [ ] 3.2 Merge results from both paths into a single ranked list
- [ ] 3.3 Deduplicate by content similarity — prefer structured result when both paths return equivalent content
- [ ] 3.4 Apply temporal filters (includeExpired, asOf) to structured node queries

## 4. Tests

- [ ] 4.1 Unit test: `structuredGraphSearch()` returns synthesized text from a person node with expected properties
- [ ] 4.2 Unit test: `structuredGraphSearch()` returns synthesized text from a non-person node (organization, location, tool) without type-specific code
- [ ] 4.3 Unit test: Internal fields (embedding, updatedAt, etc.) are excluded from synthesized text
- [ ] 4.4 Unit test: Multi-hop traversal returns connected nodes with decayed scores
- [ ] 4.5 Integration test: `graphSearch()` returns results from both structured and legacy paths
- [ ] 4.6 Integration test: Query "What is Renu's WhatsApp?" returns correct answer via graph signal alone
- [ ] 4.7 Regression test: Existing Memory-based graph search (Entity→MENTIONS→Memory) still works unchanged

## 5. Cleanup

- [ ] 5.1 Add JSDoc comments to `structuredGraphSearch()` explaining the schema-agnostic design
- [ ] 5.2 Update search.ts query classification comments to document the new graph signal behaviour
- [ ] 5.3 Verify build passes (`pnpm build`)
- [ ] 5.4 Verify lint passes (`pnpm lint`)
- [ ] 5.5 Verify tests pass (`pnpm test`)
