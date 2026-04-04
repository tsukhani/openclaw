/**
 * Unified Event Log — integration helpers for wiring event emission
 * into OpenClaw's execution paths.
 *
 * All functions are fire-and-forget safe: failures are silently swallowed
 * so event logging never crashes the critical path.
 */
import { resolveStateDir } from "../config/paths.js";
import type { SessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import { onSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import { appendEvent } from "./store.js";
import type {
  ContextLoadEvent,
  ContextResource,
  CronSelfDestructEvent,
  RoutingDecisionEvent,
  SessionLifecycleAction,
  SessionLifecycleLogEvent,
  ToolCallEvent,
  ToolCallResult,
} from "./types.js";
import { runVerification } from "./verification-hooks.js";

// ---------------------------------------------------------------------------
// Base directory resolution
// ---------------------------------------------------------------------------

let baseDirOverride: string | undefined;

/** Override the base directory for tests. */
export function setBaseDirForTests(dir: string | undefined): void {
  baseDirOverride = dir;
}

function getBaseDir(): string {
  return baseDirOverride ?? resolveStateDir();
}

// ---------------------------------------------------------------------------
// Feature flag
// ---------------------------------------------------------------------------

let enabledOverride: boolean | undefined;

/** Override enabled flag for tests. */
export function setEnabledForTests(enabled: boolean | undefined): void {
  enabledOverride = enabled;
}

function isEnabled(): boolean {
  if (enabledOverride !== undefined) {
    return enabledOverride;
  }
  // Default to enabled; opt out via OPENCLAW_UNIFIED_EVENTS=0.
  return process.env.OPENCLAW_UNIFIED_EVENTS !== "0";
}

// ---------------------------------------------------------------------------
// Tool call events
// ---------------------------------------------------------------------------

export function emitToolCall(params: {
  sessionKey: string;
  runId?: string;
  toolName: string;
  toolParams: Record<string, unknown>;
  durationMs: number;
  result: ToolCallResult;
}): void {
  if (!isEnabled()) {
    return;
  }
  const input: Omit<ToolCallEvent, "id" | "ts"> = {
    kind: "tool-call",
    sessionKey: params.sessionKey,
    runId: params.runId,
    toolName: params.toolName,
    params: params.toolParams,
    durationMs: params.durationMs,
    result: params.result,
  };
  void appendEvent(getBaseDir(), input).catch(() => undefined);
}

/**
 * Emit a tool call event AND run the registered verifier (if any).
 *
 * Unlike `emitToolCall`, this awaits event persistence so the full
 * `ToolCallEvent` (with `id` and `ts`) is available for the verifier.
 * Verification failures are logged to stderr but never block the caller.
 */
export function emitToolCallAndVerify(params: {
  sessionKey: string;
  runId?: string;
  toolName: string;
  toolParams: Record<string, unknown>;
  durationMs: number;
  result: ToolCallResult;
}): void {
  if (!isEnabled()) {
    return;
  }
  const baseDir = getBaseDir();
  const input: Omit<ToolCallEvent, "id" | "ts"> = {
    kind: "tool-call",
    sessionKey: params.sessionKey,
    runId: params.runId,
    toolName: params.toolName,
    params: params.toolParams,
    durationMs: params.durationMs,
    result: params.result,
  };
  void appendEvent(baseDir, input)
    .then(async (event) => {
      const verification = await runVerification(baseDir, event as ToolCallEvent);
      if (verification?.status === "fail") {
        // eslint-disable-next-line no-console
        console.warn(
          `[verification] ${params.toolName} failed: ${verification.detail ?? "unknown reason"}`,
        );
      }
    })
    .catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Context load events
// ---------------------------------------------------------------------------

export function emitContextLoad(params: {
  sessionKey: string;
  runId?: string;
  resources: ContextResource[];
}): void {
  if (!isEnabled()) {
    return;
  }
  if (params.resources.length === 0) {
    return;
  }
  const input: Omit<ContextLoadEvent, "id" | "ts"> = {
    kind: "context-load",
    sessionKey: params.sessionKey,
    runId: params.runId,
    resources: params.resources,
  };
  void appendEvent(getBaseDir(), input).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Routing decision events
// ---------------------------------------------------------------------------

export function emitRoutingDecision(params: {
  sessionKey: string;
  channelId: string;
  agentId: string;
  resolvedSessionKey: string;
  reason: string;
}): void {
  if (!isEnabled()) {
    return;
  }
  const input: Omit<RoutingDecisionEvent, "id" | "ts"> = {
    kind: "routing-decision",
    sessionKey: params.resolvedSessionKey,
    channelId: params.channelId,
    agentId: params.agentId,
    resolvedSessionKey: params.resolvedSessionKey,
    reason: params.reason,
  };
  void appendEvent(getBaseDir(), input).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Session lifecycle events
// ---------------------------------------------------------------------------

export function emitSessionLifecycle(params: {
  sessionKey: string;
  action: SessionLifecycleAction;
  parentSessionKey?: string;
  label?: string;
  reason?: string;
}): void {
  if (!isEnabled()) {
    return;
  }
  const input: Omit<SessionLifecycleLogEvent, "id" | "ts"> = {
    kind: "session-lifecycle",
    sessionKey: params.sessionKey,
    action: params.action,
    parentSessionKey: params.parentSessionKey,
    label: params.label,
    reason: params.reason,
  };
  void appendEvent(getBaseDir(), input).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Cron self-destruct events
// ---------------------------------------------------------------------------

export function emitCronSelfDestruct(params: {
  sessionKey: string;
  jobId: string;
  jobName?: string;
  reason?: string;
  agentSessionKey?: string;
}): void {
  if (!isEnabled()) {
    return;
  }
  const input: Omit<CronSelfDestructEvent, "id" | "ts"> = {
    kind: "cron-self-destruct",
    sessionKey: params.sessionKey,
    jobId: params.jobId,
    jobName: params.jobName,
    reason: params.reason,
    removedAt: new Date().toISOString(),
    agentSessionKey: params.agentSessionKey,
  };
  void appendEvent(getBaseDir(), input).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Session lifecycle listener registration
// ---------------------------------------------------------------------------

function mapReasonToAction(reason: string): SessionLifecycleAction {
  if (reason === "compaction" || reason === "compaction-retry") {
    return "compaction";
  }
  if (reason === "create" || reason === "session-rollover") {
    return "start";
  }
  if (reason === "destroy" || reason === "end") {
    return "end";
  }
  // For subagent-status and other reasons, treat as a start event.
  return "start";
}

let sessionLifecycleUnsub: (() => void) | null = null;

/**
 * Register a listener on the session lifecycle event bus that bridges
 * events to the unified event log. Call once at gateway/runtime startup.
 * Returns an unsubscribe function.
 */
export function registerSessionLifecycleListener(): () => void {
  if (sessionLifecycleUnsub) {
    return sessionLifecycleUnsub;
  }
  sessionLifecycleUnsub = onSessionLifecycleEvent((event: SessionLifecycleEvent) => {
    emitSessionLifecycle({
      sessionKey: event.sessionKey,
      action: mapReasonToAction(event.reason),
      parentSessionKey: event.parentSessionKey,
      label: event.label ?? event.displayName,
      reason: event.reason,
    });
  });
  return sessionLifecycleUnsub;
}

/** Tear down the listener (for tests). */
export function unregisterSessionLifecycleListenerForTests(): void {
  sessionLifecycleUnsub?.();
  sessionLifecycleUnsub = null;
}
