/**
 * Permission Decision Store — queryable history of permission grants/denials.
 *
 * Layers on the unified event log: every decision is both recorded here
 * (in-memory, queryable) and emitted as a `permission-decision` event
 * to the event log for durable persistence.
 */
import { appendEvent, type AppendEventInput } from "../unified-events/store.js";
import type { PermissionDecision } from "../unified-events/types.js";

export type PermissionDecisionRecord = {
  ts: number;
  toolName: string;
  decision: PermissionDecision;
  reason: string;
  sessionKey: string;
  context?: Record<string, unknown>;
};

export type PermissionQueryOptions = {
  sessionKey?: string;
  toolName?: string;
  decision?: PermissionDecision;
  fromTs?: number;
  toTs?: number;
  limit?: number;
};

// ---------------------------------------------------------------------------
// In-memory store (per-process, supplements durable JSONL via event log)
// ---------------------------------------------------------------------------

const decisions: PermissionDecisionRecord[] = [];

/**
 * Record a permission decision and persist it to the unified event log.
 *
 * @param baseDir - Event log base directory (pass through from session config).
 * @param record - The permission decision to record.
 */
export async function recordPermissionDecision(
  baseDir: string,
  record: Omit<PermissionDecisionRecord, "ts"> & { ts?: number },
): Promise<PermissionDecisionRecord> {
  const full: PermissionDecisionRecord = {
    ...record,
    ts: record.ts ?? Date.now(),
  };
  decisions.push(full);

  // Also persist to unified event log.
  const eventInput: AppendEventInput = {
    kind: "permission-decision",
    sessionKey: full.sessionKey,
    toolName: full.toolName,
    decision: full.decision,
    reason: full.reason,
    context: full.context,
  };
  await appendEvent(baseDir, eventInput).catch(() => undefined);

  return full;
}

/**
 * Query in-memory permission decisions.
 */
export function queryPermissionDecisions(
  opts?: PermissionQueryOptions,
): PermissionDecisionRecord[] {
  let result = decisions;

  if (opts?.sessionKey) {
    result = result.filter((d) => d.sessionKey === opts.sessionKey);
  }
  if (opts?.toolName) {
    result = result.filter((d) => d.toolName === opts.toolName);
  }
  if (opts?.decision) {
    result = result.filter((d) => d.decision === opts.decision);
  }
  if (opts?.fromTs !== undefined) {
    result = result.filter((d) => d.ts >= opts.fromTs!);
  }
  if (opts?.toTs !== undefined) {
    result = result.filter((d) => d.ts <= opts.toTs!);
  }

  const limit = opts?.limit ?? 200;
  return result.slice(-limit);
}

/**
 * Get permission history for a specific session.
 */
export function getSessionPermissionHistory(sessionKey: string): PermissionDecisionRecord[] {
  return decisions.filter((d) => d.sessionKey === sessionKey);
}

/**
 * Get the last decision for a specific tool in a session.
 */
export function getLastDecisionForTool(
  sessionKey: string,
  toolName: string,
): PermissionDecisionRecord | null {
  for (let i = decisions.length - 1; i >= 0; i--) {
    const d = decisions[i];
    if (d.sessionKey === sessionKey && d.toolName === toolName) {
      return d;
    }
  }
  return null;
}

/**
 * Summary of decisions for a session.
 */
export type PermissionSummary = {
  total: number;
  allowed: number;
  denied: number;
  asked: number;
};

export function getPermissionSummary(sessionKey: string): PermissionSummary {
  const session = decisions.filter((d) => d.sessionKey === sessionKey);
  return {
    total: session.length,
    allowed: session.filter((d) => d.decision === "allow").length,
    denied: session.filter((d) => d.decision === "deny").length,
    asked: session.filter((d) => d.decision === "ask").length,
  };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

export function clearPermissionDecisionsForTests(): void {
  decisions.length = 0;
}
