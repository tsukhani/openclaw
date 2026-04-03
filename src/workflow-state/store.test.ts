import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createWorkflow,
  getLatestCheckpoint,
  getWorkflow,
  listWorkflows,
  resetWorkflowIdCounterForTests,
  resolveWorkflowStorePath,
  saveCheckpoint,
  transitionStep,
  transitionWorkflow,
} from "./store.js";
import { isValidTransition } from "./types.js";

let tmpDir: string;

beforeEach(async () => {
  resetWorkflowIdCounterForTests();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-store-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
});

describe("resolveWorkflowStorePath", () => {
  it("returns a .json path under workflow/", () => {
    const p = resolveWorkflowStorePath("/base", "agent:main:test:private:1");
    expect(p).toContain("/workflow/");
    expect(p.endsWith(".json")).toBe(true);
  });

  it("throws for empty session key", () => {
    expect(() => resolveWorkflowStorePath("/base", "")).toThrow("invalid session key");
  });
});

describe("isValidTransition", () => {
  it("allows planned -> executing", () => {
    expect(isValidTransition("planned", "executing")).toBe(true);
  });

  it("allows executing -> completed", () => {
    expect(isValidTransition("executing", "completed")).toBe(true);
  });

  it("allows executing -> failed", () => {
    expect(isValidTransition("executing", "failed")).toBe(true);
  });

  it("allows executing -> waiting", () => {
    expect(isValidTransition("executing", "waiting")).toBe(true);
  });

  it("allows waiting -> executing (resume)", () => {
    expect(isValidTransition("waiting", "executing")).toBe(true);
  });

  it("rejects planned -> completed", () => {
    expect(isValidTransition("planned", "completed")).toBe(false);
  });

  it("rejects completed -> executing", () => {
    expect(isValidTransition("completed", "executing")).toBe(false);
  });
});

describe("createWorkflow + getWorkflow", () => {
  it("creates and reads back a workflow", async () => {
    const sk = "agent:main:test:private:1";
    const wf = await createWorkflow(tmpDir, {
      name: "deploy",
      sessionKey: sk,
      steps: [
        { id: "build", label: "Build project" },
        { id: "test", label: "Run tests" },
        { id: "deploy", label: "Deploy to prod" },
      ],
    });

    expect(wf.id).toBeTruthy();
    expect(wf.status).toBe("planned");
    expect(wf.steps).toHaveLength(3);
    expect(wf.steps[0].status).toBe("planned");

    const read = await getWorkflow(tmpDir, sk, wf.id);
    expect(read).not.toBeNull();
    expect(read!.name).toBe("deploy");
  });
});

describe("listWorkflows", () => {
  it("lists all workflows for a session", async () => {
    const sk = "agent:main:test:private:1";
    await createWorkflow(tmpDir, { name: "wf1", sessionKey: sk, steps: [] });
    await createWorkflow(tmpDir, { name: "wf2", sessionKey: sk, steps: [] });

    const list = await listWorkflows(tmpDir, sk);
    expect(list).toHaveLength(2);
  });
});

describe("transitionWorkflow", () => {
  it("transitions workflow status", async () => {
    const sk = "agent:main:test:private:1";
    const wf = await createWorkflow(tmpDir, {
      name: "test",
      sessionKey: sk,
      steps: [{ id: "s1", label: "Step 1" }],
    });

    const result = await transitionWorkflow(tmpDir, sk, wf.id, "executing");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.workflow.status).toBe("executing");
    }
  });

  it("rejects invalid transitions", async () => {
    const sk = "agent:main:test:private:1";
    const wf = await createWorkflow(tmpDir, {
      name: "test",
      sessionKey: sk,
      steps: [],
    });

    const result = await transitionWorkflow(tmpDir, sk, wf.id, "completed");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid-transition");
    }
  });

  it("returns error for unknown workflow", async () => {
    const result = await transitionWorkflow(tmpDir, "agent:x:y:z:0", "nonexistent", "executing");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("workflow-not-found");
    }
  });
});

describe("transitionStep", () => {
  it("transitions individual step status", async () => {
    const sk = "agent:main:test:private:1";
    const wf = await createWorkflow(tmpDir, {
      name: "test",
      sessionKey: sk,
      steps: [{ id: "s1", label: "Step 1" }],
    });

    const result = await transitionStep(tmpDir, sk, wf.id, "s1", "executing");
    expect(result.ok).toBe(true);
    if (result.ok) {
      const step = result.workflow.steps.find((s) => s.id === "s1");
      expect(step?.status).toBe("executing");
      expect(step?.startedAtMs).toBeGreaterThan(0);
    }
  });

  it("sets completedAtMs on terminal states", async () => {
    const sk = "agent:main:test:private:1";
    const wf = await createWorkflow(tmpDir, {
      name: "test",
      sessionKey: sk,
      steps: [{ id: "s1", label: "Step 1" }],
    });

    await transitionStep(tmpDir, sk, wf.id, "s1", "executing");
    const result = await transitionStep(tmpDir, sk, wf.id, "s1", "completed");
    expect(result.ok).toBe(true);
    if (result.ok) {
      const step = result.workflow.steps.find((s) => s.id === "s1");
      expect(step?.completedAtMs).toBeGreaterThan(0);
    }
  });
});

describe("checkpoint / resume", () => {
  it("saves and retrieves checkpoints", async () => {
    const sk = "agent:main:test:private:1";
    const wf = await createWorkflow(tmpDir, {
      name: "test",
      sessionKey: sk,
      steps: [{ id: "s1", label: "Step 1" }],
    });

    const cp = await saveCheckpoint(tmpDir, sk, wf.id, "s1", { counter: 42, state: "midway" });
    expect(cp).not.toBeNull();
    expect(cp!.stepId).toBe("s1");
    expect(cp!.snapshot.counter).toBe(42);

    const latest = await getLatestCheckpoint(tmpDir, sk, wf.id);
    expect(latest).not.toBeNull();
    expect(latest!.snapshot.state).toBe("midway");
  });

  it("returns null for nonexistent workflow", async () => {
    const cp = await getLatestCheckpoint(tmpDir, "agent:x:y:z:0", "nonexistent");
    expect(cp).toBeNull();
  });

  it("returns latest of multiple checkpoints", async () => {
    const sk = "agent:main:test:private:1";
    const wf = await createWorkflow(tmpDir, {
      name: "test",
      sessionKey: sk,
      steps: [
        { id: "s1", label: "Step 1" },
        { id: "s2", label: "Step 2" },
      ],
    });

    await saveCheckpoint(tmpDir, sk, wf.id, "s1", { phase: "first" });
    await saveCheckpoint(tmpDir, sk, wf.id, "s2", { phase: "second" });

    const latest = await getLatestCheckpoint(tmpDir, sk, wf.id);
    expect(latest!.stepId).toBe("s2");
    expect(latest!.snapshot.phase).toBe("second");
  });
});
