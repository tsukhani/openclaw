/**
 * Shared error classification utilities for memory-neo4j.
 *
 * Used by both neo4j-client.ts (per-signal catch blocks) and
 * plugin-tools.ts (tool-level graceful degradation).
 */

import neo4j from "neo4j-driver";

/**
 * Returns true when the error indicates a Neo4j connection / availability
 * problem (service down, connection refused, session expired, pool timeout).
 *
 * Connection errors are transient and should propagate so callers can surface
 * a user-facing message. Non-connection errors (e.g. index not ready, query
 * syntax) are caught at the signal level and return [] for graceful degradation.
 */
export function isNeo4jConnectionError(err: unknown): boolean {
  // Neo4j driver typed errors (ServiceUnavailable, SessionExpired)
  if (err instanceof neo4j.Neo4jError) {
    const code = (err as { code?: string }).code ?? "";
    return (
      code === "ServiceUnavailable" ||
      code === "SessionExpired" ||
      code.startsWith("Neo.TransientError.")
    );
  }
  // Node-level network errors (ECONNREFUSED, ECONNRESET, ETIMEDOUT, etc.)
  const msg = String(err);
  return (
    msg.includes("ECONNREFUSED") ||
    msg.includes("ECONNRESET") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("EPIPE") ||
    msg.includes("connect EHOSTUNREACH") ||
    msg.includes("Connection was closed") ||
    msg.includes("Pool is closed") ||
    msg.includes("connection acquisition timed out")
  );
}
