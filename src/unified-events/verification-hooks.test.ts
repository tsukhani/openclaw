import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetEventIdCountersForTests } from "./store.js";
import type { ToolCallEvent } from "./types.js";
import {
  clearVerifiersForTests,
  createDurationThresholdVerifier,
  createErrorCheckVerifier,
  getRegisteredVerifierTools,
  hasVerifier,
  registerToolVerifier,
  runVerification,
} from "./verification-hooks.js";

let tmpDir: string;

beforeEach(async () => {
  clearVerifiersForTests();
  resetEventIdCountersForTests();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ue-verify-test-"));
});

afterEach(async () => {
  clearVerifiersForTests();
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
});

function makeToolCallEvent(overrides?: Partial<ToolCallEvent>): ToolCallEvent {
  return {
    kind: "tool-call",
    id: 1,
    ts: Date.now(),
    sessionKey: "agent:main:test:private:1",
    toolName: "exec",
    params: {},
    durationMs: 50,
    result: { status: "ok" },
    ...overrides,
  };
}

describe("registerToolVerifier", () => {
  it("registers and unregisters verifiers", () => {
    expect(hasVerifier("exec")).toBe(false);
    const unsub = registerToolVerifier("exec", () => ({ status: "pass" }));
    expect(hasVerifier("exec")).toBe(true);
    expect(getRegisteredVerifierTools()).toContain("exec");
    unsub();
    expect(hasVerifier("exec")).toBe(false);
  });
});

describe("runVerification", () => {
  it("returns null when no verifier registered", async () => {
    const result = await runVerification(tmpDir, makeToolCallEvent());
    expect(result).toBeNull();
  });

  it("runs registered verifier and returns result", async () => {
    registerToolVerifier("exec", () => ({ status: "pass", detail: "all good" }));
    const result = await runVerification(tmpDir, makeToolCallEvent());
    expect(result).toEqual({ status: "pass", detail: "all good" });
  });

  it("catches verifier errors", async () => {
    registerToolVerifier("exec", () => {
      throw new Error("boom");
    });
    const result = await runVerification(tmpDir, makeToolCallEvent());
    expect(result?.status).toBe("fail");
    expect(result?.detail).toContain("boom");
  });

  it("supports async verifiers", async () => {
    registerToolVerifier("exec", async () => {
      return { status: "pass" };
    });
    const result = await runVerification(tmpDir, makeToolCallEvent());
    expect(result?.status).toBe("pass");
  });
});

describe("built-in verifiers", () => {
  it("createErrorCheckVerifier detects errors", async () => {
    const verifier = createErrorCheckVerifier();
    const okResult = await verifier(makeToolCallEvent({ result: { status: "ok" } }));
    expect(okResult.status).toBe("pass");

    const errResult = await verifier(
      makeToolCallEvent({ result: { status: "error", error: "bad" } }),
    );
    expect(errResult.status).toBe("fail");
  });

  it("createDurationThresholdVerifier checks duration", async () => {
    const verifier = createDurationThresholdVerifier(100);
    const fastResult = await verifier(makeToolCallEvent({ durationMs: 50 }));
    expect(fastResult.status).toBe("pass");

    const slowResult = await verifier(makeToolCallEvent({ durationMs: 200 }));
    expect(slowResult.status).toBe("fail");
    expect(slowResult.detail).toContain("200ms");
  });
});
