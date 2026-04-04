/**
 * Unified Event Log — discriminated union event types for the OpenClaw harness.
 *
 * Every event shares a common base shape and is discriminated by `kind`.
 */

export type EventBase = {
  /** Monotonic event ID within a session log (assigned at append time). */
  id: number;
  /** Unix epoch milliseconds. */
  ts: number;
  /** Session key (agent:agentId:channel:chatType:peerId). */
  sessionKey: string;
  /** Optional run/request correlation ID. */
  runId?: string;
};

// -- Tool call events --------------------------------------------------------

export type ToolCallEvent = EventBase & {
  kind: "tool-call";
  toolName: string;
  params: Record<string, unknown>;
  durationMs: number;
  result: ToolCallResult;
};

export type ToolCallResult =
  | { status: "ok"; summary?: string }
  | { status: "error"; error: string };

// -- Permission decision events ----------------------------------------------

export type PermissionDecision = "allow" | "deny" | "ask";

export type PermissionDecisionEvent = EventBase & {
  kind: "permission-decision";
  toolName: string;
  decision: PermissionDecision;
  reason: string;
  /** The exec approval context when applicable. */
  context?: Record<string, unknown>;
};

// -- Context loading events --------------------------------------------------

export type ContextLoadEvent = EventBase & {
  kind: "context-load";
  /** Files or resources loaded into context. */
  resources: ContextResource[];
};

export type ContextResource = {
  path: string;
  sizeBytes?: number;
  source: "workspace" | "plugin" | "user" | "system";
};

// -- Routing decision events -------------------------------------------------

export type RoutingDecisionEvent = EventBase & {
  kind: "routing-decision";
  channelId: string;
  agentId: string;
  resolvedSessionKey: string;
  /** Why this route was chosen. */
  reason: string;
};

// -- Session lifecycle events ------------------------------------------------

export type SessionLifecycleAction = "start" | "end" | "compaction";

export type SessionLifecycleLogEvent = EventBase & {
  kind: "session-lifecycle";
  action: SessionLifecycleAction;
  parentSessionKey?: string;
  label?: string;
  reason?: string;
};

// -- Verification result events (Priority 4) ---------------------------------

export type VerificationStatus = "pass" | "fail" | "skipped";

export type VerificationEvent = EventBase & {
  kind: "verification";
  toolName: string;
  toolCallId: number;
  verificationStatus: VerificationStatus;
  detail?: string;
};

// -- Cron self-destruct events -----------------------------------------------

export type CronSelfDestructEvent = EventBase & {
  kind: "cron-self-destruct";
  jobId: string;
  jobName?: string;
  /** Why the job self-destructed (e.g. "task_completed"). */
  reason?: string;
  /** ISO timestamp when the job was removed. */
  removedAt: string;
  /** The session key of the agent that triggered self-destruct. */
  agentSessionKey?: string;
};

// -- Discriminated union of all events ---------------------------------------

export type UnifiedEvent =
  | ToolCallEvent
  | PermissionDecisionEvent
  | ContextLoadEvent
  | RoutingDecisionEvent
  | SessionLifecycleLogEvent
  | VerificationEvent
  | CronSelfDestructEvent;

export type UnifiedEventKind = UnifiedEvent["kind"];

// -- Query types -------------------------------------------------------------

export type EventFilter = {
  sessionKey?: string;
  kinds?: UnifiedEventKind[];
  /** Inclusive start timestamp (ms). */
  fromTs?: number;
  /** Inclusive end timestamp (ms). */
  toTs?: number;
  /** Max events to return. */
  limit?: number;
  /** Number of events to skip. */
  offset?: number;
};

export type EventPage = {
  events: UnifiedEvent[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
};
