/**
 * Agent-Level Verification Hooks — optional post-tool-call verification
 * that stores results in the unified event log.
 *
 * Verifiers are registered per tool name. After a tool call completes,
 * the matching verifier runs and the result is recorded as a
 * `verification` event.
 */
import { appendEvent, type AppendEventInput } from "./store.js";
import type { ToolCallEvent, VerificationStatus } from "./types.js";

export type VerificationResult = {
  status: VerificationStatus;
  detail?: string;
};

/**
 * A verifier function receives the completed tool call event
 * and returns a verification result.
 */
export type ToolVerifier = (
  event: ToolCallEvent,
) => VerificationResult | Promise<VerificationResult>;

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const verifiers = new Map<string, ToolVerifier>();

/**
 * Register a verifier for a specific tool.
 * Returns an unregister function.
 */
export function registerToolVerifier(toolName: string, verifier: ToolVerifier): () => void {
  verifiers.set(toolName, verifier);
  return () => {
    if (verifiers.get(toolName) === verifier) {
      verifiers.delete(toolName);
    }
  };
}

/**
 * Check if a verifier is registered for a tool.
 */
export function hasVerifier(toolName: string): boolean {
  return verifiers.has(toolName);
}

/**
 * Get all registered tool names that have verifiers.
 */
export function getRegisteredVerifierTools(): string[] {
  return Array.from(verifiers.keys());
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/**
 * Run the registered verifier for a tool call event (if any).
 * Records the verification result in the unified event log.
 *
 * Returns the verification result, or null if no verifier is registered.
 */
export async function runVerification(
  baseDir: string,
  toolCallEvent: ToolCallEvent,
): Promise<VerificationResult | null> {
  const verifier = verifiers.get(toolCallEvent.toolName);
  if (!verifier) {
    return null;
  }

  let result: VerificationResult;
  try {
    result = await verifier(toolCallEvent);
  } catch (err) {
    result = {
      status: "fail",
      detail: `Verifier threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Record to event log.
  const eventInput: AppendEventInput = {
    kind: "verification",
    sessionKey: toolCallEvent.sessionKey,
    toolName: toolCallEvent.toolName,
    toolCallId: toolCallEvent.id,
    verificationStatus: result.status,
    detail: result.detail,
  };
  await appendEvent(baseDir, eventInput).catch(() => undefined);

  return result;
}

// ---------------------------------------------------------------------------
// Built-in verifiers (examples)
// ---------------------------------------------------------------------------

/**
 * Create a verifier that checks tool call results for error status.
 */
export function createErrorCheckVerifier(): ToolVerifier {
  return (event: ToolCallEvent): VerificationResult => {
    if (event.result.status === "error") {
      return {
        status: "fail",
        detail: `Tool call returned error: ${event.result.error}`,
      };
    }
    return { status: "pass" };
  };
}

/**
 * Create a verifier that checks tool call duration against a threshold.
 */
export function createDurationThresholdVerifier(maxMs: number): ToolVerifier {
  return (event: ToolCallEvent): VerificationResult => {
    if (event.durationMs > maxMs) {
      return {
        status: "fail",
        detail: `Tool call took ${event.durationMs}ms, exceeding threshold of ${maxMs}ms`,
      };
    }
    return { status: "pass" };
  };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

export function clearVerifiersForTests(): void {
  verifiers.clear();
}
