import type { Command } from "commander";
import { resolveStateDir } from "../config/paths.js";
import { formatTimeAgo } from "../infra/format-time/format-relative.ts";
import { defaultRuntime } from "../runtime.js";
import { getTerminalTableWidth, renderTable } from "../terminal/table.js";
import { theme } from "../terminal/theme.js";
import type { UnifiedEvent, UnifiedEventKind } from "../unified-events/types.js";
import { parseDurationMs } from "./parse-duration.js";

type EventsCliOpts = {
  session?: string;
  all?: boolean;
  kind?: string;
  since?: string;
  limit?: string;
  offset?: string;
  json?: boolean;
  csv?: boolean;
};

function resolveBaseDir(): string {
  return resolveStateDir();
}

function parseSinceToTimestamp(since: string): number {
  const ms = parseDurationMs(since);
  return Date.now() - ms;
}

function formatEventTimestamp(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function summarizeEvent(event: UnifiedEvent): string {
  switch (event.kind) {
    case "tool-call": {
      const dur =
        event.durationMs >= 1000
          ? `${(event.durationMs / 1000).toFixed(1)}s`
          : `${Math.round(event.durationMs)}ms`;
      const status = event.result.status === "ok" ? theme.success("✓") : theme.error("✗");
      return `${event.toolName} (${dur}) ${status}`;
    }
    case "permission-decision":
      return `${event.toolName} → ${event.decision}`;
    case "context-load":
      return `${event.resources.length} file${event.resources.length === 1 ? "" : "s"} loaded`;
    case "routing-decision":
      return `${event.channelId} → ${event.agentId}`;
    case "session-lifecycle":
      return `${event.action}${event.label ? ` (${event.label})` : ""}`;
    case "verification":
      return `${event.toolName} → ${event.verificationStatus}`;
    case "cron-self-destruct":
      return `${event.jobName ?? event.jobId} self-destructed${event.reason ? ` (${event.reason})` : ""}`;
  }
}

function eventToCsvRow(event: UnifiedEvent): string {
  const fields = [
    String(event.id),
    new Date(event.ts).toISOString(),
    event.kind,
    event.sessionKey,
    summarizeEvent(event).replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), ""), // strip ANSI
  ];
  return fields.map((f) => `"${f.replace(/"/g, '""')}"`).join(",");
}

function requireSession(opts: EventsCliOpts): string | null {
  if (!opts.session) {
    defaultRuntime.error("--session is required (or use --all)");
    defaultRuntime.exit(1);
    return null;
  }
  return opts.session;
}

export function registerEventsCli(program: Command) {
  const events = program.command("events").description("Query the unified event log");

  // -- events list ------------------------------------------------------------
  events
    .command("list")
    .description("List events from the unified event log")
    .option("--session <key>", "Session key to query")
    .option("--all", "List events across all sessions", false)
    .option("--kind <kind>", "Filter by event kind")
    .option("--since <duration>", "Time range filter (e.g. 1h, 30m, 2d)")
    .option("--limit <n>", "Max events to return", "50")
    .option("--offset <n>", "Number of events to skip", "0")
    .option("--json", "Output JSON", false)
    .option("--csv", "Output CSV", false)
    .action(async (opts: EventsCliOpts) => {
      if (!opts.all && !opts.session) {
        defaultRuntime.error("Provide --session <key> or --all");
        defaultRuntime.exit(1);
        return;
      }

      const { queryEvents, queryAllEvents } = await import("../unified-events/store.js");
      const baseDir = resolveBaseDir();
      const filter: {
        kinds?: UnifiedEventKind[];
        fromTs?: number;
        limit?: number;
        offset?: number;
      } = {};

      if (opts.kind) {
        filter.kinds = [opts.kind as UnifiedEventKind];
      }
      if (opts.since) {
        try {
          filter.fromTs = parseSinceToTimestamp(opts.since);
        } catch {
          defaultRuntime.error(`Invalid --since value: ${opts.since}`);
          defaultRuntime.exit(1);
          return;
        }
      }
      filter.limit = Number(opts.limit) || 50;
      filter.offset = Number(opts.offset) || 0;

      try {
        const page = opts.all
          ? await queryAllEvents(baseDir, { ...filter, sessionKey: undefined })
          : await queryEvents(baseDir, opts.session!, filter);

        if (opts.json) {
          defaultRuntime.writeJson(page);
          return;
        }

        if (opts.csv) {
          defaultRuntime.log("ID,Time,Kind,Session,Summary");
          for (const event of page.events) {
            defaultRuntime.log(eventToCsvRow(event));
          }
          return;
        }

        if (page.events.length === 0) {
          defaultRuntime.log(theme.muted("No events found."));
          return;
        }

        const tableWidth = getTerminalTableWidth();
        defaultRuntime.log(
          renderTable({
            width: tableWidth,
            columns: [
              { key: "ID", header: "ID", minWidth: 4 },
              { key: "Time", header: "Time", minWidth: 16 },
              { key: "Kind", header: "Kind", minWidth: 12 },
              { key: "Summary", header: "Summary", flex: true },
            ],
            rows: page.events.map((e) => ({
              ID: String(e.id),
              Time: formatEventTimestamp(e.ts),
              Kind: e.kind,
              Summary: summarizeEvent(e),
            })),
          }).trimEnd(),
        );

        if (page.hasMore) {
          defaultRuntime.log(
            theme.muted(
              `\nShowing ${page.events.length} of ${page.total} events (offset ${page.offset})`,
            ),
          );
        }
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  // -- events show ------------------------------------------------------------
  events
    .command("show <event-id>")
    .description("Show a specific event by ID")
    .option("--session <key>", "Session key")
    .option("--json", "Output JSON", false)
    .action(async (eventIdRaw: string, opts: EventsCliOpts) => {
      const session = requireSession(opts);
      if (!session) {
        return;
      }

      const eventId = Number(eventIdRaw);
      if (!Number.isFinite(eventId)) {
        defaultRuntime.error(`Invalid event ID: ${eventIdRaw}`);
        defaultRuntime.exit(1);
        return;
      }

      const { queryEvents } = await import("../unified-events/store.js");
      const baseDir = resolveBaseDir();

      try {
        const page = await queryEvents(baseDir, session, { limit: 1000 });
        const event = page.events.find((e) => e.id === eventId);

        if (!event) {
          defaultRuntime.error(`Event ${eventId} not found in session ${session}`);
          defaultRuntime.exit(1);
          return;
        }

        if (opts.json) {
          defaultRuntime.writeJson(event);
          return;
        }

        defaultRuntime.log(`${theme.heading("Event")} ${theme.muted(`#${event.id}`)}`);
        defaultRuntime.log(`  Kind:    ${event.kind}`);
        defaultRuntime.log(
          `  Time:    ${formatEventTimestamp(event.ts)} (${formatTimeAgo(Date.now() - event.ts)})`,
        );
        defaultRuntime.log(`  Session: ${event.sessionKey}`);
        if (event.runId) {
          defaultRuntime.log(`  Run ID:  ${event.runId}`);
        }
        defaultRuntime.log("");
        defaultRuntime.log(JSON.stringify(event, null, 2));
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  // -- events stats -----------------------------------------------------------
  events
    .command("stats")
    .description("Show event statistics and aggregations")
    .option("--session <key>", "Session key")
    .option("--tool-calls", "Show detailed tool call stats", false)
    .option("--json", "Output JSON", false)
    .action(async (opts: EventsCliOpts & { toolCalls?: boolean }) => {
      const session = requireSession(opts);
      if (!session) {
        return;
      }

      const { queryEvents, aggregateByKind, aggregateToolCalls } =
        await import("../unified-events/store.js");
      const baseDir = resolveBaseDir();

      try {
        const page = await queryEvents(baseDir, session, { limit: 1000 });

        if (opts.json) {
          const kindCounts = aggregateByKind(page.events);
          const toolStats = aggregateToolCalls(page.events);
          defaultRuntime.writeJson({ total: page.total, byKind: kindCounts, toolCalls: toolStats });
          return;
        }

        if (page.events.length === 0) {
          defaultRuntime.log(theme.muted("No events found."));
          return;
        }

        // Event counts by kind
        const kindCounts = aggregateByKind(page.events);
        defaultRuntime.log(theme.heading("Events by Kind"));
        const tableWidth = getTerminalTableWidth();
        defaultRuntime.log(
          renderTable({
            width: tableWidth,
            columns: [
              { key: "Kind", header: "Kind", minWidth: 20, flex: true },
              { key: "Count", header: "Count", minWidth: 8, align: "right" },
            ],
            rows: Object.entries(kindCounts)
              .toSorted(([, a], [, b]) => (b ?? 0) - (a ?? 0))
              .map(([kind, count]) => ({
                Kind: kind,
                Count: String(count ?? 0),
              })),
          }).trimEnd(),
        );
        defaultRuntime.log(`\n${theme.muted(`Total: ${page.total} events`)}`);

        // Tool call stats
        if (opts.toolCalls) {
          const toolStats = aggregateToolCalls(page.events);
          if (toolStats.totalCalls > 0) {
            defaultRuntime.log(`\n${theme.heading("Tool Call Stats")}`);
            defaultRuntime.log(
              `  Total calls: ${toolStats.totalCalls}  |  Errors: ${toolStats.errorCount}  |  Avg duration: ${Math.round(toolStats.avgDurationMs)}ms`,
            );
            defaultRuntime.log("");
            defaultRuntime.log(
              renderTable({
                width: tableWidth,
                columns: [
                  { key: "Tool", header: "Tool", minWidth: 16, flex: true },
                  { key: "Calls", header: "Calls", minWidth: 6, align: "right" },
                  { key: "Errors", header: "Errors", minWidth: 6, align: "right" },
                  { key: "AvgMs", header: "Avg (ms)", minWidth: 10, align: "right" },
                ],
                rows: Object.entries(toolStats.byTool)
                  .toSorted(([, a], [, b]) => b.count - a.count)
                  .map(([tool, stats]) => ({
                    Tool: tool,
                    Calls: String(stats.count),
                    Errors: String(stats.errors),
                    AvgMs: String(Math.round(stats.totalDurationMs / stats.count)),
                  })),
              }).trimEnd(),
            );
          }
        }
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });
}
