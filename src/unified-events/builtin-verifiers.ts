/**
 * Built-in verification hooks for common tool operations.
 *
 * Each factory returns a `ToolVerifier` that inspects the completed
 * `ToolCallEvent` and produces a pass/fail/skipped result.
 */
import fs from "node:fs/promises";
import type { ToolCallEvent } from "./types.js";
import type { ToolVerifier, VerificationResult } from "./verification-hooks.js";

// ---------------------------------------------------------------------------
// Write / Edit tool verifier
// ---------------------------------------------------------------------------

/**
 * Verify that a write or edit tool actually produced a file on disk.
 *
 * Checks:
 * 1. The target file exists.
 * 2. The file has non-zero size.
 * 3. The file mtime is at or after the tool call timestamp.
 */
export function createWriteVerifier(): ToolVerifier {
  return async (event: ToolCallEvent): Promise<VerificationResult> => {
    if (event.result.status === "error") {
      return { status: "fail", detail: `Tool returned error: ${event.result.error}` };
    }

    const filePath =
      (event.params.file_path as string | undefined) ?? (event.params.path as string | undefined);

    if (!filePath) {
      return { status: "skipped", detail: "No file path in tool params" };
    }

    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) {
        return { status: "fail", detail: `Path is not a file: ${filePath}` };
      }
      if (stat.size === 0) {
        return { status: "fail", detail: `File has zero size: ${filePath}` };
      }
      // mtime should be at or after the tool call start (ts is epoch ms).
      if (stat.mtimeMs < event.ts - 1000) {
        return {
          status: "fail",
          detail: `File mtime (${stat.mtimeMs}) predates tool call (${event.ts}): ${filePath}`,
        };
      }
      return { status: "pass", detail: `Verified file exists with size ${stat.size}` };
    } catch {
      return { status: "fail", detail: `File not found after write: ${filePath}` };
    }
  };
}

// ---------------------------------------------------------------------------
// Exec tool verifier
// ---------------------------------------------------------------------------

/**
 * Verify that an exec/bash tool call completed successfully.
 *
 * Checks:
 * 1. The tool result status is not "error".
 * 2. The result summary does not contain a non-zero exit code indicator.
 */
export function createExecVerifier(): ToolVerifier {
  return (event: ToolCallEvent): VerificationResult => {
    if (event.result.status === "error") {
      return { status: "fail", detail: `Exec error: ${event.result.error}` };
    }

    // The summary field often contains exit code info.
    const summary = event.result.status === "ok" ? (event.result.summary ?? "") : "";

    // Detect non-zero exit codes from common summary patterns.
    const exitCodeMatch = /exit[- _]?code[:\s=]+(\d+)/i.exec(summary);
    if (exitCodeMatch) {
      const code = Number(exitCodeMatch[1]);
      if (code !== 0) {
        return { status: "fail", detail: `Non-zero exit code: ${code}` };
      }
    }

    return { status: "pass" };
  };
}

// ---------------------------------------------------------------------------
// Message tool verifier
// ---------------------------------------------------------------------------

/**
 * Verify that a message send tool call completed without error.
 *
 * For messaging tools, delivery confirmation depends on the channel API.
 * This verifier checks the tool result status and, when a delivery ID or
 * confirmation is present in the summary, verifies it is non-empty.
 */
export function createMessageVerifier(): ToolVerifier {
  return (event: ToolCallEvent): VerificationResult => {
    if (event.result.status === "error") {
      return { status: "fail", detail: `Message send error: ${event.result.error}` };
    }

    // If the result includes a summary with delivery info, verify it's not empty.
    const summary = event.result.status === "ok" ? (event.result.summary ?? "") : "";
    if (summary.toLowerCase().includes("delivery_failed")) {
      return { status: "fail", detail: "Delivery reported as failed" };
    }

    return { status: "pass", detail: "Message send completed without error" };
  };
}
