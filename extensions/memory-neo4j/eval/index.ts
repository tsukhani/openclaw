/**
 * Public surface of the memory-neo4j eval harness.
 *
 * Exports everything needed to run evaluations programmatically or from the CLI.
 */

// Core runner
export { runEval } from "./harness.js";

// Types
export type {
  AbComparisonResult,
  AbilityMetrics,
  AnswerCorrectness,
  BootstrapCI,
  CaseRetrievalMetrics,
  CiMetricsSummary,
  ConfigVariant,
  ContextCompletenessResult,
  ContextVerdict,
  EndToEndResult,
  EvalOutputFormat,
  EvalRunOptions,
  EvalRunResult,
  FixtureFile,
  MemoryAbility,
  MetricComparison,
  MetricDelta,
  RegressionReport,
  RetrievedMemory,
  RetrievedSignals,
  SignalAttributionStats,
  SignalName,
  TestCase,
  TestMemory,
} from "./types.js";

// Dataset loading
export { loadDataset } from "./datasets/loader.js";
export { loadCustomDataset } from "./datasets/custom-adapter.js";
export { loadLongMemEvalDataset } from "./datasets/longmemeval-adapter.js";

// Metrics
export {
  aggregateByAbility,
  aggregateMetrics,
  aggregateOverall,
  computeCaseMetrics,
} from "./metrics/retrieval.js";
export {
  aggregateContextCompleteness,
  evaluateContextCompleteness,
} from "./metrics/context-completeness.js";
export { aggregateEndToEnd, generateAnswer, gradeAnswer } from "./metrics/end-to-end.js";
export { computeSignalAttributionStats } from "./metrics/signal-attribution.js";

// Judge
export { LlmJudge } from "./judges/llm-judge.js";

// Reporters
export { reportConsole } from "./reporters/console.js";
export { formatJson, reportJson, reportJsonStdout } from "./reporters/json.js";
export { formatMarkdown, reportMarkdown, reportMarkdownStdout } from "./reporters/markdown.js";

// A/B comparison
export { reportAbComparison, runAbComparison } from "./ab-compare.js";
export type { AbCompareOptions } from "./ab-compare.js";

// Baseline & CI
export { buildCiSummary, computeRegression, loadBaseline, saveBaseline } from "./baseline.js";

// Variants
export { EVAL_VARIANTS, resolveVariant } from "./variants.js";
export type { SearchConfig } from "./variants.js";
