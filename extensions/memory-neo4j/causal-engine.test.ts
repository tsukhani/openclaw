import { describe, expect, it } from "vitest";
import type { CausalLevel, InterventionSpec } from "./causal-engine.js";

describe("CausalEngine types", () => {
  it("CausalLevel accepts all three Pearl levels", () => {
    const levels: CausalLevel[] = ["association", "intervention", "counterfactual"];
    expect(levels).toHaveLength(3);
  });

  it("InterventionSpec has variable and value", () => {
    const spec: InterventionSpec = { variable: "team_size", value: "increased_by_2" };
    expect(spec.variable).toBe("team_size");
    expect(spec.value).toBe("increased_by_2");
  });
});

describe("CausalQueryResult structure", () => {
  it("includes assumptions array", () => {
    const result = {
      answer: "Test answer",
      level: "intervention" as CausalLevel,
      confidence: 0.7,
      causalPath: ["A", "B", "C"],
      assumptions: ["No unobserved confounders", "Linear relationship assumed"],
    };
    expect(result.assumptions).toHaveLength(2);
    expect(result.causalPath).toHaveLength(3);
    expect(result.confidence).toBeGreaterThan(0);
  });
});
