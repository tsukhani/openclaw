/**
 * Built-in verifier registration for the unified event log.
 *
 * Registers write/edit, exec, and message verifiers on first call.
 * Guarded by the VERIFICATION_HOOKS_ENABLED env var (default: enabled).
 */
import {
  createExecVerifier,
  createMessageVerifier,
  createWriteVerifier,
} from "./builtin-verifiers.js";
import { clearVerifiersForTests, registerToolVerifier } from "./verification-hooks.js";

/** Tool names that map to the write/edit verifier. */
const WRITE_TOOLS = ["write", "edit", "notebook_edit"] as const;

/** Tool names that map to the exec verifier. */
const EXEC_TOOLS = ["exec", "bash"] as const;

/** Tool names that map to the message verifier. */
const MESSAGE_TOOLS = ["message", "send_message"] as const;

const unsubscribers: Array<() => void> = [];
let registered = false;

function isEnabled(): boolean {
  return process.env.VERIFICATION_HOOKS_ENABLED !== "0";
}

/**
 * Register all built-in verifiers. Safe to call multiple times;
 * subsequent calls are no-ops while verifiers are already active.
 */
export function registerBuiltinVerifiers(): void {
  if (registered) {
    return;
  }
  if (!isEnabled()) {
    return;
  }

  const writeVerifier = createWriteVerifier();
  for (const tool of WRITE_TOOLS) {
    unsubscribers.push(registerToolVerifier(tool, writeVerifier));
  }

  const execVerifier = createExecVerifier();
  for (const tool of EXEC_TOOLS) {
    unsubscribers.push(registerToolVerifier(tool, execVerifier));
  }

  const messageVerifier = createMessageVerifier();
  for (const tool of MESSAGE_TOOLS) {
    unsubscribers.push(registerToolVerifier(tool, messageVerifier));
  }

  registered = true;
}

/**
 * Unregister all built-in verifiers (for tests).
 */
export function unregisterAllVerifiers(): void {
  for (const unsub of unsubscribers) {
    unsub();
  }
  unsubscribers.length = 0;
  registered = false;
  clearVerifiersForTests();
}
