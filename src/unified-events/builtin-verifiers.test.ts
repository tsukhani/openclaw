import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createExecVerifier,
  createMessageVerifier,
  createWriteVerifier,
} from "./builtin-verifiers.js";
import type { ToolCallEvent } from "./types.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ue-builtin-verify-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
});

function makeEvent(overrides?: Partial<ToolCallEvent>): ToolCallEvent {
  return {
    kind: "tool-call",
    id: 1,
    ts: Date.now(),
    sessionKey: "agent:main:test:private:1",
    toolName: "write",
    params: {},
    durationMs: 50,
    result: { status: "ok" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Write verifier
// ---------------------------------------------------------------------------

describe("createWriteVerifier", () => {
  it("passes when file exists with content", async () => {
    const filePath = path.join(tmpDir, "test.txt");
    await fs.writeFile(filePath, "hello");
    const verifier = createWriteVerifier();
    const result = await verifier(makeEvent({ params: { file_path: filePath } }));
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("size");
  });

  it("fails when file does not exist", async () => {
    const filePath = path.join(tmpDir, "nonexistent.txt");
    const verifier = createWriteVerifier();
    const result = await verifier(makeEvent({ params: { file_path: filePath } }));
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("not found");
  });

  it("fails when file is empty", async () => {
    const filePath = path.join(tmpDir, "empty.txt");
    await fs.writeFile(filePath, "");
    const verifier = createWriteVerifier();
    const result = await verifier(makeEvent({ params: { file_path: filePath } }));
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("zero size");
  });

  it("fails when tool returned error", async () => {
    const verifier = createWriteVerifier();
    const result = await verifier(
      makeEvent({ result: { status: "error", error: "write failed" } }),
    );
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("write failed");
  });

  it("skips when no file path in params", async () => {
    const verifier = createWriteVerifier();
    const result = await verifier(makeEvent({ params: {} }));
    expect(result.status).toBe("skipped");
  });

  it("supports path param as alternative to file_path", async () => {
    const filePath = path.join(tmpDir, "alt.txt");
    await fs.writeFile(filePath, "content");
    const verifier = createWriteVerifier();
    const result = await verifier(makeEvent({ params: { path: filePath } }));
    expect(result.status).toBe("pass");
  });

  it("fails when mtime predates tool call", async () => {
    const filePath = path.join(tmpDir, "old.txt");
    await fs.writeFile(filePath, "old content");
    // Set mtime to 10 seconds ago.
    const oldTime = new Date(Date.now() - 10_000);
    await fs.utimes(filePath, oldTime, oldTime);
    const verifier = createWriteVerifier();
    const result = await verifier(makeEvent({ ts: Date.now(), params: { file_path: filePath } }));
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("mtime");
  });
});

// ---------------------------------------------------------------------------
// Exec verifier
// ---------------------------------------------------------------------------

describe("createExecVerifier", () => {
  it("passes on successful exec", async () => {
    const verifier = createExecVerifier();
    const result = await verifier(makeEvent({ toolName: "exec", result: { status: "ok" } }));
    expect(result.status).toBe("pass");
  });

  it("fails on error result", async () => {
    const verifier = createExecVerifier();
    const result = await verifier(
      makeEvent({ toolName: "exec", result: { status: "error", error: "command not found" } }),
    );
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("command not found");
  });

  it("fails on non-zero exit code in summary", async () => {
    const verifier = createExecVerifier();
    const result = await verifier(
      makeEvent({
        toolName: "exec",
        result: { status: "ok", summary: "exit code: 1" },
      }),
    );
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("exit code: 1");
  });

  it("passes on exit code 0 in summary", async () => {
    const verifier = createExecVerifier();
    const result = await verifier(
      makeEvent({
        toolName: "exec",
        result: { status: "ok", summary: "exit code: 0" },
      }),
    );
    expect(result.status).toBe("pass");
  });
});

// ---------------------------------------------------------------------------
// Message verifier
// ---------------------------------------------------------------------------

describe("createMessageVerifier", () => {
  it("passes on successful message send", async () => {
    const verifier = createMessageVerifier();
    const result = await verifier(
      makeEvent({ toolName: "message", result: { status: "ok", summary: "sent" } }),
    );
    expect(result.status).toBe("pass");
  });

  it("fails on error result", async () => {
    const verifier = createMessageVerifier();
    const result = await verifier(
      makeEvent({ toolName: "message", result: { status: "error", error: "timeout" } }),
    );
    expect(result.status).toBe("fail");
  });

  it("fails when summary contains delivery_failed", async () => {
    const verifier = createMessageVerifier();
    const result = await verifier(
      makeEvent({
        toolName: "message",
        result: { status: "ok", summary: "delivery_failed: recipient unavailable" },
      }),
    );
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("Delivery reported as failed");
  });
});
