import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emitSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import {
  emitContextLoad,
  emitRoutingDecision,
  emitSessionLifecycle,
  emitToolCall,
  registerSessionLifecycleListener,
  setBaseDirForTests,
  setEnabledForTests,
  unregisterSessionLifecycleListenerForTests,
} from "./integrations.js";
import { queryEvents, resetEventIdCountersForTests } from "./store.js";

let tmpDir: string;

beforeEach(async () => {
  resetEventIdCountersForTests();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ue-integrations-test-"));
  setBaseDirForTests(tmpDir);
  setEnabledForTests(true);
});

afterEach(async () => {
  setBaseDirForTests(undefined);
  setEnabledForTests(undefined);
  unregisterSessionLifecycleListenerForTests();
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
});

describe("emitToolCall", () => {
  it("writes a tool-call event to the event log", async () => {
    emitToolCall({
      sessionKey: "test-session",
      runId: "run-1",
      toolName: "read",
      toolParams: { file_path: "/tmp/foo" },
      durationMs: 42,
      result: { status: "ok", summary: "read file" },
    });

    // Wait for async write to complete.
    await vi.waitFor(async () => {
      const page = await queryEvents(tmpDir, "test-session");
      expect(page.total).toBe(1);
    });

    const page = await queryEvents(tmpDir, "test-session");
    const event = page.events[0];
    expect(event.kind).toBe("tool-call");
    if (event.kind === "tool-call") {
      expect(event.toolName).toBe("read");
      expect(event.durationMs).toBe(42);
      expect(event.result.status).toBe("ok");
    }
  });

  it("writes error tool-call events", async () => {
    emitToolCall({
      sessionKey: "test-session",
      toolName: "bash",
      toolParams: { command: "exit 1" },
      durationMs: 10,
      result: { status: "error", error: "command failed" },
    });

    await vi.waitFor(async () => {
      const page = await queryEvents(tmpDir, "test-session");
      expect(page.total).toBe(1);
    });

    const page = await queryEvents(tmpDir, "test-session");
    const event = page.events[0];
    if (event.kind === "tool-call") {
      expect(event.result.status).toBe("error");
    }
  });
});

describe("emitContextLoad", () => {
  it("writes a context-load event", async () => {
    emitContextLoad({
      sessionKey: "test-session",
      resources: [
        { path: "/workspace/AGENTS.md", sizeBytes: 1024, source: "workspace" },
        { path: "/workspace/SOUL.md", sizeBytes: 512, source: "workspace" },
      ],
    });

    await vi.waitFor(async () => {
      const page = await queryEvents(tmpDir, "test-session");
      expect(page.total).toBe(1);
    });

    const page = await queryEvents(tmpDir, "test-session");
    const event = page.events[0];
    expect(event.kind).toBe("context-load");
    if (event.kind === "context-load") {
      expect(event.resources).toHaveLength(2);
      expect(event.resources[0].path).toBe("/workspace/AGENTS.md");
    }
  });

  it("skips empty resource lists", async () => {
    emitContextLoad({
      sessionKey: "test-session",
      resources: [],
    });

    // Give time for any potential write.
    await new Promise((r) => setTimeout(r, 50));
    const page = await queryEvents(tmpDir, "test-session");
    expect(page.total).toBe(0);
  });
});

describe("emitRoutingDecision", () => {
  it("writes a routing-decision event", async () => {
    emitRoutingDecision({
      sessionKey: "test-session",
      channelId: "telegram",
      agentId: "main",
      resolvedSessionKey: "agent:main:telegram:private:123",
      reason: "binding.peer",
    });

    await vi.waitFor(async () => {
      const page = await queryEvents(tmpDir, "agent:main:telegram:private:123");
      expect(page.total).toBe(1);
    });

    const page = await queryEvents(tmpDir, "agent:main:telegram:private:123");
    const event = page.events[0];
    expect(event.kind).toBe("routing-decision");
    if (event.kind === "routing-decision") {
      expect(event.channelId).toBe("telegram");
      expect(event.agentId).toBe("main");
      expect(event.reason).toBe("binding.peer");
    }
  });
});

describe("emitSessionLifecycle", () => {
  it("writes a session-lifecycle event", async () => {
    emitSessionLifecycle({
      sessionKey: "test-session",
      action: "start",
      reason: "create",
    });

    await vi.waitFor(async () => {
      const page = await queryEvents(tmpDir, "test-session");
      expect(page.total).toBe(1);
    });

    const page = await queryEvents(tmpDir, "test-session");
    const event = page.events[0];
    expect(event.kind).toBe("session-lifecycle");
    if (event.kind === "session-lifecycle") {
      expect(event.action).toBe("start");
    }
  });
});

describe("feature flag", () => {
  it("does not emit when disabled", async () => {
    setEnabledForTests(false);

    emitToolCall({
      sessionKey: "test-session",
      toolName: "read",
      toolParams: {},
      durationMs: 1,
      result: { status: "ok" },
    });

    await new Promise((r) => setTimeout(r, 50));
    const page = await queryEvents(tmpDir, "test-session");
    expect(page.total).toBe(0);
  });
});

describe("graceful degradation", () => {
  it("does not throw when baseDir is invalid", () => {
    setBaseDirForTests("/nonexistent/deeply/nested/path");

    // Should not throw — fire-and-forget.
    expect(() => {
      emitToolCall({
        sessionKey: "test-session",
        toolName: "read",
        toolParams: {},
        durationMs: 1,
        result: { status: "ok" },
      });
    }).not.toThrow();
  });
});

describe("registerSessionLifecycleListener", () => {
  it("bridges session lifecycle events to unified event log", async () => {
    registerSessionLifecycleListener();

    emitSessionLifecycleEvent({
      sessionKey: "test-session",
      reason: "create",
      label: "test agent",
    });

    await vi.waitFor(async () => {
      const page = await queryEvents(tmpDir, "test-session");
      expect(page.total).toBe(1);
    });

    const page = await queryEvents(tmpDir, "test-session");
    const event = page.events[0];
    expect(event.kind).toBe("session-lifecycle");
    if (event.kind === "session-lifecycle") {
      expect(event.action).toBe("start");
      expect(event.reason).toBe("create");
    }
  });

  it("maps compaction reason to compaction action", async () => {
    registerSessionLifecycleListener();

    emitSessionLifecycleEvent({
      sessionKey: "test-session",
      reason: "compaction",
    });

    await vi.waitFor(async () => {
      const page = await queryEvents(tmpDir, "test-session");
      expect(page.total).toBe(1);
    });

    const page = await queryEvents(tmpDir, "test-session");
    const event = page.events[0];
    if (event.kind === "session-lifecycle") {
      expect(event.action).toBe("compaction");
    }
  });

  it("is idempotent — second call returns same unsubscribe", () => {
    const unsub1 = registerSessionLifecycleListener();
    const unsub2 = registerSessionLifecycleListener();
    expect(unsub1).toBe(unsub2);
  });
});
