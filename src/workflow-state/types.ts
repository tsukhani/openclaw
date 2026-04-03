/**
 * Workflow State Machine types — explicit state persistence for
 * cron + sub-agent chains with checkpoint/resume capability.
 */

export type WorkflowStatus = "planned" | "executing" | "waiting" | "completed" | "failed";

export type WorkflowStep = {
  id: string;
  label: string;
  status: WorkflowStatus;
  /** Step-specific data (tool name, cron job id, sub-agent task, etc.). */
  data?: Record<string, unknown>;
  startedAtMs?: number;
  completedAtMs?: number;
  error?: string;
};

export type WorkflowCheckpoint = {
  /** Serialized state that can be used to resume the workflow. */
  stepId: string;
  savedAtMs: number;
  snapshot: Record<string, unknown>;
};

export type Workflow = {
  id: string;
  /** Human-readable name for the workflow. */
  name: string;
  sessionKey: string;
  status: WorkflowStatus;
  steps: WorkflowStep[];
  checkpoints: WorkflowCheckpoint[];
  createdAtMs: number;
  updatedAtMs: number;
  /** Optional parent workflow for sub-agent chains. */
  parentWorkflowId?: string;
  /** Optional metadata (cron job id, agent id, etc.). */
  metadata?: Record<string, unknown>;
};

export type WorkflowStoreFile = {
  version: 1;
  workflows: Workflow[];
};

export type WorkflowTransition =
  | { from: "planned"; to: "executing" }
  | { from: "executing"; to: "waiting" }
  | { from: "executing"; to: "completed" }
  | { from: "executing"; to: "failed" }
  | { from: "waiting"; to: "executing" }
  | { from: "waiting"; to: "failed" };

/**
 * Valid status transitions — enforced by the state machine.
 */
export const VALID_TRANSITIONS: ReadonlyArray<{ from: WorkflowStatus; to: WorkflowStatus }> = [
  { from: "planned", to: "executing" },
  { from: "executing", to: "waiting" },
  { from: "executing", to: "completed" },
  { from: "executing", to: "failed" },
  { from: "waiting", to: "executing" },
  { from: "waiting", to: "failed" },
];

export function isValidTransition(from: WorkflowStatus, to: WorkflowStatus): boolean {
  return VALID_TRANSITIONS.some((t) => t.from === from && t.to === to);
}
