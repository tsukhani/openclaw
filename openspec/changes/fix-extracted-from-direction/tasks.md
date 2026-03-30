## 1. Fix Cypher Query Directions

- [ ] 1.1 Fix community search direction in `neo4j-client-search.ts:270` — change `(mem:Memory)-[:EXTRACTED_FROM]->(entity)` to `(mem:Memory)<-[:EXTRACTED_FROM]-(entity)`
- [ ] 1.2 Fix MPFP bridge direction in `mpfp-search.ts:181` — change `(m:Memory)-[:EXTRACTED_FROM]->(e:Entity)` to `(m:Memory)<-[:EXTRACTED_FROM]-(e:Entity)`
- [ ] 1.3 Fix stale entity detection in `neo4j-client-observation.ts:47` — change `(e:Entity)<-[:EXTRACTED_FROM]-(m:Memory)` to `(e:Entity)-[:EXTRACTED_FROM]->(m:Memory)`
- [ ] 1.4 Fix observation context query in `neo4j-client-observation.ts:116` — same direction fix
- [ ] 1.5 Fix memory text collection in `neo4j-client-observation.ts:141` — same direction fix
- [ ] 1.6 Fix reflection candidates in `sleep-phases-reflect.ts:198` — change `(e:Entity)<-[:EXTRACTED_FROM]-(m:Memory)` to `(e:Entity)-[:EXTRACTED_FROM]->(m:Memory)`

## 2. Update Tests

- [ ] 2.1 Update `mpfp-search.test.ts` — fix query pattern match string to use corrected direction
- [ ] 2.2 Verify `sleep-phases-observations.test.ts` mock query matches still work with corrected direction
- [ ] 2.3 Verify `sleep-phases-reflect.test.ts` mock query matches still work with corrected direction

## 3. Verification

- [ ] 3.1 Run `pnpm test -- extensions/memory-neo4j/` to verify all tests pass
