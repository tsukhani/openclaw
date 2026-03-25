## MODIFIED Requirements

### Requirement: Graph search signal output

The graph search signal (Signal 3) SHALL return results from two paths merged together: (1) structured entity property lookup and (2) legacy Entity→MENTIONS→Memory lookup. Results are deduplicated and merged before returning to RRF fusion.

#### Scenario: Dual-path execution

- **WHEN** `graphSearch()` is called during hybrid search
- **THEN** it MUST execute both the structured entity lookup (new) and the legacy Entity→MENTIONS→Memory path (existing)
- **AND** merge results from both paths into a single ranked list
- **AND** deduplicate by content similarity (prefer structured result when both paths return equivalent content)
- **AND** return the merged list as `SearchSignalResult[]`

#### Scenario: Structured path returns results, legacy path empty

- **WHEN** a query matches a structured `person` node but no `Entity`→`MENTIONS`→`Memory` chain exists for it
- **THEN** the system MUST still return the structured entity result
- **AND** the result MUST participate in RRF fusion normally

#### Scenario: Legacy path returns results, no structured nodes exist

- **WHEN** a query matches Entity nodes that are only connected via MENTIONS to Memory nodes (no structured person/org/etc. nodes)
- **THEN** the system MUST return the legacy Memory-based results as before
- **AND** existing recall behavior MUST NOT regress
