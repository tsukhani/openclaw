/**
 * Hybrid dataset adapter combining LoCoMo and LongMemEval cases.
 *
 * Composition (up to 50 cases per bucket, configurable via limit):
 *   • 50 graph/multi-hop from LoCoMo (cat4)
 *   • 50 temporal from LoCoMo (cat2)
 *   • 50 abstention from LoCoMo (cat5)
 *   • 50 extraction from LoCoMo (cat1)
 *   • 50 knowledge-update from LongMemEval (ability="updates")
 *
 * Total default: up to 250 cases covering all major retrieval challenges
 * at production scale (300–450 distractor memories from LoCoMo cases).
 */

import type { MemoryAbility, TestCase } from "../types.js";
import { loadLoCoMoDataset } from "./locomo-adapter.js";
import { loadLongMemEvalDataset } from "./longmemeval-adapter.js";

export type HybridOptions = {
  /** Max total test cases to return (default: 250). */
  limit?: number;
};

/** Per-bucket cap — how many cases to take from each source bucket. */
const BUCKET_CAP = 50;

/**
 * Load the hybrid dataset.
 *
 * Combines hard LoCoMo retrieval cases (large haystacks) with
 * LongMemEval knowledge-update cases for comprehensive coverage.
 */
export async function loadHybridDataset(opts: HybridOptions = {}): Promise<TestCase[]> {
  // Fetch LoCoMo buckets in parallel with LongMemEval.
  const [locoGraph, locoTemporal, locoAbstention, locoExtraction, lmeUpdates] = await Promise.all([
    loadLoCoMoBucket("graph"),
    loadLoCoMoBucket("temporal"),
    loadLoCoMoBucket("abstention"),
    loadLoCoMoBucket("extraction"),
    loadLongMemEvalBucket("updates"),
  ]);

  const cases: TestCase[] = [
    ...locoGraph,
    ...locoTemporal,
    ...locoAbstention,
    ...locoExtraction,
    ...lmeUpdates,
  ];

  if (opts.limit && opts.limit > 0) {
    return cases.slice(0, opts.limit);
  }
  return cases;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function loadLoCoMoBucket(ability: MemoryAbility): Promise<TestCase[]> {
  return loadLoCoMoDataset({ ability, limit: BUCKET_CAP });
}

async function loadLongMemEvalBucket(ability: MemoryAbility): Promise<TestCase[]> {
  return loadLongMemEvalDataset({ ability, limit: BUCKET_CAP });
}
