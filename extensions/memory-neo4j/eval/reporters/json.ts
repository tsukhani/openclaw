/**
 * JSON reporter for the eval harness.
 *
 * Outputs machine-readable results suitable for CI, baseline comparisons,
 * and downstream tooling.
 */

import { writeFile } from "node:fs/promises";
import type { EvalRunResult } from "../types.js";

/**
 * Serialize eval results to a JSON string.
 */
export function formatJson(result: EvalRunResult): string {
  return JSON.stringify(result, null, 2);
}

/**
 * Write eval results to a JSON file.
 */
export async function reportJson(result: EvalRunResult, outputPath: string): Promise<void> {
  const json = formatJson(result);
  await writeFile(outputPath, json, "utf-8");
}

/**
 * Print eval results as JSON to stdout.
 */
export function reportJsonStdout(result: EvalRunResult): void {
  console.log(formatJson(result));
}
