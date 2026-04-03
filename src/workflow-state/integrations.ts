/**
 * Workflow-state integration helpers — fire-and-forget wrappers
 * for cron and sub-agent workflow tracking.
 *
 * All helpers swallow errors so callers never block on workflow I/O.
 */

import type { WorkflowStatus } from "./types.js";

// ---------------------------------------------------------------------------
// Base directory resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the workflow store base directory from the openclaw state dir.
 * Lazily imports the config module to avoid circular deps at load time.
 */
export async function resolveWorkflowBaseDir(): Promise<string> {
  const { resolveStateDir } = await import("../config/paths.js");
  return resolveStateDir();
}

// ---------------------------------------------------------------------------
// Feature flag
// ---------------------------------------------------------------------------

export function isWorkflowStateEnabled(): boolean {
  return process.env.WORKFLOW_STATE_ENABLED !== "false";
}

// ---------------------------------------------------------------------------
// Lazy import — keeps the heavy store module out of the critical path
// ---------------------------------------------------------------------------

async function store() {
  return await import("./store.js");
}

// ---------------------------------------------------------------------------
// Cron workflow helpers
// ---------------------------------------------------------------------------

export type CreateCronWorkflowParams = {
  baseDir: string;
  sessionKey: string;
  cronJobId: string;
  cronJobName?: string;
  scheduleType?: string;
  agentId?: string;
};

/**
 * Create a workflow for a cron job execution and immediately transition
 * it to `executing`. Returns the workflow id or `undefined` on failure.
 */
export async function createCronWorkflow(
  params: CreateCronWorkflowParams,
): Promise<string | undefined> {
  if (!isWorkflowStateEnabled()) {
    return undefined;
  }
  try {
    const { createWorkflow, transitionWorkflow } = await store();
    const wf = await createWorkflow(params.baseDir, {
      name: params.cronJobName ?? `cron:${params.cronJobId}`,
      sessionKey: params.sessionKey,
      steps: [
        { id: "setup", label: "Job setup" },
        { id: "execution", label: "Job execution" },
        { id: "cleanup", label: "Job cleanup" },
      ],
      metadata: {
        cronJobId: params.cronJobId,
        cronJobName: params.cronJobName,
        scheduleType: params.scheduleType,
        agentId: params.agentId,
        runtime: "cron",
      },
    });
    await transitionWorkflow(params.baseDir, params.sessionKey, wf.id, "executing");
    return wf.id;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Sub-agent workflow helpers
// ---------------------------------------------------------------------------

export type CreateSubagentWorkflowParams = {
  baseDir: string;
  sessionKey: string;
  runId: string;
  task: string;
  label?: string;
  requesterSessionKey: string;
  parentWorkflowId?: string;
  model?: string;
  agentId?: string;
};

/**
 * Create a workflow for a sub-agent spawn and immediately transition
 * it to `executing`. Returns the workflow id or `undefined` on failure.
 */
export async function createSubagentWorkflow(
  params: CreateSubagentWorkflowParams,
): Promise<string | undefined> {
  if (!isWorkflowStateEnabled()) {
    return undefined;
  }
  try {
    const { createWorkflow, transitionWorkflow } = await store();
    const wf = await createWorkflow(params.baseDir, {
      name: params.label ?? `subagent:${params.runId}`,
      sessionKey: params.sessionKey,
      steps: [
        { id: "spawn", label: "Agent spawn" },
        { id: "execution", label: "Agent execution" },
        { id: "completion", label: "Agent completion" },
      ],
      parentWorkflowId: params.parentWorkflowId,
      metadata: {
        runId: params.runId,
        task: params.task,
        label: params.label,
        requesterSessionKey: params.requesterSessionKey,
        model: params.model,
        agentId: params.agentId,
        runtime: "subagent",
      },
    });
    await transitionWorkflow(params.baseDir, params.sessionKey, wf.id, "executing");
    return wf.id;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Shared transition helpers
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget: transition a workflow to a terminal status.
 */
export async function transitionOnComplete(params: {
  baseDir: string;
  sessionKey: string;
  workflowId: string | undefined;
  status: "completed" | "failed";
  error?: string;
}): Promise<void> {
  if (!isWorkflowStateEnabled() || !params.workflowId) {
    return;
  }
  try {
    const { transitionWorkflow } = await store();
    await transitionWorkflow(params.baseDir, params.sessionKey, params.workflowId, params.status);
  } catch {
    // fire-and-forget
  }
}

/**
 * Fire-and-forget: transition a step within a workflow.
 */
export async function transitionStepSafe(params: {
  baseDir: string;
  sessionKey: string;
  workflowId: string | undefined;
  stepId: string;
  status: WorkflowStatus;
}): Promise<void> {
  if (!isWorkflowStateEnabled() || !params.workflowId) {
    return;
  }
  try {
    const { transitionStep } = await store();
    await transitionStep(
      params.baseDir,
      params.sessionKey,
      params.workflowId,
      params.stepId,
      params.status,
    );
  } catch {
    // fire-and-forget
  }
}

/**
 * Fire-and-forget: create a checkpoint before a risky operation.
 */
export async function checkpointBefore(params: {
  baseDir: string;
  sessionKey: string;
  workflowId: string | undefined;
  stepId: string;
  snapshot: Record<string, unknown>;
}): Promise<void> {
  if (!isWorkflowStateEnabled() || !params.workflowId) {
    return;
  }
  try {
    const { saveCheckpoint } = await store();
    await saveCheckpoint(
      params.baseDir,
      params.sessionKey,
      params.workflowId,
      params.stepId,
      params.snapshot,
    );
  } catch {
    // fire-and-forget
  }
}
