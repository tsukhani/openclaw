/**
 * TypeScript types for the memory-neo4j evaluation harness.
 *
 * Covers:
 * - Dataset format (test cases, memories, fixtures)
 * - Evaluation results (retrieval metrics, context completeness, end-to-end)
 * - Reporter interfaces
 * - Config variants for A/B testing
 */

// ============================================================================
// Ability Types
// ============================================================================

/** Five core memory abilities from LongMemEval taxonomy. */
export type MemoryAbility = "extraction" | "temporal" | "updates" | "multi-session" | "abstention";

// ============================================================================
// Dataset / Fixture Types
// ============================================================================

/** A single memory to store during test setup. */
export type TestMemory = {
  /** Stable ID assigned at fixture load time: "<case-id>-m<index>" */
  id: string;
  text: string;
  category: string;
  importance: number;
  /** Optional session key to simulate multi-session data. */
  sessionKey?: string;
  /** ISO-8601 timestamp (defaults to now at ingest time if not provided). */
  createdAt?: string;
};

/** A single evaluation test case. */
export type TestCase = {
  id: string;
  ability: MemoryAbility;
  /** Memories to store in the eval namespace before running this test. */
  memories: TestMemory[];
  /** The query sent to hybridSearch(). */
  question: string;
  /** Human-readable expected answer (used by LLM judge for E2E grading). */
  golden_answer: string;
  /** IDs of memories that MUST appear in retrieved results (subset). */
  gold_memory_ids: string[];
  metadata?: {
    difficulty?: "easy" | "medium" | "hard";
    notes?: string;
  };
};

/** Raw fixture file format (as loaded from JSON). */
export type FixtureFile = {
  test_cases: TestCase[];
};

// ============================================================================
// Retrieval Evaluation Results
// ============================================================================

/** Signal attribution recorded per retrieved memory. */
export type RetrievedSignals = {
  vector: { rank: number; score: number };
  bm25: { rank: number; score: number };
  graph: { rank: number; score: number };
  recency?: { rank: number; score: number };
};

/** A single retrieved memory result. */
export type RetrievedMemory = {
  id: string;
  text: string;
  score: number;
  rank: number; // 1-indexed position in result list
  signals?: RetrievedSignals;
};

/** Retrieval metrics for a single test case. */
export type CaseRetrievalMetrics = {
  caseId: string;
  ability: MemoryAbility;
  question: string;
  retrieved: RetrievedMemory[];
  goldIds: string[];
  /** How many gold memories were retrieved at K. */
  hitsAtK: number;
  precisionAtK: number;
  recallAtK: number;
  f1AtK: number;
  /** Position of the first relevant result (0 if none found). */
  firstRelevantRank: number;
  /** Reciprocal rank: 1/firstRelevantRank, or 0 if none found. */
  reciprocalRank: number;
  /** Normalized Discounted Cumulative Gain at K. */
  ndcgAtK: number;
};

// ============================================================================
// Context Completeness (LLM Judge — Tier 1)
// ============================================================================

export type ContextVerdict = "COMPLETE" | "PARTIAL" | "INSUFFICIENT";

/** LLM judge verdict for context completeness. */
export type ContextCompletenessResult = {
  caseId: string;
  ability: MemoryAbility;
  verdict: ContextVerdict;
  reasoning: string;
  /** True if judge call succeeded, false on error (treated as INSUFFICIENT). */
  judgeSucceeded: boolean;
};

// ============================================================================
// End-to-End Evaluation Results (Tier 2)
// ============================================================================

export type AnswerCorrectness = "correct" | "incorrect" | "partial";

/** LLM-generated answer and grading result. */
export type EndToEndResult = {
  caseId: string;
  ability: MemoryAbility;
  question: string;
  goldenAnswer: string;
  generatedAnswer: string | null;
  /** LLM judge verdict. */
  correctness: AnswerCorrectness;
  reasoning: string;
  judgeSucceeded: boolean;
};

// ============================================================================
// Aggregate Metrics
// ============================================================================

/** Per-ability aggregate retrieval metrics. */
export type AbilityMetrics = {
  ability: MemoryAbility;
  caseCount: number;
  avgPrecisionAtK: number;
  avgRecallAtK: number;
  avgF1AtK: number;
  avgMRR: number;
  avgNDCG: number;
  /** Fraction of cases with at least one relevant result. */
  hitRate: number;
};

/** Context completeness breakdown. */
export type ContextCompletenessAggregate = {
  total: number;
  complete: number;
  partial: number;
  insufficient: number;
  /** Fraction of COMPLETE verdicts. */
  completenessRate: number;
};

/** End-to-end metrics breakdown. */
export type EndToEndAggregate = {
  total: number;
  correct: number;
  partial: number;
  incorrect: number;
  accuracyRate: number;
};

/** Full evaluation run results. */
export type EvalRunResult = {
  runId: string;
  timestamp: string;
  datasetName: string;
  k: number;
  agentNamespace: string;
  /** Per-case retrieval metrics. */
  retrievalCases: CaseRetrievalMetrics[];
  /** Per-ability aggregate. */
  abilityMetrics: AbilityMetrics[];
  /** Overall aggregate. */
  overall: {
    caseCount: number;
    avgPrecisionAtK: number;
    avgRecallAtK: number;
    avgF1AtK: number;
    avgMRR: number;
    avgNDCG: number;
    hitRate: number;
  };
  /** Context completeness (LLM judge, Tier 1). */
  contextCompleteness?: {
    cases: ContextCompletenessResult[];
    aggregate: ContextCompletenessAggregate;
  };
  /** End-to-end accuracy (Tier 2). */
  endToEnd?: {
    cases: EndToEndResult[];
    aggregate: EndToEndAggregate;
  };
  durationMs: number;
};

// ============================================================================
// Config Variants (A/B Testing)
// ============================================================================

/** A named config variant for A/B testing. */
export type ConfigVariant = {
  name: string;
  graphEnabled: boolean;
  rrfK?: number;
  candidateMultiplier?: number;
  graphSearchDepth?: number;
  graphSeedCap?: number;
  recencyWeight?: number;
};

// ============================================================================
// Eval Runner Options
// ============================================================================

export type EvalOutputFormat = "console" | "json" | "markdown";

export type EvalRunOptions = {
  /** Dataset name to load (e.g. "custom", "longmemeval_s"). */
  dataset: string;
  /** Only run cases for this ability. */
  ability?: MemoryAbility;
  /** Number of results to retrieve per query. */
  k?: number;
  /** Output format. */
  format?: EvalOutputFormat;
  /** If true, run LLM judge for context completeness (Tier 1). */
  judgeContext?: boolean;
  /** If true, run end-to-end answer generation and grading (Tier 2). */
  endToEnd?: boolean;
  /** Named config variant to use. */
  variant?: string;
  /** If true, skip cleanup of eval namespace after run. */
  keepData?: boolean;
  /** Output file path (for JSON/markdown formats). */
  outputFile?: string;
  /** If true, compare against a saved baseline and fail on regression. */
  ciMode?: boolean;
  /** Path to baseline JSON for regression detection. */
  baselinePath?: string;
};
