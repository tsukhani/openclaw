/**
 * Custom JSON fixture adapter for the eval harness.
 *
 * Loads test cases from the bundled fixture files under datasets/fixtures/.
 * Each fixture file covers one of the five LongMemEval ability categories.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FixtureFile, MemoryAbility, TestCase } from "../types.js";

const FIXTURES_DIR = join(fileURLToPath(import.meta.url), "..", "fixtures");

const FIXTURE_FILES: Record<MemoryAbility, string> = {
  extraction: "extraction.json",
  temporal: "temporal.json",
  updates: "updates.json",
  "multi-session": "multi-session.json",
  abstention: "abstention.json",
  graph: "graph.json",
  validfrom: "validfrom.json",
};

export type CustomDatasetOptions = {
  /** If provided, only load this ability's fixture file. */
  ability?: MemoryAbility;
  /**
   * If provided, load a specific fixture file by name (without .json extension).
   * Defaults to loading all standard ability fixture files.
   * E.g. "production" loads fixtures/production.json.
   */
  fixtureFile?: string;
};

/**
 * Load test cases from the bundled custom fixture files.
 *
 * Validates that every test_case has consistent memory IDs:
 * memory IDs in gold_memory_ids must reference memories defined in the case.
 */
export async function loadCustomDataset(opts: CustomDatasetOptions = {}): Promise<TestCase[]> {
  // If a specific fixture file is requested, load just that one
  if (opts.fixtureFile) {
    const filename = `${opts.fixtureFile}.json`;
    const filepath = join(FIXTURES_DIR, filename);
    let raw: string;
    try {
      raw = await readFile(filepath, "utf-8");
    } catch (err) {
      throw new Error(
        `Failed to load fixture file "${filepath}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const fixture = JSON.parse(raw) as FixtureFile;
    if (!Array.isArray(fixture.test_cases)) {
      throw new Error(`Fixture file "${filename}" is missing "test_cases" array`);
    }
    const cases = fixture.test_cases.filter((tc) => !opts.ability || tc.ability === opts.ability);
    for (const tc of cases) validateTestCase(tc, filename);
    return cases;
  }

  const abilities: MemoryAbility[] = opts.ability
    ? [opts.ability]
    : (Object.keys(FIXTURE_FILES) as MemoryAbility[]);

  const allCases: TestCase[] = [];

  for (const ability of abilities) {
    const filename = FIXTURE_FILES[ability];
    const filepath = join(FIXTURES_DIR, filename);

    let raw: string;
    try {
      raw = await readFile(filepath, "utf-8");
    } catch (err) {
      throw new Error(
        `Failed to load fixture file "${filepath}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    let fixture: FixtureFile;
    try {
      fixture = JSON.parse(raw) as FixtureFile;
    } catch (err) {
      throw new Error(
        `Failed to parse fixture file "${filepath}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!Array.isArray(fixture.test_cases)) {
      throw new Error(`Fixture file "${filename}" is missing "test_cases" array`);
    }

    for (const tc of fixture.test_cases) {
      validateTestCase(tc, filename);
      allCases.push(tc);
    }
  }

  return allCases;
}

/** Validate a test case loaded from fixtures. */
function validateTestCase(tc: TestCase, source: string): void {
  if (!tc.id) throw new Error(`${source}: test case missing "id"`);
  if (!tc.ability) throw new Error(`${source}/${tc.id}: missing "ability"`);
  if (!tc.question) throw new Error(`${source}/${tc.id}: missing "question"`);
  if (!tc.golden_answer) throw new Error(`${source}/${tc.id}: missing "golden_answer"`);
  if (!Array.isArray(tc.memories)) throw new Error(`${source}/${tc.id}: "memories" must be array`);
  if (!Array.isArray(tc.gold_memory_ids))
    throw new Error(`${source}/${tc.id}: "gold_memory_ids" must be array`);

  const definedIds = new Set(tc.memories.map((m) => m.id));
  for (const goldId of tc.gold_memory_ids) {
    if (!definedIds.has(goldId)) {
      throw new Error(`${source}/${tc.id}: gold_memory_id "${goldId}" not found in memories array`);
    }
  }
}
