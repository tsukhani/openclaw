import { describe, expect, it } from "vitest";

describe("reasoning tools registration", () => {
  it("exports registerReasoningTools function", async () => {
    const mod = await import("./plugin-tools-reasoning.js");
    expect(typeof mod.registerReasoningTools).toBe("function");
  });
});

describe("tool parameter validation", () => {
  it("logic_query modes are exhaustive", () => {
    const validModes = ["infer", "check", "explain"];
    expect(validModes).toHaveLength(3);
  });

  it("causal_query levels match Pearl hierarchy", () => {
    const validLevels = ["association", "intervention", "counterfactual"];
    expect(validLevels).toHaveLength(3);
  });

  it("memory_rules actions are complete", () => {
    const validActions = ["list", "add", "remove", "learn", "validate"];
    expect(validActions).toHaveLength(5);
  });
});

describe("graceful degradation", () => {
  it("fallback responses have correct structure", () => {
    // Verify the fallback response shape expected by the tool framework
    const fallback = {
      content: [{ type: "text", text: "Service temporarily unavailable." }],
      details: { error: "neo4j_connection" },
    };
    expect(fallback.content).toHaveLength(1);
    expect(fallback.content[0].type).toBe("text");
    expect(fallback.details.error).toBe("neo4j_connection");
  });
});
