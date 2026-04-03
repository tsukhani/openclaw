/**
 * Workflow State Store — JSON-backed persistence for workflow state machines.
 *
 * State is persisted per-session at `<baseDir>/workflow/<sessionKey>.json`.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { Workflow, WorkflowCheckpoint, WorkflowStatus, WorkflowStoreFile } from "./types.js";
import { isValidTransition } from "./types.js";

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

function sanitizeSessionKey(sessionKey: string): string {
  const safe = sessionKey.replace(/[^a-zA-Z0-9_:.-]/g, "_");
  if (!safe) {
    throw new Error("invalid session key for workflow store path");
  }
  return safe;
}

export function resolveWorkflowStorePath(baseDir: string, sessionKey: string): string {
  const safe = sanitizeSessionKey(sessionKey);
  const resolved = path.resolve(baseDir, "workflow", `${safe}.json`);
  const workflowDir = path.resolve(baseDir, "workflow");
  if (!resolved.startsWith(`${workflowDir}${path.sep}`)) {
    throw new Error("invalid session key for workflow store path");
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Read / Write
// ---------------------------------------------------------------------------

async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true, mode: 0o700 });
  await fs.chmod(dirPath, 0o700).catch(() => undefined);
}

async function readStoreFile(filePath: string): Promise<WorkflowStoreFile> {
  const raw = await fs.readFile(filePath, "utf-8").catch(() => "");
  if (!raw.trim()) {
    return { version: 1, workflows: [] };
  }
  try {
    const parsed = JSON.parse(raw) as WorkflowStoreFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.workflows)) {
      return { version: 1, workflows: [] };
    }
    return parsed;
  } catch {
    return { version: 1, workflows: [] };
  }
}

async function writeStoreFile(filePath: string, store: WorkflowStoreFile): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const { randomBytes } = await import("node:crypto");
  const tmp = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), { encoding: "utf-8", mode: 0o600 });
  await fs.chmod(tmp, 0o600).catch(() => undefined);
  await fs.rename(tmp, filePath);
  await fs.chmod(filePath, 0o600).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// CRUD operations
// ---------------------------------------------------------------------------

let idCounter = 0;

function generateWorkflowId(): string {
  idCounter += 1;
  return `wf_${Date.now()}_${idCounter}`;
}

export type CreateWorkflowInput = {
  name: string;
  sessionKey: string;
  steps: Array<{ id: string; label: string; data?: Record<string, unknown> }>;
  parentWorkflowId?: string;
  metadata?: Record<string, unknown>;
};

export async function createWorkflow(
  baseDir: string,
  input: CreateWorkflowInput,
): Promise<Workflow> {
  const now = Date.now();
  const workflow: Workflow = {
    id: generateWorkflowId(),
    name: input.name,
    sessionKey: input.sessionKey,
    status: "planned",
    steps: input.steps.map((s) => ({
      id: s.id,
      label: s.label,
      status: "planned" as const,
      data: s.data,
    })),
    checkpoints: [],
    createdAtMs: now,
    updatedAtMs: now,
    parentWorkflowId: input.parentWorkflowId,
    metadata: input.metadata,
  };

  const filePath = resolveWorkflowStorePath(baseDir, input.sessionKey);
  const store = await readStoreFile(filePath);
  store.workflows.push(workflow);
  await writeStoreFile(filePath, store);

  return workflow;
}

export async function getWorkflow(
  baseDir: string,
  sessionKey: string,
  workflowId: string,
): Promise<Workflow | null> {
  const filePath = resolveWorkflowStorePath(baseDir, sessionKey);
  const store = await readStoreFile(filePath);
  return store.workflows.find((w) => w.id === workflowId) ?? null;
}

export async function listWorkflows(baseDir: string, sessionKey: string): Promise<Workflow[]> {
  const filePath = resolveWorkflowStorePath(baseDir, sessionKey);
  const store = await readStoreFile(filePath);
  return store.workflows;
}

export type TransitionError =
  | { code: "invalid-transition"; from: WorkflowStatus; to: WorkflowStatus }
  | { code: "workflow-not-found"; workflowId: string };

export type TransitionResult =
  | { ok: true; workflow: Workflow }
  | { ok: false; error: TransitionError };

export async function transitionWorkflow(
  baseDir: string,
  sessionKey: string,
  workflowId: string,
  to: WorkflowStatus,
): Promise<TransitionResult> {
  const filePath = resolveWorkflowStorePath(baseDir, sessionKey);
  const store = await readStoreFile(filePath);
  const workflow = store.workflows.find((w) => w.id === workflowId);
  if (!workflow) {
    return { ok: false, error: { code: "workflow-not-found", workflowId } };
  }
  if (!isValidTransition(workflow.status, to)) {
    return {
      ok: false,
      error: { code: "invalid-transition", from: workflow.status, to },
    };
  }
  workflow.status = to;
  workflow.updatedAtMs = Date.now();
  await writeStoreFile(filePath, store);
  return { ok: true, workflow };
}

export async function transitionStep(
  baseDir: string,
  sessionKey: string,
  workflowId: string,
  stepId: string,
  to: WorkflowStatus,
): Promise<TransitionResult> {
  const filePath = resolveWorkflowStorePath(baseDir, sessionKey);
  const store = await readStoreFile(filePath);
  const workflow = store.workflows.find((w) => w.id === workflowId);
  if (!workflow) {
    return { ok: false, error: { code: "workflow-not-found", workflowId } };
  }
  const step = workflow.steps.find((s) => s.id === stepId);
  if (!step) {
    return {
      ok: false,
      error: { code: "workflow-not-found", workflowId: `${workflowId}/${stepId}` },
    };
  }
  if (!isValidTransition(step.status, to)) {
    return {
      ok: false,
      error: { code: "invalid-transition", from: step.status, to },
    };
  }

  step.status = to;
  const now = Date.now();
  if (to === "executing" && !step.startedAtMs) {
    step.startedAtMs = now;
  }
  if (to === "completed" || to === "failed") {
    step.completedAtMs = now;
  }
  workflow.updatedAtMs = now;
  await writeStoreFile(filePath, store);
  return { ok: true, workflow };
}

// ---------------------------------------------------------------------------
// Checkpoint / Resume
// ---------------------------------------------------------------------------

export async function saveCheckpoint(
  baseDir: string,
  sessionKey: string,
  workflowId: string,
  stepId: string,
  snapshot: Record<string, unknown>,
): Promise<WorkflowCheckpoint | null> {
  const filePath = resolveWorkflowStorePath(baseDir, sessionKey);
  const store = await readStoreFile(filePath);
  const workflow = store.workflows.find((w) => w.id === workflowId);
  if (!workflow) {
    return null;
  }

  const checkpoint: WorkflowCheckpoint = {
    stepId,
    savedAtMs: Date.now(),
    snapshot,
  };
  workflow.checkpoints.push(checkpoint);
  workflow.updatedAtMs = Date.now();
  await writeStoreFile(filePath, store);
  return checkpoint;
}

export async function getLatestCheckpoint(
  baseDir: string,
  sessionKey: string,
  workflowId: string,
): Promise<WorkflowCheckpoint | null> {
  const filePath = resolveWorkflowStorePath(baseDir, sessionKey);
  const store = await readStoreFile(filePath);
  const workflow = store.workflows.find((w) => w.id === workflowId);
  if (!workflow || workflow.checkpoints.length === 0) {
    return null;
  }
  return workflow.checkpoints[workflow.checkpoints.length - 1] ?? null;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

export function resetWorkflowIdCounterForTests(): void {
  idCounter = 0;
}
