/**
 * Tests for rule validation gate (Cypher syntax, contradiction detection).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { validateRule } from "./rule-validator.js";

function mockRecord(fields: Record<string, unknown>) {
  return { get: (key: string) => fields[key] };
}

function createMockSession(
  options: {
    explainFails?: boolean;
    activeRules?: Array<{ id: string; name: string; antecedent: string; consequent: string }>;
  } = {},
) {
  const run = vi.fn(async (query: string) => {
    // EXPLAIN queries for syntax validation
    if (query.startsWith("EXPLAIN")) {
      if (options.explainFails) {
        throw new Error("SyntaxError: Invalid Cypher pattern");
      }
      return { records: [] };
    }
    // Active rules query
    if (query.includes("Rule") && query.includes("active: true")) {
      return {
        records: (options.activeRules ?? []).map((r) => mockRecord({ r: { properties: r } })),
      };
    }
    return { records: [] };
  });

  return {
    run,
    executeRead: vi.fn(async (fn: (tx: { run: typeof run }) => Promise<unknown>) => fn({ run })),
    executeWrite: vi.fn(async (fn: (tx: { run: typeof run }) => Promise<unknown>) => fn({ run })),
    close: vi.fn(),
  };
}

function createMockLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

describe("validateRule", () => {
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    logger = createMockLogger();
  });

  it("accepts a rule with valid Cypher and no contradictions", async () => {
    const session = createMockSession({ activeRules: [] });
    const result = await validateRule(
      session as any,
      {
        name: "co_location",
        antecedent: "(x:Entity)-[:WORKS_AT]->(y:Entity)-[:LOCATED_IN]->(z:Entity)",
        consequent: "(x)-[:LOCATED_IN {inferred: true}]->(z)",
      },
      "agent-1",
      logger,
    );

    expect(result.valid).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("rejects a rule with invalid antecedent Cypher", async () => {
    const session = createMockSession({ explainFails: true });

    const result = await validateRule(
      session as any,
      {
        name: "bad_rule",
        antecedent: "INVALID CYPHER !!!",
        consequent: "(x)-[:FOO]->(y)",
      },
      "agent-1",
      logger,
    );

    expect(result.valid).toBe(false);
    expect(result.reason).toContain("Invalid antecedent Cypher pattern");
  });

  it("rejects a rule that contradicts an existing active rule", async () => {
    const session = createMockSession({
      activeRules: [
        {
          id: "existing-1",
          name: "existing_rule",
          antecedent: "(x:Entity)-[:WORKS_AT]->(y:Entity)",
          consequent: "(x)-[:LOCATED_IN {inferred: true}]->(y)",
        },
      ],
    });

    const result = await validateRule(
      session as any,
      {
        name: "contradicting_rule",
        antecedent: "(x:Entity)-[:WORKS_AT]->(y:Entity)",
        consequent: "(x)-[:NOT_LOCATED_IN {inferred: true}]->(y)",
      },
      "agent-1",
      logger,
    );

    expect(result.valid).toBe(false);
    expect(result.reason).toContain("Contradicts existing rule");
    expect(result.reason).toContain("existing_rule");
  });

  it("accepts a rule with the same antecedent but identical consequent (not a contradiction)", async () => {
    const session = createMockSession({
      activeRules: [
        {
          id: "existing-1",
          name: "existing_rule",
          antecedent: "(x:Entity)-[:WORKS_AT]->(y:Entity)",
          consequent: "(x)-[:LOCATED_IN {inferred: true}]->(y)",
        },
      ],
    });

    const result = await validateRule(
      session as any,
      {
        name: "duplicate_rule",
        antecedent: "(x:Entity)-[:WORKS_AT]->(y:Entity)",
        consequent: "(x)-[:LOCATED_IN {inferred: true}]->(y)",
      },
      "agent-1",
      logger,
    );

    expect(result.valid).toBe(true);
  });

  it("accepts a rule with different antecedent from existing rules", async () => {
    const session = createMockSession({
      activeRules: [
        {
          id: "existing-1",
          name: "existing_rule",
          antecedent: "(x:Entity)-[:WORKS_AT]->(y:Entity)",
          consequent: "(x)-[:LOCATED_IN]->(y)",
        },
      ],
    });

    const result = await validateRule(
      session as any,
      {
        name: "different_rule",
        antecedent: "(x:Entity)-[:LIVES_AT]->(y:Entity)",
        consequent: "(x)-[:LOCATED_IN]->(y)",
      },
      "agent-1",
      logger,
    );

    expect(result.valid).toBe(true);
  });

  it("handles empty active rules list", async () => {
    const session = createMockSession({ activeRules: [] });

    const result = await validateRule(
      session as any,
      {
        name: "first_rule",
        antecedent: "(x:Entity)-[:KNOWS]->(y:Entity)",
        consequent: "(x)-[:FRIEND {inferred: true}]->(y)",
      },
      "agent-1",
      logger,
    );

    expect(result.valid).toBe(true);
  });
});
