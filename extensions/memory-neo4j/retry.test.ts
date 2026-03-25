import { describe, expect, it, vi } from "vitest";
import { isTransientNeo4jError, retryWithBackoff } from "./retry.js";

describe("retryWithBackoff", () => {
  it("returns result on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await retryWithBackoff(fn, { maxAttempts: 3, baseDelayMs: 1 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on retryable error and succeeds", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error("transient")).mockResolvedValue("ok");
    const result = await retryWithBackoff(fn, {
      maxAttempts: 3,
      baseDelayMs: 1,
      isRetryable: () => true,
    });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("throws immediately on non-retryable error", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("permanent"));
    await expect(
      retryWithBackoff(fn, {
        maxAttempts: 3,
        baseDelayMs: 1,
        isRetryable: () => false,
      }),
    ).rejects.toThrow("permanent");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("throws last error after all attempts exhausted", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("always fails"));
    await expect(
      retryWithBackoff(fn, {
        maxAttempts: 3,
        baseDelayMs: 1,
        isRetryable: () => true,
      }),
    ).rejects.toThrow("always fails");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("calls onRetry callback before each retry", async () => {
    const onRetry = vi.fn();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail1"))
      .mockRejectedValueOnce(new Error("fail2"))
      .mockResolvedValue("ok");
    await retryWithBackoff(fn, {
      maxAttempts: 3,
      baseDelayMs: 1,
      isRetryable: () => true,
      onRetry,
    });
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith(expect.any(Error), 0, expect.any(Number));
    expect(onRetry).toHaveBeenCalledWith(expect.any(Error), 1, expect.any(Number));
  });

  it("throws AbortError when abort signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const fn = vi.fn().mockRejectedValue(new Error("fail"));
    await expect(
      retryWithBackoff(fn, {
        maxAttempts: 3,
        baseDelayMs: 1,
        isRetryable: () => true,
        abortSignal: controller.signal,
      }),
    ).rejects.toThrow("Aborted");
  });

  it("retries all attempts by default when no isRetryable provided", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error("any error")).mockResolvedValue("ok");
    const result = await retryWithBackoff(fn, { maxAttempts: 3, baseDelayMs: 1 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("uses exponential backoff when backoffExponent is set", async () => {
    const onRetry = vi.fn();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail1"))
      .mockRejectedValueOnce(new Error("fail2"))
      .mockResolvedValue("ok");
    // Seed Math.random to get deterministic jitter for delay assertions
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);
    await retryWithBackoff(fn, {
      maxAttempts: 3,
      baseDelayMs: 100,
      backoffExponent: 3,
      isRetryable: () => true,
      onRetry,
    });
    // attempt 0: 100 * 3^0 * (0.5 + 0.5*0.5) = 100 * 1 * 0.75 = 75
    // attempt 1: 100 * 3^1 * 0.75 = 225
    expect(onRetry).toHaveBeenCalledWith(expect.any(Error), 0, 75);
    expect(onRetry).toHaveBeenCalledWith(expect.any(Error), 1, 225);
    randomSpy.mockRestore();
  });
});

describe("isTransientNeo4jError", () => {
  it("returns true for DeadlockDetected", () => {
    expect(isTransientNeo4jError(new Error("Neo.TransientError.DeadlockDetected"))).toBe(true);
  });

  it("returns true for ServiceUnavailable", () => {
    expect(isTransientNeo4jError(new Error("ServiceUnavailable"))).toBe(true);
  });

  it("returns true for SessionExpired", () => {
    expect(isTransientNeo4jError(new Error("SessionExpired"))).toBe(true);
  });

  it("returns true for ConnectionRefused", () => {
    expect(isTransientNeo4jError(new Error("ConnectionRefused"))).toBe(true);
  });

  it("returns false for non-Error", () => {
    expect(isTransientNeo4jError("string error")).toBe(false);
  });

  it("returns false for unrelated errors", () => {
    expect(isTransientNeo4jError(new Error("syntax error in query"))).toBe(false);
  });
});
