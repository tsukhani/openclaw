/**
 * Shared error classification utilities for memory-neo4j.
 *
 * Used by both neo4j-client.ts (per-signal catch blocks) and
 * plugin-tools.ts (tool-level graceful degradation).
 */

import neo4j from "neo4j-driver";

/** Neo4j driver error codes that indicate connection/availability problems. */
const NEO4J_CONNECTION_CODES = new Set(["ServiceUnavailable", "SessionExpired"]);

/** OS-level network error codes (Node.js SystemError.code values). */
const OS_NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "EHOSTUNREACH",
  "ENOTFOUND",
  "ECONNABORTED",
]);

/**
 * String-based fallback patterns for errors that lack structured code properties.
 * Used as a last resort when neither Neo4j error codes nor OS errno are available.
 */
const FALLBACK_PATTERNS = [
  "connection was closed",
  "pool is closed",
  "connection acquisition timed out",
];

/**
 * Returns true when the error indicates a Neo4j connection / availability
 * problem (service down, connection refused, session expired, pool timeout).
 *
 * Uses a two-tier classification:
 * 1. Structured check (preferred): error.code for Neo4j driver codes and OS errno
 * 2. String fallback (last resort): message matching for connection pool errors
 *
 * Connection errors are transient and should propagate so callers can surface
 * a user-facing message. Non-connection errors (e.g. index not ready, query
 * syntax) are caught at the signal level and return [] for graceful degradation.
 */
export function isNeo4jConnectionError(err: unknown): boolean {
  // Tier 1a: Neo4j driver typed errors — check .code property
  if (err instanceof neo4j.Neo4jError) {
    const code = (err as { code?: string }).code ?? "";
    if (NEO4J_CONNECTION_CODES.has(code) || code.startsWith("Neo.TransientError.")) {
      return true;
    }
    // Don't return false yet — fall through to string fallback for Neo4jError
    // instances with non-standard codes (e.g. connection pool acquisition timeout
    // which is a Neo4jError but has no matching structured code).
  }

  // Tier 1b: OS-level network errors — check .code or .errno properties
  if (err != null && typeof err === "object") {
    const errObj = err as { code?: string; errno?: string };
    if (errObj.code && OS_NETWORK_CODES.has(errObj.code)) {
      return true;
    }
    if (errObj.errno && OS_NETWORK_CODES.has(errObj.errno)) {
      return true;
    }
  }

  // Tier 2: String fallback — case-insensitive match for errors that lack
  // structured code properties or whose code didn't match above.
  const msg = String(err).toLowerCase();
  return FALLBACK_PATTERNS.some((pattern) => msg.includes(pattern));
}
