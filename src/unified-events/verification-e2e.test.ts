/**
 * End-to-end integration test for the verification pipeline.
 *
 * Exercises the full flow: register builtin verifiers → emit tool call
 * with verification → confirm both tool-call and verification events
 * are recorded in the event log.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emitToolCallAndVerify, setBaseDirForTests, setEnabledForTests } from "./integrations.js";
import { registerBuiltinVerifiers, unregisterAllVerifiers } from "./register-verifiers.js";
import { queryEvents, resetEventIdCountersForTests } from "./store.js";
import type { ToolCallEvent, VerificationEvent } from "./types.js";

let tmpDir: string;

beforeEach(async () => {
  resetEventIdCountersForTests();
  unregisterAllVerifiers();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ue-verify-e2e-"));
  setBaseDirForTests(tmpDir);
  setEnabledForTests(true);
});

afterEach(async () => {
  setBaseDirForTests(undefined);
  setEnabledForTests(undefined);
  unregisterAllVerifiers();
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
});

describe("verification e2e", () => {
  it("records a pass verification event for a successful exec tool call", async () => {
    registerBuiltinVerifiers();

    emitToolCallAndVerify({
      sessionKey: "agent:main:test:private:e2e",
      runId: "run-e2e-1",
      toolName: "exec",
      toolParams: { command: "echo hello" },
      durationMs: 15,
      result: { status: "ok", summary: "exit code: 0" },
    });

    await vi.waitFor(async () => {
      const page = await queryEvents(tmpDir, "agent:main:test:private:e2e");
      expect(page.total).toBeGreaterThanOrEqual(2);
    });

    const page = await queryEvents(tmpDir, "agent:main:test:private:e2e");
    const toolCallEvent = page.events.find((e) => e.kind === "tool-call");
    const verificationEvent = page.events.find((e) => e.kind === "verification");

    expect(toolCallEvent).toBeDefined();
    expect(toolCallEvent!.toolName).toBe("exec");
    expect(toolCallEvent!.result.status).toBe("ok");

    expect(verificationEvent).toBeDefined();
    expect(verificationEvent!.toolName).toBe("exec");
    expect(verificationEvent!.verificationStatus).toBe("pass");
    expect(verificationEvent!.toolCallId).toBe(toolCallEvent!.id);
  });

  it("records a fail verification event for an exec error", async () => {
    registerBuiltinVerifiers();

    emitToolCallAndVerify({
      sessionKey: "agent:main:test:private:e2e",
      runId: "run-e2e-2",
      toolName: "exec",
      toolParams: { command: "exit 1" },
      durationMs: 10,
      result: { status: "error", error: "command failed" },
    });

    await vi.waitFor(async () => {
      const page = await queryEvents(tmpDir, "agent:main:test:private:e2e");
      expect(page.total).toBeGreaterThanOrEqual(2);
    });

    const page = await queryEvents(tmpDir, "agent:main:test:private:e2e");
    const verificationEvent = page.events.find((e) => e.kind === "verification");

    expect(verificationEvent).toBeDefined();
    expect(verificationEvent!.verificationStatus).toBe("fail");
    expect(verificationEvent!.detail).toContain("command failed");
  });

  it("records a pass verification for a successful write with real file", async () => {
    registerBuiltinVerifiers();

    const filePath = path.join(tmpDir, "test-write.txt");
    await fs.writeFile(filePath, "hello world");

    emitToolCallAndVerify({
      sessionKey: "agent:main:test:private:e2e",
      runId: "run-e2e-3",
      toolName: "write",
      toolParams: { file_path: filePath },
      durationMs: 20,
      result: { status: "ok", summary: "wrote file" },
    });

    await vi.waitFor(async () => {
      const page = await queryEvents(tmpDir, "agent:main:test:private:e2e");
      expect(page.total).toBeGreaterThanOrEqual(2);
    });

    const page = await queryEvents(tmpDir, "agent:main:test:private:e2e");
    const verificationEvent = page.events.find((e) => e.kind === "verification");

    expect(verificationEvent).toBeDefined();
    expect(verificationEvent!.verificationStatus).toBe("pass");
    expect(verificationEvent!.detail).toContain("size");
  });

  it("records a fail verification for a write to a missing file", async () => {
    registerBuiltinVerifiers();

    emitToolCallAndVerify({
      sessionKey: "agent:main:test:private:e2e",
      runId: "run-e2e-4",
      toolName: "write",
      toolParams: { file_path: path.join(tmpDir, "nonexistent.txt") },
      durationMs: 5,
      result: { status: "ok", summary: "wrote file" },
    });

    await vi.waitFor(async () => {
      const page = await queryEvents(tmpDir, "agent:main:test:private:e2e");
      expect(page.total).toBeGreaterThanOrEqual(2);
    });

    const page = await queryEvents(tmpDir, "agent:main:test:private:e2e");
    const verificationEvent = page.events.find((e) => e.kind === "verification");

    expect(verificationEvent).toBeDefined();
    expect(verificationEvent!.verificationStatus).toBe("fail");
    expect(verificationEvent!.detail).toContain("not found");
  });

  it("records a pass verification for a successful message send", async () => {
    registerBuiltinVerifiers();

    emitToolCallAndVerify({
      sessionKey: "agent:main:test:private:e2e",
      runId: "run-e2e-5",
      toolName: "message",
      toolParams: { content: "hello" },
      durationMs: 30,
      result: { status: "ok", summary: "sent" },
    });

    await vi.waitFor(async () => {
      const page = await queryEvents(tmpDir, "agent:main:test:private:e2e");
      expect(page.total).toBeGreaterThanOrEqual(2);
    });

    const page = await queryEvents(tmpDir, "agent:main:test:private:e2e");
    const verificationEvent = page.events.find((e) => e.kind === "verification");

    expect(verificationEvent).toBeDefined();
    expect(verificationEvent!.verificationStatus).toBe("pass");
  });

  it("skips verification when no verifier is registered for the tool", async () => {
    registerBuiltinVerifiers();

    emitToolCallAndVerify({
      sessionKey: "agent:main:test:private:e2e",
      runId: "run-e2e-6",
      toolName: "read",
      toolParams: { file_path: "/tmp/foo" },
      durationMs: 5,
      result: { status: "ok", summary: "read file" },
    });

    // Wait for the tool-call event to be written.
    await vi.waitFor(async () => {
      const page = await queryEvents(tmpDir, "agent:main:test:private:e2e");
      expect(page.total).toBeGreaterThanOrEqual(1);
    });

    // Give a small window for any verification event to appear.
    await new Promise((r) => setTimeout(r, 50));

    const page = await queryEvents(tmpDir, "agent:main:test:private:e2e");
    expect(page.events.filter((e) => e.kind === "verification")).toHaveLength(0);
    expect(page.events.filter((e) => e.kind === "tool-call")).toHaveLength(1);
  });

  it("does not record verification events when verifiers are disabled", async () => {
    // Do NOT register verifiers.

    emitToolCallAndVerify({
      sessionKey: "agent:main:test:private:e2e",
      runId: "run-e2e-7",
      toolName: "exec",
      toolParams: { command: "echo hello" },
      durationMs: 5,
      result: { status: "ok" },
    });

    await vi.waitFor(async () => {
      const page = await queryEvents(tmpDir, "agent:main:test:private:e2e");
      expect(page.total).toBeGreaterThanOrEqual(1);
    });

    await new Promise((r) => setTimeout(r, 50));

    const page = await queryEvents(tmpDir, "agent:main:test:private:e2e");
    expect(page.events.filter((e) => e.kind === "verification")).toHaveLength(0);
  });
});
