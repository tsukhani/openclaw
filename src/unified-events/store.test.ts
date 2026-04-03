import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  aggregateByKind,
  aggregateToolCalls,
  appendEvent,
  onEvent,
  queryAllEvents,
  queryEvents,
  resetEventIdCountersForTests,
  resolveEventLogPath,
  type AppendEventInput,
} from "./store.js";

let tmpDir: string;

beforeEach(async () => {
  resetEventIdCountersForTests();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ue-store-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
});

describe("resolveEventLogPath", () => {
  it("returns a .jsonl path under events/", () => {
    const p = resolveEventLogPath("/base", "agent:main:telegram:private:123");
    expect(p).toContain("/events/");
    expect(p.endsWith(".jsonl")).toBe(true);
  });

  it("sanitizes unsafe characters in session key", () => {
    const p = resolveEventLogPath("/base", "agent/../escape");
    // The `/` is replaced by `_`, so path traversal is prevented.
    expect(p).not.toContain("/escape");
    expect(path.basename(p)).not.toContain("/");
  });

  it("throws for empty session key", () => {
    expect(() => resolveEventLogPath("/base", "")).toThrow("invalid session key");
  });
});

describe("appendEvent + queryEvents", () => {
  it("appends and reads back a tool-call event", async () => {
    const input: AppendEventInput = {
      kind: "tool-call",
      sessionKey: "agent:main:test:private:1",
      toolName: "exec",
      params: { command: "ls" },
      durationMs: 42,
      result: { status: "ok", summary: "listed files" },
    };
    const event = await appendEvent(tmpDir, input);
    expect(event.id).toBe(1);
    expect(event.ts).toBeGreaterThan(0);
    expect(event.kind).toBe("tool-call");

    const page = await queryEvents(tmpDir, "agent:main:test:private:1");
    expect(page.events).toHaveLength(1);
    expect(page.events[0].kind).toBe("tool-call");
    expect(page.total).toBe(1);
  });

  it("assigns monotonic IDs per session", async () => {
    const base: AppendEventInput = {
      kind: "session-lifecycle",
      sessionKey: "agent:main:test:private:1",
      action: "start",
    };
    const e1 = await appendEvent(tmpDir, base);
    const e2 = await appendEvent(tmpDir, base);
    expect(e1.id).toBe(1);
    expect(e2.id).toBe(2);
  });

  it("filters by kind", async () => {
    const sessionKey = "agent:main:test:private:2";
    await appendEvent(tmpDir, {
      kind: "tool-call",
      sessionKey,
      toolName: "exec",
      params: {},
      durationMs: 10,
      result: { status: "ok" },
    });
    await appendEvent(tmpDir, {
      kind: "session-lifecycle",
      sessionKey,
      action: "start",
    });

    const page = await queryEvents(tmpDir, sessionKey, { kinds: ["tool-call"] });
    expect(page.events).toHaveLength(1);
    expect(page.events[0].kind).toBe("tool-call");
  });

  it("filters by time range", async () => {
    const sessionKey = "agent:main:test:private:3";
    await appendEvent(tmpDir, {
      kind: "session-lifecycle",
      sessionKey,
      action: "start",
      ts: 1000,
    });
    await appendEvent(tmpDir, {
      kind: "session-lifecycle",
      sessionKey,
      action: "end",
      ts: 2000,
    });

    const page = await queryEvents(tmpDir, sessionKey, { fromTs: 1500 });
    expect(page.events).toHaveLength(1);
    expect(page.events[0].ts).toBe(2000);
  });

  it("supports pagination", async () => {
    const sessionKey = "agent:main:test:private:4";
    for (let i = 0; i < 5; i++) {
      await appendEvent(tmpDir, {
        kind: "session-lifecycle",
        sessionKey,
        action: "start",
      });
    }

    const p1 = await queryEvents(tmpDir, sessionKey, { limit: 2, offset: 0 });
    expect(p1.events).toHaveLength(2);
    expect(p1.hasMore).toBe(true);

    const p2 = await queryEvents(tmpDir, sessionKey, { limit: 2, offset: 4 });
    expect(p2.events).toHaveLength(1);
    expect(p2.hasMore).toBe(false);
  });
});

describe("queryAllEvents", () => {
  it("reads across multiple session logs", async () => {
    await appendEvent(tmpDir, {
      kind: "session-lifecycle",
      sessionKey: "agent:a:test:private:1",
      action: "start",
      ts: 100,
    });
    await appendEvent(tmpDir, {
      kind: "session-lifecycle",
      sessionKey: "agent:b:test:private:2",
      action: "start",
      ts: 200,
    });

    const page = await queryAllEvents(tmpDir);
    expect(page.events).toHaveLength(2);
    // Sorted by timestamp ascending.
    expect(page.events[0].ts).toBe(100);
    expect(page.events[1].ts).toBe(200);
  });
});

describe("onEvent listener", () => {
  it("notifies listeners on append", async () => {
    const received: unknown[] = [];
    const unsub = onEvent((e) => received.push(e));

    await appendEvent(tmpDir, {
      kind: "session-lifecycle",
      sessionKey: "agent:main:test:private:5",
      action: "start",
    });

    expect(received).toHaveLength(1);
    unsub();

    await appendEvent(tmpDir, {
      kind: "session-lifecycle",
      sessionKey: "agent:main:test:private:5",
      action: "end",
    });
    // Should not receive after unsub.
    expect(received).toHaveLength(1);
  });
});

describe("aggregation helpers", () => {
  it("aggregateByKind counts event kinds", () => {
    const events = [
      { kind: "tool-call" as const },
      { kind: "tool-call" as const },
      { kind: "session-lifecycle" as const },
    ];
    const counts = aggregateByKind(events as never[]);
    expect(counts["tool-call"]).toBe(2);
    expect(counts["session-lifecycle"]).toBe(1);
  });

  it("aggregateToolCalls computes stats", () => {
    const events = [
      {
        kind: "tool-call" as const,
        toolName: "exec",
        durationMs: 100,
        result: { status: "ok" as const },
      },
      {
        kind: "tool-call" as const,
        toolName: "exec",
        durationMs: 200,
        result: { status: "error" as const, error: "fail" },
      },
      {
        kind: "tool-call" as const,
        toolName: "read",
        durationMs: 50,
        result: { status: "ok" as const },
      },
    ];
    const stats = aggregateToolCalls(events as never[]);
    expect(stats.totalCalls).toBe(3);
    expect(stats.errorCount).toBe(1);
    expect(stats.avgDurationMs).toBeCloseTo(116.67, 1);
    expect(stats.byTool.exec?.count).toBe(2);
    expect(stats.byTool.exec?.errors).toBe(1);
    expect(stats.byTool.read?.count).toBe(1);
  });
});
