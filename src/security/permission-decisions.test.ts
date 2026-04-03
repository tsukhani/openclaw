import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetEventIdCountersForTests } from "../unified-events/store.js";
import {
  clearPermissionDecisionsForTests,
  getLastDecisionForTool,
  getPermissionSummary,
  getSessionPermissionHistory,
  queryPermissionDecisions,
  recordPermissionDecision,
} from "./permission-decisions.js";

let tmpDir: string;

beforeEach(async () => {
  clearPermissionDecisionsForTests();
  resetEventIdCountersForTests();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "perm-dec-test-"));
});

afterEach(async () => {
  clearPermissionDecisionsForTests();
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
});

describe("recordPermissionDecision", () => {
  it("records and retrieves decisions", async () => {
    await recordPermissionDecision(tmpDir, {
      toolName: "exec",
      decision: "allow",
      reason: "allowlisted",
      sessionKey: "agent:main:test:private:1",
    });

    const history = getSessionPermissionHistory("agent:main:test:private:1");
    expect(history).toHaveLength(1);
    expect(history[0].toolName).toBe("exec");
    expect(history[0].decision).toBe("allow");
  });
});

describe("queryPermissionDecisions", () => {
  it("filters by session, tool, and decision", async () => {
    const sk1 = "agent:main:test:private:1";
    const sk2 = "agent:main:test:private:2";
    await recordPermissionDecision(tmpDir, {
      toolName: "exec",
      decision: "allow",
      reason: "ok",
      sessionKey: sk1,
    });
    await recordPermissionDecision(tmpDir, {
      toolName: "read",
      decision: "deny",
      reason: "blocked",
      sessionKey: sk1,
    });
    await recordPermissionDecision(tmpDir, {
      toolName: "exec",
      decision: "allow",
      reason: "ok",
      sessionKey: sk2,
    });

    expect(queryPermissionDecisions({ sessionKey: sk1 })).toHaveLength(2);
    expect(queryPermissionDecisions({ toolName: "exec" })).toHaveLength(2);
    expect(queryPermissionDecisions({ decision: "deny" })).toHaveLength(1);
    expect(queryPermissionDecisions({ sessionKey: sk1, toolName: "read" })).toHaveLength(1);
  });

  it("respects limit", async () => {
    const sk = "agent:main:test:private:1";
    for (let i = 0; i < 5; i++) {
      await recordPermissionDecision(tmpDir, {
        toolName: "exec",
        decision: "allow",
        reason: "ok",
        sessionKey: sk,
      });
    }
    expect(queryPermissionDecisions({ limit: 3 })).toHaveLength(3);
  });
});

describe("getLastDecisionForTool", () => {
  it("returns the most recent decision for a tool in a session", async () => {
    const sk = "agent:main:test:private:1";
    await recordPermissionDecision(tmpDir, {
      toolName: "exec",
      decision: "deny",
      reason: "first",
      sessionKey: sk,
    });
    await recordPermissionDecision(tmpDir, {
      toolName: "exec",
      decision: "allow",
      reason: "second",
      sessionKey: sk,
    });

    const last = getLastDecisionForTool(sk, "exec");
    expect(last?.decision).toBe("allow");
    expect(last?.reason).toBe("second");
  });

  it("returns null when no decision exists", () => {
    expect(getLastDecisionForTool("agent:x:y:z:0", "exec")).toBeNull();
  });
});

describe("getPermissionSummary", () => {
  it("summarizes decisions for a session", async () => {
    const sk = "agent:main:test:private:1";
    await recordPermissionDecision(tmpDir, {
      toolName: "exec",
      decision: "allow",
      reason: "ok",
      sessionKey: sk,
    });
    await recordPermissionDecision(tmpDir, {
      toolName: "read",
      decision: "allow",
      reason: "ok",
      sessionKey: sk,
    });
    await recordPermissionDecision(tmpDir, {
      toolName: "write",
      decision: "deny",
      reason: "no",
      sessionKey: sk,
    });
    await recordPermissionDecision(tmpDir, {
      toolName: "delete",
      decision: "ask",
      reason: "?",
      sessionKey: sk,
    });

    const summary = getPermissionSummary(sk);
    expect(summary.total).toBe(4);
    expect(summary.allowed).toBe(2);
    expect(summary.denied).toBe(1);
    expect(summary.asked).toBe(1);
  });
});
