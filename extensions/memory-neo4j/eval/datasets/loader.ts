/**
 * Dataset loading interface for the eval harness.
 *
 * Supports loading test cases from:
 * - Custom JSON fixtures (built-in domain-specific test cases)
 * - LongMemEval format (external benchmark)
 */

import type { MemoryAbility, TestCase } from "../types.js";
import { loadCustomDataset } from "./custom-adapter.js";
import { loadHybridDataset } from "./hybrid-adapter.js";
import { loadLoCoMoDataset } from "./locomo-adapter.js";
import { loadLongMemEvalDataset } from "./longmemeval-adapter.js";

export type DatasetLoadOptions = {
  /** Filter to a specific memory ability. */
  ability?: MemoryAbility;
  /** Max number of test cases to load (useful for quick smoke tests). */
  limit?: number;
};

/**
 * Load a named dataset, returning test cases ready for eval.
 *
 * Supported dataset names:
 * - "custom" — built-in domain-specific fixtures
 * - "longmemeval_s" — LongMemEval small benchmark
 * - "extraction", "temporal", "updates", "multi-session", "abstention" — single fixture file
 */
export async function loadDataset(
  name: string,
  opts: DatasetLoadOptions = {},
): Promise<TestCase[]> {
  let cases: TestCase[];

  // Single-ability fixture shorthand
  const abilityNames: MemoryAbility[] = [
    "extraction",
    "temporal",
    "updates",
    "multi-session",
    "abstention",
    "graph",
    "validfrom",
  ];

  if ((abilityNames as string[]).includes(name)) {
    cases = await loadCustomDataset({ ability: name as MemoryAbility });
  } else if (name === "custom") {
    cases = await loadCustomDataset({ ability: opts.ability });
  } else if (name === "longmemeval_s" || name === "longmemeval") {
    cases = await loadLongMemEvalDataset({ ability: opts.ability });
  } else if (name === "locomo") {
    cases = await loadLoCoMoDataset({ ability: opts.ability });
  } else if (name === "hybrid") {
    cases = await loadHybridDataset();
  } else if (name === "production") {
    // Production fixture: grounded in real production memories, used with --production flag
    cases = await loadCustomDataset({ ability: opts.ability, fixtureFile: "production" });
  } else {
    throw new Error(
      `Unknown dataset: "${name}". Valid options: "custom", "production", "longmemeval_s", "locomo", "hybrid", ` +
        abilityNames.map((a) => `"${a}"`).join(", "),
    );
  }

  if (opts.ability && (name === "custom" || name === "production")) {
    cases = cases.filter((c) => c.ability === opts.ability);
  }

  if (opts.limit && opts.limit > 0) {
    cases = cases.slice(0, opts.limit);
  }

  return cases;
}
