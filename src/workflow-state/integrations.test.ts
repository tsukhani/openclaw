import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkpointBefore,
  createCronWorkflow,
  createSubagentWorkflow,
  isWorkflowStateEnabled,
  transitionOnComplete,
  transitionStepSafe,
} from "./integrations.js";
import { getWorkflow, listWorkflows, resetWorkflowIdCounterForTests } from "./store.js";

let tmpDir: string;

beforeEach(async () => {
  resetWorkflowIdCounterForTests();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-integrations-test-"));
  delete process.env.WORKFLOW_STATE_ENABLED;
});

afterEach(async () => {
  delete process.env.WORKFLOW_STATE_ENABLED;
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
});

describe("isWorkflowStateEnabled", () => {
  it("returns true by default", () => {
    expect(isWorkflowStateEnabled()).toBe(true);
  });

  it("returns false when WORKFLOW_STATE_ENABLED=false", () => {
    process.env.WORKFLOW_STATE_ENABLED = "false";
    expect(isWorkflowStateEnabled()).toBe(false);
  });

  it("returns true for any other value", () => {
    process.env.WORKFLOW_STATE_ENABLED = "true";
    expect(isWorkflowStateEnabled()).toBe(true);
    process.env.WORKFLOW_STATE_ENABLED = "1";
    expect(isWorkflowStateEnabled()).toBe(true);
  });
});

describe("createCronWorkflow", () => {
  it("creates a workflow in executing state with cron metadata", async () => {
    const sessionKey = "cron:test-job:1";
    const wfId = await createCronWorkflow({
      baseDir: tmpDir,
      sessionKey,
      cronJobId: "job-123",
      cronJobName: "My cron job",
      scheduleType: "every",
      agentId: "agent:main",
    });

    expect(wfId).toBeDefined();
    const wf = await getWorkflow(tmpDir, sessionKey, wfId!);
    expect(wf).not.toBeNull();
    expect(wf!.status).toBe("executing");
    expect(wf!.name).toBe("My cron job");
    expect(wf!.metadata).toMatchObject({
      cronJobId: "job-123",
      cronJobName: "My cron job",
      scheduleType: "every",
      agentId: "agent:main",
      runtime: "cron",
    });
    expect(wf!.steps).toHaveLength(3);
    expect(wf!.steps.map((s) => s.id)).toEqual(["setup", "execution", "cleanup"]);
  });

  it("uses cronJobId as name fallback", async () => {
    const sessionKey = "cron:test:2";
    const wfId = await createCronWorkflow({
      baseDir: tmpDir,
      sessionKey,
      cronJobId: "daily-check",
    });

    const wf = await getWorkflow(tmpDir, sessionKey, wfId!);
    expect(wf!.name).toBe("cron:daily-check");
  });

  it("returns undefined when feature is disabled", async () => {
    process.env.WORKFLOW_STATE_ENABLED = "false";
    const result = await createCronWorkflow({
      baseDir: tmpDir,
      sessionKey: "cron:disabled:1",
      cronJobId: "job-1",
    });
    expect(result).toBeUndefined();

    const workflows = await listWorkflows(tmpDir, "cron:disabled:1");
    expect(workflows).toHaveLength(0);
  });
});

describe("createSubagentWorkflow", () => {
  it("creates a workflow in executing state with subagent metadata", async () => {
    const sessionKey = "agent:main:subagent:abc-123";
    const wfId = await createSubagentWorkflow({
      baseDir: tmpDir,
      sessionKey,
      runId: "run-456",
      task: "Analyze the codebase",
      label: "Code analyzer",
      requesterSessionKey: "agent:main:session:parent",
      model: "sonnet-4.6",
      agentId: "agent:main",
    });

    expect(wfId).toBeDefined();
    const wf = await getWorkflow(tmpDir, sessionKey, wfId!);
    expect(wf).not.toBeNull();
    expect(wf!.status).toBe("executing");
    expect(wf!.name).toBe("Code analyzer");
    expect(wf!.metadata).toMatchObject({
      runId: "run-456",
      task: "Analyze the codebase",
      requesterSessionKey: "agent:main:session:parent",
      runtime: "subagent",
    });
    expect(wf!.steps).toHaveLength(3);
    expect(wf!.steps.map((s) => s.id)).toEqual(["spawn", "execution", "completion"]);
  });

  it("links to parent workflow when provided", async () => {
    const sessionKey = "agent:main:subagent:nested";
    const wfId = await createSubagentWorkflow({
      baseDir: tmpDir,
      sessionKey,
      runId: "run-nested",
      task: "nested task",
      requesterSessionKey: "agent:main:session:parent",
      parentWorkflowId: "wf_parent_1",
    });

    const wf = await getWorkflow(tmpDir, sessionKey, wfId!);
    expect(wf!.parentWorkflowId).toBe("wf_parent_1");
  });

  it("returns undefined when feature is disabled", async () => {
    process.env.WORKFLOW_STATE_ENABLED = "false";
    const result = await createSubagentWorkflow({
      baseDir: tmpDir,
      sessionKey: "agent:disabled:1",
      runId: "run-1",
      task: "task",
      requesterSessionKey: "req-1",
    });
    expect(result).toBeUndefined();
  });
});

describe("transitionOnComplete", () => {
  it("transitions workflow to completed", async () => {
    const sessionKey = "cron:complete-test:1";
    const wfId = await createCronWorkflow({
      baseDir: tmpDir,
      sessionKey,
      cronJobId: "job-complete",
    });

    await transitionOnComplete({
      baseDir: tmpDir,
      sessionKey,
      workflowId: wfId,
      status: "completed",
    });

    const wf = await getWorkflow(tmpDir, sessionKey, wfId!);
    expect(wf!.status).toBe("completed");
  });

  it("transitions workflow to failed", async () => {
    const sessionKey = "cron:fail-test:1";
    const wfId = await createCronWorkflow({
      baseDir: tmpDir,
      sessionKey,
      cronJobId: "job-fail",
    });

    await transitionOnComplete({
      baseDir: tmpDir,
      sessionKey,
      workflowId: wfId,
      status: "failed",
      error: "Timeout exceeded",
    });

    const wf = await getWorkflow(tmpDir, sessionKey, wfId!);
    expect(wf!.status).toBe("failed");
  });

  it("no-ops when workflowId is undefined", async () => {
    // Should not throw
    await transitionOnComplete({
      baseDir: tmpDir,
      sessionKey: "noop",
      workflowId: undefined,
      status: "completed",
    });
  });

  it("no-ops when feature is disabled", async () => {
    process.env.WORKFLOW_STATE_ENABLED = "false";
    const sessionKey = "cron:disabled-complete:1";
    // Create a workflow first (while enabled)
    delete process.env.WORKFLOW_STATE_ENABLED;
    const wfId = await createCronWorkflow({
      baseDir: tmpDir,
      sessionKey,
      cronJobId: "job-dc",
    });

    process.env.WORKFLOW_STATE_ENABLED = "false";
    await transitionOnComplete({
      baseDir: tmpDir,
      sessionKey,
      workflowId: wfId,
      status: "completed",
    });

    // Should still be executing since transition was skipped
    delete process.env.WORKFLOW_STATE_ENABLED;
    const wf = await getWorkflow(tmpDir, sessionKey, wfId!);
    expect(wf!.status).toBe("executing");
  });
});

describe("transitionStepSafe", () => {
  it("transitions a step within a workflow", async () => {
    const sessionKey = "cron:step-test:1";
    const wfId = await createCronWorkflow({
      baseDir: tmpDir,
      sessionKey,
      cronJobId: "job-step",
    });

    await transitionStepSafe({
      baseDir: tmpDir,
      sessionKey,
      workflowId: wfId,
      stepId: "setup",
      status: "executing",
    });

    const wf = await getWorkflow(tmpDir, sessionKey, wfId!);
    const step = wf!.steps.find((s) => s.id === "setup");
    expect(step!.status).toBe("executing");
    expect(step!.startedAtMs).toBeDefined();
  });

  it("no-ops when workflowId is undefined", async () => {
    await transitionStepSafe({
      baseDir: tmpDir,
      sessionKey: "noop",
      workflowId: undefined,
      stepId: "setup",
      status: "executing",
    });
  });
});

describe("checkpointBefore", () => {
  it("saves a checkpoint for the given step", async () => {
    const sessionKey = "cron:checkpoint-test:1";
    const wfId = await createCronWorkflow({
      baseDir: tmpDir,
      sessionKey,
      cronJobId: "job-cp",
    });

    await checkpointBefore({
      baseDir: tmpDir,
      sessionKey,
      workflowId: wfId,
      stepId: "execution",
      snapshot: { attemptCount: 1, jobState: "running" },
    });

    const { getLatestCheckpoint } = await import("./store.js");
    const cp = await getLatestCheckpoint(tmpDir, sessionKey, wfId!);
    expect(cp).not.toBeNull();
    expect(cp!.stepId).toBe("execution");
    expect(cp!.snapshot).toMatchObject({ attemptCount: 1, jobState: "running" });
  });

  it("no-ops when workflowId is undefined", async () => {
    await checkpointBefore({
      baseDir: tmpDir,
      sessionKey: "noop",
      workflowId: undefined,
      stepId: "execution",
      snapshot: {},
    });
  });
});

describe("fire-and-forget error handling", () => {
  it("createCronWorkflow swallows errors for invalid baseDir", async () => {
    const result = await createCronWorkflow({
      baseDir: "/dev/null/nonexistent",
      sessionKey: "test",
      cronJobId: "job-1",
    });
    expect(result).toBeUndefined();
  });

  it("transitionOnComplete swallows errors for invalid workflow id", async () => {
    // Should not throw
    await transitionOnComplete({
      baseDir: tmpDir,
      sessionKey: "test",
      workflowId: "wf_nonexistent",
      status: "completed",
    });
  });

  it("checkpointBefore swallows errors for invalid workflow id", async () => {
    await checkpointBefore({
      baseDir: tmpDir,
      sessionKey: "test",
      workflowId: "wf_nonexistent",
      stepId: "execution",
      snapshot: {},
    });
  });
});
