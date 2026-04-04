import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerBuiltinVerifiers, unregisterAllVerifiers } from "./register-verifiers.js";
import { getRegisteredVerifierTools, hasVerifier } from "./verification-hooks.js";

beforeEach(() => {
  unregisterAllVerifiers();
});

afterEach(() => {
  unregisterAllVerifiers();
  vi.unstubAllEnvs();
});

describe("registerBuiltinVerifiers", () => {
  it("registers verifiers for write, edit, exec, bash, message, and send_message tools", () => {
    registerBuiltinVerifiers();
    expect(hasVerifier("write")).toBe(true);
    expect(hasVerifier("edit")).toBe(true);
    expect(hasVerifier("notebook_edit")).toBe(true);
    expect(hasVerifier("exec")).toBe(true);
    expect(hasVerifier("bash")).toBe(true);
    expect(hasVerifier("message")).toBe(true);
    expect(hasVerifier("send_message")).toBe(true);
  });

  it("returns the expected set of tool names", () => {
    registerBuiltinVerifiers();
    const tools = getRegisteredVerifierTools().toSorted();
    expect(tools).toEqual([
      "bash",
      "edit",
      "exec",
      "message",
      "notebook_edit",
      "send_message",
      "write",
    ]);
  });

  it("is idempotent — calling twice does not double-register", () => {
    registerBuiltinVerifiers();
    registerBuiltinVerifiers();
    const tools = getRegisteredVerifierTools();
    expect(tools.length).toBe(7);
  });

  it("respects VERIFICATION_HOOKS_ENABLED=0", () => {
    vi.stubEnv("VERIFICATION_HOOKS_ENABLED", "0");
    registerBuiltinVerifiers();
    expect(getRegisteredVerifierTools().length).toBe(0);
  });
});

describe("unregisterAllVerifiers", () => {
  it("removes all registered verifiers", () => {
    registerBuiltinVerifiers();
    expect(getRegisteredVerifierTools().length).toBe(7);
    unregisterAllVerifiers();
    expect(getRegisteredVerifierTools().length).toBe(0);
  });

  it("allows re-registration after unregister", () => {
    registerBuiltinVerifiers();
    unregisterAllVerifiers();
    registerBuiltinVerifiers();
    expect(hasVerifier("exec")).toBe(true);
  });
});
