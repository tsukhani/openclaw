## ADDED Requirements

### Requirement: No MENTIONS relationships created during extraction

`batchEntityOperations` SHALL NOT create `(:Memory)-[:MENTIONS]->(:Entity)` relationships. Entity nodes are created/merged independently of Memory nodes.

#### Scenario: Entity extraction creates no MENTIONS

- **WHEN** `batchEntityOperations` runs for a memory with extracted entities
- **THEN** Entity nodes are MERGED (created or matched)
- **THEN** no MENTIONS relationships are created
- **THEN** entity-entity relationships (WORKS_AT, etc.) are still created

### Requirement: No MENTIONS transfer during memory merge

`mergeMemoryCluster` SHALL NOT transfer MENTIONS relationships from deleted memories to the survivor. Only TAGGED relationships are transferred.

#### Scenario: Memory cluster merge skips MENTIONS transfer

- **WHEN** `mergeMemoryCluster` deduplicates a memory cluster
- **THEN** TAGGED relationships are transferred to the survivor
- **THEN** no MENTIONS transfer query is executed

### Requirement: No MENTIONS transfer during entity merge

`mergeEntityPair` and `batchMergeEntityPairs` SHALL NOT transfer MENTIONS relationships. Entity merge only re-points entity-entity relationships and updates `relationshipCount`.

#### Scenario: Entity merge re-points only entity-entity relationships

- **WHEN** `mergeEntityPair` merges entity-B into entity-A
- **THEN** entity-entity relationships (WORKS_AT, etc.) are re-pointed from B to A
- **THEN** no MENTIONS transfer query is executed
- **THEN** `relationshipCount` is updated on the kept entity

### Requirement: No mentionCount property on entities

Entity nodes SHALL NOT use `mentionCount`. The property SHALL NOT be set during creation, incremented during merge, decremented during deletion, or reconciled during sleep.

#### Scenario: New entity has no mentionCount

- **WHEN** `batchEntityOperations` creates a new Entity
- **THEN** the Entity has `relationshipCount` but no `mentionCount`

#### Scenario: reconcileEntityMentionCounts is removed

- **WHEN** sleep cycle Phase 1d runs
- **THEN** only `reconcileEntityRelationshipCounts` is called
- **THEN** no mentionCount reconciliation occurs

### Requirement: No mentionCount decrement on memory deletion

Memory deletion and decay pruning SHALL NOT decrement `mentionCount` on related entities. Entity lifecycle is independent of memory lifecycle.

#### Scenario: Memory deletion does not touch entity properties

- **WHEN** a Memory node is deleted (direct delete, decay prune, or credential scan)
- **THEN** no entity `mentionCount` is decremented
- **THEN** entity nodes remain untouched

### Requirement: Orphan entities defined by entity-entity relationships only

`findOrphanEntities` SHALL consider an entity orphaned when it has no entity-entity relationships. MENTIONS absence is not a factor.

#### Scenario: Entity with entity-entity rels is not orphaned

- **WHEN** an Entity has a WORKS_AT relationship to another Entity but no MENTIONS
- **THEN** `findOrphanEntities` does NOT return it

#### Scenario: Entity with no relationships is orphaned

- **WHEN** an Entity has zero entity-entity relationships and zero MENTIONS
- **THEN** `findOrphanEntities` returns it for deletion

### Requirement: Relationship expiry based on orphaned endpoints only

`expireOrphanedEntityRelationships` SHALL expire entity-entity relationships only when at least one endpoint is orphaned (no entity-entity relationships besides this one, no MENTIONS). It SHALL NOT use MENTIONS co-occurrence to determine relationship validity.

#### Scenario: Relationship between well-connected entities is preserved

- **WHEN** both endpoints of a relationship have other entity-entity relationships
- **THEN** the relationship is NOT expired regardless of MENTIONS presence

### Requirement: Conflict detection uses embedding similarity

`findConflictingMemories` SHALL find conflict candidates using embedding similarity on Memory nodes, not shared-entity MENTIONS traversal.

#### Scenario: Conflict detection finds similar memories without MENTIONS

- **WHEN** `findConflictingMemories` runs
- **THEN** memory pairs are found by vector similarity threshold
- **THEN** no MENTIONS traversal is used

### Requirement: Reclassification context uses text search

`listConceptsForReclassification` and `listRelationshipsForReclassification` SHALL retrieve sample memory contexts by searching Memory.text for the entity name, not by traversing MENTIONS.

#### Scenario: Reclassification gets context via text search

- **WHEN** `listConceptsForReclassification` retrieves context for entity "acme corp"
- **THEN** memories are found by fulltext search on Memory.text matching "acme corp"
- **THEN** no MENTIONS traversal is used

### Requirement: Entity dedup priority uses relationshipCount

`findDuplicateEntityPairs` SHALL use `relationshipCount` (not `mentionCount`) to determine which entity to keep during deduplication.

#### Scenario: Entity with more relationships is kept

- **WHEN** two duplicate entities are found, entity-A has relationshipCount=5, entity-B has relationshipCount=2
- **THEN** entity-A is the keeper and entity-B is removed
