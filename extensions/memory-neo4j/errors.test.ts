import neo4j from "neo4j-driver";
import { describe, it, expect } from "vitest";
import { isNeo4jConnectionError } from "./errors.js";

describe("isNeo4jConnectionError", () => {
  // Tier 1a: Neo4j driver errors with code property
  describe("Neo4j driver errors (Tier 1a)", () => {
    it("detects ServiceUnavailable via code", () => {
      const err = new neo4j.Neo4jError("msg", "ServiceUnavailable", "", "");
      expect(isNeo4jConnectionError(err)).toBe(true);
    });

    it("detects SessionExpired via code", () => {
      const err = new neo4j.Neo4jError("msg", "SessionExpired", "", "");
      expect(isNeo4jConnectionError(err)).toBe(true);
    });

    it("detects Neo.TransientError.* prefix", () => {
      const err = new neo4j.Neo4jError(
        "msg",
        "Neo.TransientError.Network.CommunicationError",
        "",
        "",
      );
      expect(isNeo4jConnectionError(err)).toBe(true);
    });

    it("rejects Neo4j client errors (SyntaxError)", () => {
      const err = new neo4j.Neo4jError(
        "bad query",
        "Neo.ClientError.Statement.SyntaxError",
        "",
        "",
      );
      expect(isNeo4jConnectionError(err)).toBe(false);
    });

    it("rejects Neo4j constraint errors", () => {
      const err = new neo4j.Neo4jError(
        "constraint violation",
        "Neo.ClientError.Schema.ConstraintValidationFailed",
        "",
        "",
      );
      expect(isNeo4jConnectionError(err)).toBe(false);
    });
  });

  // Tier 1b: OS-level errors with code/errno
  describe("OS-level network errors (Tier 1b)", () => {
    it("detects ECONNREFUSED via error.code", () => {
      const err = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
      expect(isNeo4jConnectionError(err)).toBe(true);
    });

    it("detects ECONNRESET via error.code", () => {
      const err = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
      expect(isNeo4jConnectionError(err)).toBe(true);
    });

    it("detects ETIMEDOUT via error.code", () => {
      const err = Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
      expect(isNeo4jConnectionError(err)).toBe(true);
    });

    it("detects EPIPE via error.errno", () => {
      const err = Object.assign(new Error("broken pipe"), { errno: "EPIPE" });
      expect(isNeo4jConnectionError(err)).toBe(true);
    });

    it("detects EHOSTUNREACH via error.code", () => {
      const err = Object.assign(new Error("no route"), { code: "EHOSTUNREACH" });
      expect(isNeo4jConnectionError(err)).toBe(true);
    });
  });

  // Tier 2: String fallback
  describe("string fallback (Tier 2)", () => {
    it("detects 'connection acquisition timed out' via message", () => {
      const err = new Error("connection acquisition timed out after 30000ms");
      expect(isNeo4jConnectionError(err)).toBe(true);
    });

    it("detects 'Pool is closed' via message", () => {
      const err = new Error("Pool is closed, it is no longer valid to acquire");
      expect(isNeo4jConnectionError(err)).toBe(true);
    });

    it("detects 'Connection was closed' via message", () => {
      const err = new Error("Connection was closed by server");
      expect(isNeo4jConnectionError(err)).toBe(true);
    });

    it("detects Neo4jError with pool acquisition timeout (uppercase 'Connection')", () => {
      // Real driver error: Neo4jError with non-standard code but connection-related message.
      // Must fall through from Tier 1a to string fallback.
      const err = new neo4j.Neo4jError(
        "Connection acquisition timed out in 60000 ms. Pool status: Active conn count = 0, Idle conn count = 0.",
        "N/A",
        "",
        "",
      );
      expect(isNeo4jConnectionError(err)).toBe(true);
    });
  });

  // Rejection
  describe("non-connection errors", () => {
    it("rejects plain Error with no connection indicators", () => {
      expect(isNeo4jConnectionError(new Error("something went wrong"))).toBe(false);
    });

    it("rejects non-Error values", () => {
      expect(isNeo4jConnectionError("string error")).toBe(false);
      expect(isNeo4jConnectionError(42)).toBe(false);
      expect(isNeo4jConnectionError(null)).toBe(false);
    });
  });
});
