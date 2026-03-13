import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtractionConfig } from "./config.js";
import { detectTaskSignals } from "./task-detector.js";

const { callLlmMock } = vi.hoisted(() => ({
  callLlmMock: vi.fn(),
}));

vi.mock("./llm-client.js", () => ({
  callLlm: callLlmMock,
}));

const extractionConfig: ExtractionConfig = {
  enabled: true,
  apiKey: "test-key",
  model: "test-model",
  baseUrl: "https://test.ai/api/v1",
  temperature: 0.0,
  maxRetries: 0,
  autoCaptureTasks: true,
};

describe("detectTaskSignals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    callLlmMock.mockReset();
  });

  it("detects a new task signal", async () => {
    callLlmMock.mockResolvedValue(
      JSON.stringify({
        signals: [
          {
            kind: "new_task",
            title: "Implement TASKS auto-capture",
            details: "Add task detector and ledger writes",
            currentStep: "Create task-detector.ts",
          },
        ],
      }),
    );

    const result = await detectTaskSignals(
      "I’m starting OP-133 now. I’ll add task detection, wire it into auto-capture, and update TASKS.md automatically so the work survives compaction.",
      extractionConfig,
    );

    expect(result.skipped).toBe(false);
    expect(result.signals).toEqual([
      {
        kind: "new_task",
        title: "Implement TASKS auto-capture",
        details: "Add task detector and ledger writes",
        currentStep: "Create task-detector.ts",
      },
    ]);
  });

  it("detects task update and completion signals", async () => {
    callLlmMock.mockResolvedValue(
      JSON.stringify({
        signals: [
          {
            kind: "task_update",
            title: "Implement TASKS auto-capture",
            details: "Pipeline is wired and tests are next",
            currentStep: "Add detector coverage",
          },
          {
            kind: "task_complete",
            title: "Implement TASKS auto-capture",
            completedTaskId: "TASK-123",
          },
        ],
      }),
    );

    const result = await detectTaskSignals(
      "The task auto-capture pipeline is wired now, including TASKS.md updates. I’m finishing the tests next, and once they pass this work will be complete and ready to hand off.",
      extractionConfig,
    );

    expect(result.skipped).toBe(false);
    expect(result.signals).toHaveLength(2);
    expect(result.signals[0].kind).toBe("task_update");
    expect(result.signals[1]).toEqual({
      kind: "task_complete",
      title: "Implement TASKS auto-capture",
      details: undefined,
      currentStep: undefined,
      completedTaskId: "TASK-123",
    });
  });

  it("returns skipped for short or ack-only text", async () => {
    const result = await detectTaskSignals("On it.", extractionConfig);

    expect(result).toEqual({ signals: [], skipped: true });
    expect(callLlmMock).not.toHaveBeenCalled();
  });

  it("returns skipped for HEARTBEAT_OK", async () => {
    const result = await detectTaskSignals("HEARTBEAT_OK", extractionConfig);

    expect(result).toEqual({ signals: [], skipped: true });
    expect(callLlmMock).not.toHaveBeenCalled();
  });

  it("returns skipped for NO_REPLY", async () => {
    const result = await detectTaskSignals("NO_REPLY", extractionConfig);

    expect(result).toEqual({ signals: [], skipped: true });
    expect(callLlmMock).not.toHaveBeenCalled();
  });

  it("handles empty text", async () => {
    const result = await detectTaskSignals("", extractionConfig);

    expect(result).toEqual({ signals: [], skipped: true });
    expect(callLlmMock).not.toHaveBeenCalled();
  });

  it("returns empty signals when the LLM returns malformed output", async () => {
    callLlmMock.mockResolvedValue("not json");

    const result = await detectTaskSignals(
      "I’m going to inspect the task pipeline, change the ledger writer, and then report back with the final result after verification is done.",
      extractionConfig,
    );

    expect(result).toEqual({ signals: [], skipped: false });
  });
});
