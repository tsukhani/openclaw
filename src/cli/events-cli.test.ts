import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendEvent,
  resetEventIdCountersForTests,
  type AppendEventInput,
} from "../unified-events/store.js";

let tmpDir: string;

vi.mock("../config/paths.js", () => ({
  resolveStateDir: () => tmpDir,
}));

beforeEach(async () => {
  resetEventIdCountersForTests();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "events-cli-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
});

async function seedEvents(sessionKey: string, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    const input: AppendEventInput = {
      kind: "tool-call",
      sessionKey,
      toolName: `tool-${i}`,
      params: { i },
      durationMs: 100 + i * 50,
      result: i % 3 === 0 ? { status: "error", error: "fail" } : { status: "ok" },
    };
    await appendEvent(tmpDir, input);
  }
}

function createProgram(): Command {
  return new Command().exitOverride();
}

/**
 * Captures all output (console.log for text, process.stdout.write for JSON)
 * during a CLI parse.
 */
async function registerAndParse(args: string[]): Promise<string> {
  const { registerEventsCli } = await import("./events-cli.js");
  const program = createProgram();
  registerEventsCli(program);

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

describe("events-cli", () => {
  const session = "agent:main:test:private:1";

  describe("events list", () => {
    it("requires --session or --all", async () => {
      const { registerEventsCli } = await import("./events-cli.js");
      const program = createProgram();
      registerEventsCli(program);

      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
      try {
        await program.parseAsync(["node", "test", "events", "list"]);
      } catch {
        // commander exitOverride throws
      }
      exitSpy.mockRestore();
    });

    it("lists events as JSON", async () => {
      await seedEvents(session, 3);
      const output = await registerAndParse(["events", "list", "--session", session, "--json"]);
      const parsed = JSON.parse(output);
      expect(parsed.events).toHaveLength(3);
      expect(parsed.total).toBe(3);
    });

    it("lists events as CSV", async () => {
      await seedEvents(session, 2);
      const output = await registerAndParse(["events", "list", "--session", session, "--csv"]);
      expect(output).toContain("ID,Time,Kind,Session,Summary");
      const lines = output.trim().split("\n");
      // header + 2 data rows
      expect(lines.length).toBeGreaterThanOrEqual(3);
    });

    it("returns empty for unknown session", async () => {
      const output = await registerAndParse([
        "events",
        "list",
        "--session",
        "nonexistent",
        "--json",
      ]);
      const parsed = JSON.parse(output);
      expect(parsed.events).toHaveLength(0);
    });

    it("filters by kind", async () => {
      await seedEvents(session, 3);
      await appendEvent(tmpDir, {
        kind: "context-load",
        sessionKey: session,
        resources: [{ path: "/a.ts", source: "workspace" }],
      });
      const output = await registerAndParse([
        "events",
        "list",
        "--session",
        session,
        "--kind",
        "context-load",
        "--json",
      ]);
      const parsed = JSON.parse(output);
      expect(parsed.events).toHaveLength(1);
      expect(parsed.events[0].kind).toBe("context-load");
    });

    it("respects --limit", async () => {
      await seedEvents(session, 10);
      const output = await registerAndParse([
        "events",
        "list",
        "--session",
        session,
        "--limit",
        "3",
        "--json",
      ]);
      const parsed = JSON.parse(output);
      expect(parsed.events).toHaveLength(3);
      expect(parsed.hasMore).toBe(true);
    });
  });

  describe("events show", () => {
    it("shows a specific event as JSON", async () => {
      await seedEvents(session, 5);
      const output = await registerAndParse([
        "events",
        "show",
        "3",
        "--session",
        session,
        "--json",
      ]);
      const parsed = JSON.parse(output);
      expect(parsed.id).toBe(3);
      expect(parsed.kind).toBe("tool-call");
    });
  });

  describe("events stats", () => {
    it("returns stats as JSON", async () => {
      await seedEvents(session, 6);
      await appendEvent(tmpDir, {
        kind: "context-load",
        sessionKey: session,
        resources: [{ path: "/a.ts", source: "workspace" }],
      });

      const output = await registerAndParse(["events", "stats", "--session", session, "--json"]);
      const parsed = JSON.parse(output);
      expect(parsed.total).toBe(7);
      expect(parsed.byKind["tool-call"]).toBe(6);
      expect(parsed.byKind["context-load"]).toBe(1);
      expect(parsed.toolCalls.totalCalls).toBe(6);
      expect(parsed.toolCalls.errorCount).toBe(2); // i=0 and i=3
    });
  });
});
