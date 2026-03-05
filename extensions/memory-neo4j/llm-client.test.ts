/**
 * Tests for abortableDelay in llm-client.ts (CR-003).
 */

import { describe, it, expect } from "vitest";
import { abortableDelay } from "./llm-client.js";

describe("abortableDelay", () => {
  it("resolves after the given delay when no signal is provided", async () => {
    const start = Date.now();
    await abortableDelay(20);
    expect(Date.now() - start).toBeGreaterThanOrEqual(10);
  });

  it("rejects immediately when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("pre-aborted"));
    await expect(abortableDelay(5000, controller.signal)).rejects.toThrow("pre-aborted");
  });

  it("rejects early when signal fires during wait", async () => {
    const controller = new AbortController();
    const start = Date.now();

    // Abort after a short delay — well before the 5-second timeout
    setTimeout(() => controller.abort(new Error("mid-wait abort")), 20);

    await expect(abortableDelay(5000, controller.signal)).rejects.toThrow("mid-wait abort");
    // Should complete much faster than the full 5000ms
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("resolves normally when signal is provided but never aborted", async () => {
    const controller = new AbortController();
    await expect(abortableDelay(20, controller.signal)).resolves.toBeUndefined();
  });
});
