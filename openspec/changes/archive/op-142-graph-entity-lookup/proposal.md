## Why

The graph traversal signal (Signal 3) currently uses Entity nodes for navigation but returns Memory nodes as output — making it structurally coupled to the same data source as Signals 1 (vector) and 2 (BM25). This prevents the system from answering factual queries from structured entity properties (e.g. `person.whatsapp`, `organization.website`, `location.country`) because those properties are never surfaced. Structured graph nodes (person, organization, location, tool, etc.) with rich properties already exist in the graph but are invisible to the recall pipeline.

## What Changes

- Decouple `graphSearch()` from Memory nodes entirely — it should traverse entity/structured nodes and return synthesized text from their properties, not Memory text blobs
- Property synthesis is **schema-agnostic**: enumerate `keys(n)` on any traversed node, exclude internal fields (embedding, updatedAt, createdAt, agentId, id), format as `nodeType nodeName — key1: value1, key2: value2, ...`
- Any node label (person, organization, location, event, tool, software, concept, etc.) participates automatically with zero code changes
- The fulltext index (`entity_fulltext_index`) must be expanded or a new index created to cover all structured node labels, not just `Entity` nodes
- RRF fusion remains unchanged — graph signal results use the same `SearchSignalResult` interface, just with synthesized text instead of Memory text
- Redundant Memory text blobs for facts encoded in structured nodes can be retired once this lands

## Capabilities

### New Capabilities

- `graph-entity-lookup`: Schema-agnostic structured entity property lookup via graph traversal. Traverses any node type, collects properties, and synthesizes text results for RRF fusion — independent of Memory nodes.

### Modified Capabilities

- `graph-search`: Signal 3 output changes from Memory node text to synthesized entity property text. The graph signal becomes a pure graph traversal with no Memory node dependency.

## Impact

- **Files:** `neo4j-client-search.ts` (graphSearch rewrite), `search.ts` (RRF fusion — result interface unchanged), `neo4j-client-indexes.ts` (fulltext index expansion)
- **Risk:** Medium — core search pipeline change. The `SearchSignalResult` interface stays identical, so RRF fusion code is unaffected. Existing vector+BM25 paths untouched.
- **Dependencies:** Neo4j fulltext index must cover structured node labels beyond `Entity`
- **Expected gain:** Direct factual entity queries (names, phones, birthdays, locations) answered from graph properties without requiring redundant Memory blobs
- **Eval target:** Query "What is Renu's WhatsApp?" returns correct answer via graph signal alone
