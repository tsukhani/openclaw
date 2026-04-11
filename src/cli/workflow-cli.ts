import fs from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import { resolveStateDir } from "../config/paths.js";
import { formatTimeAgo } from "../infra/format-time/format-relative.ts";
import { defaultRuntime } from "../runtime.js";
import { getTerminalTableWidth, renderTable } from "../terminal/table.js";
import { theme } from "../terminal/theme.js";
import type { Workflow, WorkflowStatus } from "../workflow-state/types.js";

type WorkflowCliOpts = {
  session?: string;
  all?: boolean;
  status?: string;
  json?: boolean;
  label?: string;
};

function resolveBaseDir(): string {
  return resolveStateDir();
}

function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatStepProgress(workflow: Workflow): string {
  const completed = workflow.steps.filter((s) => s.status === "completed").length;
  return `${completed}/${workflow.steps.length}`;
}

function statusColor(status: WorkflowStatus): string {
  switch (status) {
    case "completed":
      return theme.success(status);
    case "failed":
      return theme.error(status);
    case "executing":
      return theme.info(status);
    case "waiting":
      return theme.warn(status);
    case "planned":
      return theme.muted(status);
    default:
      return String(status);
  }
}

async function listAllWorkflows(baseDir: string): Promise<Workflow[]> {
  const workflowDir = path.resolve(baseDir, "workflow");
  const files = await fs.readdir(workflowDir, { withFileTypes: true }).catch(() => []);
  const jsonFiles = files
    .filter((f) => f.isFile() && f.name.endsWith(".json"))
    .map((f) => path.join(workflowDir, f.name));

  const all: Workflow[] = [];
  for (const filePath of jsonFiles) {
    const raw = await fs.readFile(filePath, "utf-8").catch(() => "");
    if (!raw.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(raw) as { version?: number; workflows?: Workflow[] };
      if (parsed.version === 1 && Array.isArray(parsed.workflows)) {
        all.push(...parsed.workflows);
      }
    } catch {
      // skip corrupt files
    }
  }

  return all.toSorted((a, b) => b.updatedAtMs - a.updatedAtMs);
}

function requireSession(opts: WorkflowCliOpts): string | null {
  if (!opts.session) {
    defaultRuntime.error("--session is required (or use --all)");
    defaultRuntime.exit(1);
    return null;
  }
  return opts.session;
}

export function registerWorkflowCli(program: Command) {
  const workflow = program.command("workflow").description("Query and manage workflow state");

  // -- workflow list ----------------------------------------------------------
  workflow
    .command("list")
    .description("List workflows for a session")
    .option("--session <key>", "Session key")
    .option("--all", "List workflows across all sessions", false)
    .option("--status <status>", "Filter by workflow status")
    .option("--json", "Output JSON", false)
    .action(async (opts: WorkflowCliOpts) => {
      if (!opts.all && !opts.session) {
        defaultRuntime.error("Provide --session <key> or --all");
        defaultRuntime.exit(1);
        return;
      }

      const baseDir = resolveBaseDir();

      try {
        let workflows: Workflow[];
        if (opts.all) {
          workflows = await listAllWorkflows(baseDir);
        } else {
          const { listWorkflows } = await import("../workflow-state/store.js");
          workflows = await listWorkflows(baseDir, opts.session!);
        }

        if (opts.status) {
          workflows = workflows.filter((w) => w.status === opts.status);
        }

        if (opts.json) {
          defaultRuntime.writeJson(workflows);
          return;
        }

        if (workflows.length === 0) {
          defaultRuntime.log(theme.muted("No workflows found."));
          return;
        }

        const tableWidth = getTerminalTableWidth();
        defaultRuntime.log(
          renderTable({
            width: tableWidth,
            columns: [
              { key: "ID", header: "ID", minWidth: 14 },
              { key: "Name", header: "Name", minWidth: 16, flex: true },
              { key: "Status", header: "Status", minWidth: 10 },
              { key: "Steps", header: "Steps", minWidth: 6 },
              { key: "Created", header: "Created", minWidth: 16 },
              { key: "Updated", header: "Updated", minWidth: 10 },
            ],
            rows: workflows.map((w) => ({
              ID: w.id,
              Name: w.name,
              Status: statusColor(w.status),
              Steps: formatStepProgress(w),
              Created: formatTimestamp(w.createdAtMs),
              Updated: formatTimeAgo(Date.now() - w.updatedAtMs),
            })),
          }).trimEnd(),
        );
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  // -- workflow status --------------------------------------------------------
  workflow
    .command("status <workflow-id>")
    .description("Show detailed status of a workflow")
    .option("--session <key>", "Session key")
    .option("--json", "Output JSON", false)
    .action(async (workflowId: string, opts: WorkflowCliOpts) => {
      const session = requireSession(opts);
      if (!session) {
        return;
      }

      const { getWorkflow, getLatestCheckpoint } = await import("../workflow-state/store.js");
      const baseDir = resolveBaseDir();

      try {
        const wf = await getWorkflow(baseDir, session, workflowId);
        if (!wf) {
          defaultRuntime.error(`Workflow ${workflowId} not found in session ${session}`);
          defaultRuntime.exit(1);
          return;
        }

        if (opts.json) {
          const checkpoint = await getLatestCheckpoint(baseDir, session, workflowId);
          defaultRuntime.writeJson({ ...wf, latestCheckpoint: checkpoint });
          return;
        }

        // Workflow metadata
        defaultRuntime.log(theme.heading("Workflow"));
        defaultRuntime.log(`  ID:      ${wf.id}`);
        defaultRuntime.log(`  Name:    ${wf.name}`);
        defaultRuntime.log(`  Status:  ${statusColor(wf.status)}`);
        defaultRuntime.log(`  Created: ${formatTimestamp(wf.createdAtMs)}`);
        defaultRuntime.log(
          `  Updated: ${formatTimestamp(wf.updatedAtMs)} (${formatTimeAgo(Date.now() - wf.updatedAtMs)})`,
        );
        if (wf.parentWorkflowId) {
          defaultRuntime.log(`  Parent:  ${wf.parentWorkflowId}`);
        }
        if (wf.metadata && Object.keys(wf.metadata).length > 0) {
          defaultRuntime.log(`  Meta:    ${JSON.stringify(wf.metadata)}`);
        }

        // Steps table
        if (wf.steps.length > 0) {
          defaultRuntime.log(`\n${theme.heading("Steps")}`);
          const tableWidth = getTerminalTableWidth();
          defaultRuntime.log(
            renderTable({
              width: tableWidth,
              columns: [
                { key: "ID", header: "ID", minWidth: 10 },
                { key: "Label", header: "Label", minWidth: 16, flex: true },
                { key: "Status", header: "Status", minWidth: 10 },
                { key: "Started", header: "Started", minWidth: 16 },
                { key: "Completed", header: "Completed", minWidth: 16 },
              ],
              rows: wf.steps.map((s) => ({
                ID: s.id,
                Label: s.label,
                Status: statusColor(s.status),
                Started: s.startedAtMs ? formatTimestamp(s.startedAtMs) : theme.muted("—"),
                Completed: s.completedAtMs ? formatTimestamp(s.completedAtMs) : theme.muted("—"),
              })),
            }).trimEnd(),
          );
        }

        // Latest checkpoint
        const checkpoint = await getLatestCheckpoint(baseDir, session, workflowId);
        if (checkpoint) {
          defaultRuntime.log(`\n${theme.heading("Latest Checkpoint")}`);
          defaultRuntime.log(`  Step:  ${checkpoint.stepId}`);
          defaultRuntime.log(
            `  Saved: ${formatTimestamp(checkpoint.savedAtMs)} (${formatTimeAgo(Date.now() - checkpoint.savedAtMs)})`,
          );
        }
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  // -- workflow checkpoint ----------------------------------------------------
  const checkpoint = workflow.command("checkpoint").description("Manual checkpoint operations");

  checkpoint
    .command("create <workflow-id>")
    .description("Create a checkpoint for a workflow")
    .option("--session <key>", "Session key")
    .option("--label <label>", "Checkpoint label")
    .option("--json", "Output JSON", false)
    .action(async (workflowId: string, opts: WorkflowCliOpts) => {
      const session = requireSession(opts);
      if (!session) {
        return;
      }

      const { getWorkflow, saveCheckpoint } = await import("../workflow-state/store.js");
      const baseDir = resolveBaseDir();

      try {
        const wf = await getWorkflow(baseDir, session, workflowId);
        if (!wf) {
          defaultRuntime.error(`Workflow ${workflowId} not found`);
          defaultRuntime.exit(1);
          return;
        }

        // Find the current executing step, or use the last step
        const currentStep =
          wf.steps.find((s) => s.status === "executing") ?? wf.steps[wf.steps.length - 1];
        if (!currentStep) {
          defaultRuntime.error("No steps in workflow");
          defaultRuntime.exit(1);
          return;
        }

        const snapshot: Record<string, unknown> = {
          label: opts.label ?? `manual-${Date.now()}`,
          workflowStatus: wf.status,
          stepStatuses: Object.fromEntries(wf.steps.map((s) => [s.id, s.status])),
        };

        const cp = await saveCheckpoint(baseDir, session, workflowId, currentStep.id, snapshot);
        if (!cp) {
          defaultRuntime.error("Failed to save checkpoint");
          defaultRuntime.exit(1);
          return;
        }

        if (opts.json) {
          defaultRuntime.writeJson(cp);
          return;
        }

        defaultRuntime.log(
          `${theme.success("Checkpoint saved")} for step ${theme.info(currentStep.id)} at ${formatTimestamp(cp.savedAtMs)}`,
        );
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  checkpoint
    .command("list <workflow-id>")
    .description("List checkpoints for a workflow")
    .option("--session <key>", "Session key")
    .option("--json", "Output JSON", false)
    .action(async (workflowId: string, opts: WorkflowCliOpts) => {
      const session = requireSession(opts);
      if (!session) {
        return;
      }

      const { getWorkflow } = await import("../workflow-state/store.js");
      const baseDir = resolveBaseDir();

      try {
        const wf = await getWorkflow(baseDir, session, workflowId);
        if (!wf) {
          defaultRuntime.error(`Workflow ${workflowId} not found`);
          defaultRuntime.exit(1);
          return;
        }

        if (opts.json) {
          defaultRuntime.writeJson(wf.checkpoints);
          return;
        }

        if (wf.checkpoints.length === 0) {
          defaultRuntime.log(theme.muted("No checkpoints found."));
          return;
        }

        const tableWidth = getTerminalTableWidth();
        defaultRuntime.log(
          renderTable({
            width: tableWidth,
            columns: [
              { key: "Index", header: "#", minWidth: 3 },
              { key: "Step", header: "Step", minWidth: 10, flex: true },
              { key: "Saved", header: "Saved", minWidth: 16 },
              { key: "Age", header: "Age", minWidth: 10 },
            ],
            rows: wf.checkpoints.map((cp, i) => ({
              Index: String(i),
              Step: cp.stepId,
              Saved: formatTimestamp(cp.savedAtMs),
              Age: formatTimeAgo(Date.now() - cp.savedAtMs),
            })),
          }).trimEnd(),
        );
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  checkpoint
    .command("restore <workflow-id> <checkpoint-index>")
    .description("Restore a workflow from a checkpoint")
    .option("--session <key>", "Session key")
    .option("--json", "Output JSON", false)
    .action(async (workflowId: string, checkpointIndexRaw: string, opts: WorkflowCliOpts) => {
      const session = requireSession(opts);
      if (!session) {
        return;
      }

      const { getWorkflow } = await import("../workflow-state/store.js");
      const baseDir = resolveBaseDir();

      try {
        const wf = await getWorkflow(baseDir, session, workflowId);
        if (!wf) {
          defaultRuntime.error(`Workflow ${workflowId} not found`);
          defaultRuntime.exit(1);
          return;
        }

        const checkpointIndex = Number(checkpointIndexRaw);
        if (
          !Number.isFinite(checkpointIndex) ||
          checkpointIndex < 0 ||
          checkpointIndex >= wf.checkpoints.length
        ) {
          defaultRuntime.error(
            `Invalid checkpoint index: ${checkpointIndexRaw} (valid: 0-${wf.checkpoints.length - 1})`,
          );
          defaultRuntime.exit(1);
          return;
        }

        const cp = wf.checkpoints[checkpointIndex];

        if (opts.json) {
          defaultRuntime.writeJson(cp);
          return;
        }

        defaultRuntime.log(theme.heading("Checkpoint Snapshot"));
        defaultRuntime.log(`  Step:  ${cp.stepId}`);
        defaultRuntime.log(`  Saved: ${formatTimestamp(cp.savedAtMs)}`);
        defaultRuntime.log("");
        defaultRuntime.log(JSON.stringify(cp.snapshot, null, 2));
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });
}
