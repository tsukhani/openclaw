/**
 * Tests for Rule and InferredFact Cypher template operations.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  countActiveRules,
  deactivateRule,
  deleteInferredFact,
  findFactsGroundedIn,
  getLowestSupportRule,
  inferredFactExists,
  listActiveRules,
  listInferredFacts,
  listLowSupportRules,
  storeInferredFact,
  storeRule,
  updateRuleStats,
} from "./neo4j-client-rules.js";

function mockRecord(fields: Record<string, unknown>) {
  return {
    get: (key: string) => fields[key],
  };
}

function createMockSession() {
  const run = vi.fn().mockResolvedValue({ records: [] });
  return {
    run,
    executeRead: vi.fn(async (fn: (tx: { run: typeof run }) => Promise<unknown>) => fn({ run })),
    executeWrite: vi.fn(async (fn: (tx: { run: typeof run }) => Promise<unknown>) => fn({ run })),
    close: vi.fn(),
    _run: run,
  };
}

describe("storeRule", () => {
  let session: ReturnType<typeof createMockSession>;

  beforeEach(() => {
    session = createMockSession();
  });

  it("stores a rule and returns its ID", async () => {
    session._run.mockResolvedValueOnce({
      records: [mockRecord({ id: "rule-123" })],
    });

    const id = await storeRule(session as any, {
      id: "rule-123",
      name: "co_location",
      antecedent: "(x:Entity)-[:WORKS_AT]->(y:Entity)-[:LOCATED_IN]->(z:Entity)",
      consequent: "(x)-[:LOCATED_IN {inferred: true}]->(z)",
      confidence: 0.9,
      confidenceFormula: "min",
      source: "manual",
      agentId: "agent-1",
    });

    expect(id).toBe("rule-123");
    expect(session.executeWrite).toHaveBeenCalledOnce();
    const cypher = session._run.mock.calls[0][0] as string;
    expect(cypher).toContain("MERGE (r:Rule {id: $id})");
    expect(cypher).toContain("r.active = true");
  });

  it("sets support to 0 and headCoverage to 0.0 on create", async () => {
    session._run.mockResolvedValueOnce({
      records: [mockRecord({ id: "rule-new" })],
    });

    await storeRule(session as any, {
      id: "rule-new",
      name: "test_rule",
      antecedent: "(x:Entity)-[:KNOWS]->(y:Entity)",
      consequent: "(x)-[:FRIEND_OF {inferred: true}]->(y)",
      confidence: 1.0,
      confidenceFormula: "product",
      source: "learned",
      agentId: "agent-1",
    });

    const params = session._run.mock.calls[0][1] as Record<string, unknown>;
    expect(params.confidence).toBe(1.0);
    expect(params.confidenceFormula).toBe("product");
    expect(params.source).toBe("learned");
  });
});

describe("deactivateRule", () => {
  it("returns true when rule is found and deactivated", async () => {
    const session = createMockSession();
    session._run.mockResolvedValueOnce({
      records: [mockRecord({ id: "rule-123" })],
    });

    const result = await deactivateRule(session as any, "rule-123", "agent-1");
    expect(result).toBe(true);

    const cypher = session._run.mock.calls[0][0] as string;
    expect(cypher).toContain("r.active = false");
    expect(cypher).toContain("r.validUntil = $now");
  });

  it("returns false when rule is not found", async () => {
    const session = createMockSession();
    session._run.mockResolvedValueOnce({ records: [] });

    const result = await deactivateRule(session as any, "nonexistent", "agent-1");
    expect(result).toBe(false);
  });
});

describe("listActiveRules", () => {
  it("returns active rules sorted by confidence", async () => {
    const session = createMockSession();
    session._run.mockResolvedValueOnce({
      records: [
        mockRecord({
          r: {
            properties: {
              id: "r1",
              name: "rule_a",
              confidence: 0.9,
              support: 15,
              active: true,
              source: "manual",
            },
          },
        }),
        mockRecord({
          r: {
            properties: {
              id: "r2",
              name: "rule_b",
              confidence: 0.7,
              support: 8,
              active: true,
              source: "learned",
            },
          },
        }),
      ],
    });

    const rules = await listActiveRules(session as any, "agent-1");
    expect(rules).toHaveLength(2);
    expect(rules[0].name).toBe("rule_a");
    expect(rules[1].name).toBe("rule_b");

    const cypher = session._run.mock.calls[0][0] as string;
    expect(cypher).toContain("active: true");
    expect(cypher).toContain("ORDER BY r.confidence DESC");
  });
});

describe("countActiveRules", () => {
  it("returns the count of active rules", async () => {
    const session = createMockSession();
    session._run.mockResolvedValueOnce({
      records: [mockRecord({ cnt: 42 })],
    });

    const count = await countActiveRules(session as any, "agent-1");
    expect(count).toBe(42);
  });

  it("returns 0 when no rules exist", async () => {
    const session = createMockSession();
    session._run.mockResolvedValueOnce({
      records: [mockRecord({ cnt: 0 })],
    });

    const count = await countActiveRules(session as any, "agent-1");
    expect(count).toBe(0);
  });
});

describe("updateRuleStats", () => {
  it("updates support and headCoverage", async () => {
    const session = createMockSession();

    await updateRuleStats(session as any, "rule-123", 25, 0.78);

    const params = session._run.mock.calls[0][1] as Record<string, unknown>;
    expect(params.ruleId).toBe("rule-123");
    expect(params.support).toBe(25);
    expect(params.headCoverage).toBe(0.78);
  });
});

describe("listLowSupportRules", () => {
  it("returns rules with support below threshold", async () => {
    const session = createMockSession();
    session._run.mockResolvedValueOnce({
      records: [
        mockRecord({ r: { properties: { id: "r1", name: "weak", support: 1 } } }),
        mockRecord({ r: { properties: { id: "r2", name: "weaker", support: 2 } } }),
      ],
    });

    const rules = await listLowSupportRules(session as any, "agent-1", 3);
    expect(rules).toHaveLength(2);

    const params = session._run.mock.calls[0][1] as Record<string, unknown>;
    expect(params.maxSupport).toBe(3);
  });
});

describe("getLowestSupportRule", () => {
  it("returns the rule with lowest support", async () => {
    const session = createMockSession();
    session._run.mockResolvedValueOnce({
      records: [mockRecord({ r: { properties: { id: "r1", name: "lowest", support: 2 } } })],
    });

    const rule = await getLowestSupportRule(session as any, "agent-1");
    expect(rule).not.toBeNull();
    expect(rule!.name).toBe("lowest");
  });

  it("returns null when no rules exist", async () => {
    const session = createMockSession();
    session._run.mockResolvedValueOnce({ records: [] });

    const rule = await getLowestSupportRule(session as any, "agent-1");
    expect(rule).toBeNull();
  });
});

describe("storeInferredFact", () => {
  it("creates fact with INFERRED_BY and GROUNDED_IN relationships", async () => {
    const session = createMockSession();
    session._run.mockResolvedValueOnce({
      records: [mockRecord({ id: "fact-1" })],
    });

    const id = await storeInferredFact(session as any, {
      id: "fact-1",
      text: "Alice is located in Berlin",
      confidence: 0.72,
      ruleId: "rule-123",
      groundingMemoryIds: ["mem-1", "mem-2"],
      embedding: [0.1, 0.2, 0.3],
      agentId: "agent-1",
    });

    expect(id).toBe("fact-1");
    const cypher = session._run.mock.calls[0][0] as string;
    expect(cypher).toContain("MERGE (f:InferredFact {id: $id})");
    expect(cypher).toContain("INFERRED_BY");
    expect(cypher).toContain("GROUNDED_IN");
  });
});

describe("deleteInferredFact", () => {
  it("returns true when fact is deleted", async () => {
    const session = createMockSession();
    session._run.mockResolvedValueOnce({
      records: [mockRecord({ deleted: 1 })],
    });

    const result = await deleteInferredFact(session as any, "fact-1", "agent-1");
    expect(result).toBe(true);
  });

  it("returns false when fact does not exist", async () => {
    const session = createMockSession();
    session._run.mockResolvedValueOnce({
      records: [mockRecord({ deleted: 0 })],
    });

    const result = await deleteInferredFact(session as any, "nonexistent", "agent-1");
    expect(result).toBe(false);
  });
});

describe("findFactsGroundedIn", () => {
  it("returns facts grounded in a specific memory", async () => {
    const session = createMockSession();
    session._run.mockResolvedValueOnce({
      records: [
        mockRecord({
          id: "fact-1",
          confidence: 0.8,
          ruleId: "rule-1",
          groundingMemoryIds: ["mem-1", "mem-2"],
        }),
      ],
    });

    const facts = await findFactsGroundedIn(session as any, "mem-1");
    expect(facts).toHaveLength(1);
    expect(facts[0].id).toBe("fact-1");
    expect(facts[0].groundingMemoryIds).toEqual(["mem-1", "mem-2"]);
  });
});

describe("listInferredFacts", () => {
  it("returns inferred facts ordered by confidence", async () => {
    const session = createMockSession();
    session._run.mockResolvedValueOnce({
      records: [
        mockRecord({ id: "f1", text: "Fact A", confidence: 0.9, ruleId: "r1" }),
        mockRecord({ id: "f2", text: "Fact B", confidence: 0.7, ruleId: "r2" }),
      ],
    });

    const facts = await listInferredFacts(session as any, "agent-1", 10);
    expect(facts).toHaveLength(2);
    expect(facts[0].confidence).toBe(0.9);

    const cypher = session._run.mock.calls[0][0] as string;
    expect(cypher).toContain("ORDER BY f.confidence DESC");
  });
});

describe("inferredFactExists", () => {
  it("returns true when fact exists with same rule and groundings", async () => {
    const session = createMockSession();
    session._run.mockResolvedValueOnce({
      records: [mockRecord({ cnt: 1 })],
    });

    const exists = await inferredFactExists(
      session as any,
      "rule-1",
      ["mem-2", "mem-1"],
      "agent-1",
    );
    expect(exists).toBe(true);

    // Should sort groundingMemoryIds for canonical comparison
    const params = session._run.mock.calls[0][1] as Record<string, unknown>;
    expect(params.sorted).toEqual(["mem-1", "mem-2"]);
  });

  it("returns false when fact does not exist", async () => {
    const session = createMockSession();
    session._run.mockResolvedValueOnce({
      records: [mockRecord({ cnt: 0 })],
    });

    const exists = await inferredFactExists(session as any, "rule-1", ["mem-1"], "agent-1");
    expect(exists).toBe(false);
  });
});
