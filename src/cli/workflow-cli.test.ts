import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWorkflow,
  resetWorkflowIdCounterForTests,
  saveCheckpoint,
  transitionStep,
  transitionWorkflow,
} from "../workflow-state/store.js";

let tmpDir: string;

vi.mock("../config/paths.js", () => ({
  resolveStateDir: () => tmpDir,
}));

beforeEach(async () => {
  resetWorkflowIdCounterForTests();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-cli-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
});

function createProgram(): Command {
  return new Command().exitOverride();
}

async function registerAndParse(args: string[]): Promise<string> {
  const { registerWorkflowCli } = await import("./workflow-cli.js");
  const program = createProgram();
  registerWorkflowCli(program);

  const chunks: string[] = [];
  const consoleSpy = vi.spyOn(console, "log").mockImplementation((...logArgs: unknown[]) => {
    chunks.push(logArgs.map(String).join(" "));
  });
  const origWrite = process.stdout.write.bind(process.stdout);
  const writeSpy = vi.fn((...writeArgs: unknown[]) => {
    chunks.push(String(writeArgs[0]));
    return true;
  });
  process.stdout.write = writeSpy as unknown as typeof process.stdout.write;

  try {
    await program.parseAsync(["node", "test", ...args]);
  } finally {
    consoleSpy.mockRestore();
    process.stdout.write = origWrite;
  }
  return chunks.join("\n");
}

const session = "agent:main:test:private:1";

async function seedWorkflow() {
  return createWorkflow(tmpDir, {
    name: "Test Pipeline",
    sessionKey: session,
    steps: [
      { id: "step-1", label: "Fetch data" },
      { id: "step-2", label: "Transform" },
      { id: "step-3", label: "Upload" },
    ],
    metadata: { source: "test" },
  });
}

describe("workflow-cli", () => {
  describe("workflow list", () => {
    it("requires --session or --all", async () => {
      const { registerWorkflowCli } = await import("./workflow-cli.js");
      const program = createProgram();
      registerWorkflowCli(program);

      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
      try {
        await program.parseAsync(["node", "test", "workflow", "list"]);
      } catch {
        // commander exitOverride throws
      }
      exitSpy.mockRestore();
    });

    it("lists workflows as JSON", async () => {
      await seedWorkflow();
      const output = await registerAndParse(["workflow", "list", "--session", session, "--json"]);
      const parsed = JSON.parse(output);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].name).toBe("Test Pipeline");
      expect(parsed[0].status).toBe("planned");
    });

    it("returns empty for unknown session", async () => {
      const output = await registerAndParse([
        "workflow",
        "list",
        "--session",
        "nonexistent",
        "--json",
      ]);
      const parsed = JSON.parse(output);
      expect(parsed).toHaveLength(0);
    });

    it("filters by status", async () => {
      const wf = await seedWorkflow();
      await transitionWorkflow(tmpDir, session, wf.id, "executing");

      const output = await registerAndParse([
        "workflow",
        "list",
        "--session",
        session,
        "--status",
        "executing",
        "--json",
      ]);
      const parsed = JSON.parse(output);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].status).toBe("executing");

      const output2 = await registerAndParse([
        "workflow",
        "list",
        "--session",
        session,
        "--status",
        "completed",
        "--json",
      ]);
      const parsed2 = JSON.parse(output2);
      expect(parsed2).toHaveLength(0);
    });

    it("lists all workflows across sessions", async () => {
      await seedWorkflow();
      const session2 = "agent:main:test:private:2";
      await createWorkflow(tmpDir, {
        name: "Other Pipeline",
        sessionKey: session2,
        steps: [{ id: "s1", label: "Step 1" }],
      });

      const output = await registerAndParse(["workflow", "list", "--all", "--json"]);
      const parsed = JSON.parse(output);
      expect(parsed).toHaveLength(2);
    });
  });

  describe("workflow status", () => {
    it("shows workflow detail as JSON", async () => {
      const wf = await seedWorkflow();
      await transitionWorkflow(tmpDir, session, wf.id, "executing");
      await transitionStep(tmpDir, session, wf.id, "step-1", "executing");

      const output = await registerAndParse([
        "workflow",
        "status",
        wf.id,
        "--session",
        session,
        "--json",
      ]);
      const parsed = JSON.parse(output);
      expect(parsed.id).toBe(wf.id);
      expect(parsed.status).toBe("executing");
      expect(parsed.steps[0].status).toBe("executing");
      expect(parsed.steps[0].startedAtMs).toBeGreaterThan(0);
    });

    it("includes latest checkpoint in JSON", async () => {
      const wf = await seedWorkflow();
      await saveCheckpoint(tmpDir, session, wf.id, "step-1", { progress: 50 });

      const output = await registerAndParse([
        "workflow",
        "status",
        wf.id,
        "--session",
        session,
        "--json",
      ]);
      const parsed = JSON.parse(output);
      expect(parsed.latestCheckpoint).toBeTruthy();
      expect(parsed.latestCheckpoint.stepId).toBe("step-1");
      expect(parsed.latestCheckpoint.snapshot.progress).toBe(50);
    });
  });

  describe("workflow checkpoint", () => {
    it("creates a checkpoint", async () => {
      const wf = await seedWorkflow();
      await transitionWorkflow(tmpDir, session, wf.id, "executing");
      await transitionStep(tmpDir, session, wf.id, "step-1", "executing");

      const output = await registerAndParse([
        "workflow",
        "checkpoint",
        "create",
        wf.id,
        "--session",
        session,
        "--label",
        "pre-deploy",
        "--json",
      ]);
      const parsed = JSON.parse(output);
      expect(parsed.stepId).toBe("step-1");
      expect(parsed.snapshot.label).toBe("pre-deploy");
    });

    it("lists checkpoints", async () => {
      const wf = await seedWorkflow();
      await saveCheckpoint(tmpDir, session, wf.id, "step-1", { a: 1 });
      await saveCheckpoint(tmpDir, session, wf.id, "step-2", { b: 2 });

      const output = await registerAndParse([
        "workflow",
        "checkpoint",
        "list",
        wf.id,
        "--session",
        session,
        "--json",
      ]);
      const parsed = JSON.parse(output);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].stepId).toBe("step-1");
      expect(parsed[1].stepId).toBe("step-2");
    });

    it("restores (shows) a checkpoint by index", async () => {
      const wf = await seedWorkflow();
      await saveCheckpoint(tmpDir, session, wf.id, "step-1", { state: "saved" });

      const output = await registerAndParse([
        "workflow",
        "checkpoint",
        "restore",
        wf.id,
        "0",
        "--session",
        session,
        "--json",
      ]);
      const parsed = JSON.parse(output);
      expect(parsed.stepId).toBe("step-1");
      expect(parsed.snapshot.state).toBe("saved");
    });
  });
});
