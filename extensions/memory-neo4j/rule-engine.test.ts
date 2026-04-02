import { describe, expect, it } from "vitest";
import { aggregateConfidence, computeChainConfidence } from "./rule-engine.js";

describe("aggregateConfidence", () => {
  it("min: returns minimum confidence", () => {
    expect(aggregateConfidence([0.9, 0.7, 0.85], "min")).toBe(0.7);
  });

  it("product: returns product of confidences", () => {
    expect(aggregateConfidence([0.9, 0.7], "product")).toBeCloseTo(0.63, 5);
  });

  it("mean: returns average of confidences", () => {
    expect(aggregateConfidence([0.9, 0.7], "mean")).toBeCloseTo(0.8, 5);
  });

  it("returns 1.0 for empty array", () => {
    expect(aggregateConfidence([], "min")).toBe(1.0);
    expect(aggregateConfidence([], "product")).toBe(1.0);
    expect(aggregateConfidence([], "mean")).toBe(1.0);
  });

  it("handles single confidence value", () => {
    expect(aggregateConfidence([0.5], "min")).toBe(0.5);
    expect(aggregateConfidence([0.5], "product")).toBe(0.5);
    expect(aggregateConfidence([0.5], "mean")).toBe(0.5);
  });

  it("defaults to min for unknown formula", () => {
    expect(aggregateConfidence([0.9, 0.7], "unknown" as "min")).toBe(0.7);
  });
});

describe("computeChainConfidence", () => {
  it("applies rule confidence and depth decay", () => {
    const result = computeChainConfidence(
      0.8, // rule confidence
      [0.9, 0.7], // edge confidences
      "min", // formula
      1, // depth
      0.9, // decay
    );
    // 0.8 * min(0.9, 0.7) * 0.9^1 = 0.8 * 0.7 * 0.9 = 0.504
    expect(result).toBeCloseTo(0.504, 5);
  });

  it("depth 0 has no decay", () => {
    const result = computeChainConfidence(1.0, [0.8], "min", 0, 0.9);
    // 1.0 * 0.8 * 0.9^0 = 0.8
    expect(result).toBeCloseTo(0.8, 5);
  });

  it("deeper chains produce lower confidence", () => {
    const shallow = computeChainConfidence(1.0, [0.9], "min", 1, 0.9);
    const deep = computeChainConfidence(1.0, [0.9], "min", 3, 0.9);
    expect(deep).toBeLessThan(shallow);
  });

  it("product formula multiplies edge confidences", () => {
    const result = computeChainConfidence(1.0, [0.9, 0.8, 0.7], "product", 0, 0.9);
    // 1.0 * (0.9 * 0.8 * 0.7) * 0.9^0 = 0.504
    expect(result).toBeCloseTo(0.504, 5);
  });

  it("mean formula averages edge confidences", () => {
    const result = computeChainConfidence(1.0, [0.6, 0.8], "mean", 0, 0.9);
    // 1.0 * mean(0.6, 0.8) * 1.0 = 0.7
    expect(result).toBeCloseTo(0.7, 5);
  });

  it("confidence floor scenario: deep chain with low edges", () => {
    const result = computeChainConfidence(0.6, [0.5, 0.4], "product", 3, 0.9);
    // 0.6 * (0.5 * 0.4) * 0.9^3 = 0.6 * 0.2 * 0.729 = 0.08748
    expect(result).toBeCloseTo(0.08748, 4);
    expect(result).toBeLessThan(0.3); // below default confidence floor
  });
});
