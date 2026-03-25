## ADDED Requirements

### Requirement: Single abstention classifier runs on all retrieval paths

The system SHALL run the feature-based `shouldAbstain()` classifier as the sole abstention mechanism, regardless of whether the reranker is enabled or disabled. The classifier SHALL operate on the final candidate list after all reranking, minScore filtering, and topJ truncation have completed.

#### Scenario: Abstention with reranker enabled and weak cross-encoder scores

- **WHEN** the reranker is enabled AND the reranked results have maxScore < 0.35 AND meanScore < 0.25
- **THEN** the classifier SHALL abstain and return an empty result set

#### Scenario: Abstention with reranker disabled and weak RRF scores

- **WHEN** the reranker is disabled AND the RRF results have maxScore < 0.35 AND meanScore < 0.25
- **THEN** the classifier SHALL abstain and return an empty result set

#### Scenario: No abstention when reranker produces strong results

- **WHEN** the reranker is enabled AND the top reranked result has score >= 0.35
- **THEN** the classifier SHALL NOT abstain and results SHALL be returned

### Requirement: Abstention skips graph-only results

The system SHALL skip abstention when all candidates are graph-only (graph rank > 0, vector rank = 0, BM25 rank = 0). This applies on both reranker and non-reranker paths.

#### Scenario: Graph-only results bypass abstention

- **WHEN** all returned candidates have graph signal only (no vector or BM25 signal)
- **THEN** the classifier SHALL NOT run and all candidates SHALL be returned regardless of score

### Requirement: Abstention skips temporal queries

The system SHALL skip abstention for temporal queries (detected via `isTemporalQuery()`). LLM rerankers assign moderate scores (0.8–0.9) to comparison-type queries where multiple memories are jointly relevant; a score-based gate would incorrectly suppress valid results.

#### Scenario: Temporal query bypasses abstention

- **WHEN** the query matches temporal patterns (contains "when", "since", "latest", etc.) or queryType is "updates"
- **THEN** the classifier SHALL NOT run and results SHALL be returned regardless of score

### Requirement: Long query type triggers stricter abstention

The classifier SHALL apply a stricter gate for "long" query type: abstain when fewer than 2 candidates AND maxScore < 0.5. Long queries matched by vector similarity should surface several candidates if the content exists; few results with mediocre scores indicate absent content.

#### Scenario: Long query with single weak result abstains

- **WHEN** queryType is "long" AND only 1 candidate is returned AND its score < 0.5
- **THEN** the classifier SHALL abstain and return an empty result set

#### Scenario: Long query with multiple results does not abstain

- **WHEN** queryType is "long" AND 2+ candidates are returned with maxScore >= 0.35
- **THEN** the classifier SHALL NOT abstain

## REMOVED Requirements

### Requirement: Legacy threshold abstention mode

**Reason**: Replaced by the unified classifier. The threshold mode (`abstention.mode: "threshold"`) was a single scalar comparison with no query-type awareness. No production deployment uses it.
**Migration**: Remove `abstention.mode` from config. The classifier runs unconditionally — no config needed.

### Requirement: Reranker abstentionThreshold

**Reason**: Replaced by the unified classifier running post-reranker. The reranker's `abstentionThreshold` config field and its check in `rerankCandidates()` are removed.
**Migration**: Remove `reranker.abstentionThreshold` from config. The classifier provides equivalent (and superior) abstention coverage.
