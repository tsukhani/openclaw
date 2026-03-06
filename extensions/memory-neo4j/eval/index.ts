/**
 * Public surface of the memory-neo4j eval harness.
 *
 * Exports everything needed to run evaluations programmatically or from the CLI.
 */

// Core runner
export { runEval } from "./harness.js";

// Types
export type {
  AbilityMetrics,
  AnswerCorrectness,
  CaseRetrievalMetrics,
  ConfigVariant,
  ContextCompletenessResult,
  ContextVerdict,
  EndToEndResult,
  EvalOutputFormat,
  EvalRunOptions,
  EvalRunResult,
  FixtureFile,
  MemoryAbility,
  RetrievedMemory,
  RetrievedSignals,
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

// Judge
export { LlmJudge } from "./judges/llm-judge.js";

// Reporters
export { reportConsole } from "./reporters/console.js";
export { formatJson, reportJson, reportJsonStdout } from "./reporters/json.js";
export { formatMarkdown, reportMarkdown, reportMarkdownStdout } from "./reporters/markdown.js";
