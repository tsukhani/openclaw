import { describe, expect, it } from "vitest";
import { computeLatencyStats, computeLatencyStatsByAbility } from "./latency.js";

describe("computeLatencyStats", () => {
  it("returns zeros for empty input", () => {
    const result = computeLatencyStats([]);
    expect(result.count).toBe(0);
    expect(result.min).toBe(0);
    expect(result.max).toBe(0);
    expect(result.mean).toBe(0);
    expect(result.stddev).toBe(0);
    expect(result.p50).toBe(0);
    expect(result.p95).toBe(0);
    expect(result.p99).toBe(0);
  });

  it("handles single sample", () => {
    const result = computeLatencyStats([42.5]);
    expect(result.count).toBe(1);
    expect(result.min).toBe(42.5);
    expect(result.max).toBe(42.5);
    expect(result.mean).toBe(42.5);
    expect(result.stddev).toBe(0);
    expect(result.p50).toBe(42.5);
    expect(result.p95).toBe(42.5);
    expect(result.p99).toBe(42.5);
  });

  it("computes correct percentiles on 100 sequential samples", () => {
    const samples = Array.from({ length: 100 }, (_, i) => i + 1);
    const result = computeLatencyStats(samples);
    expect(result.count).toBe(100);
    expect(result.min).toBe(1);
    expect(result.max).toBe(100);
    expect(result.mean).toBeCloseTo(50.5);
    // p50 = sorted[floor(0.5 * 100)] = sorted[50] = 51
    expect(result.p50).toBe(51);
    // p95 = sorted[floor(0.95 * 100)] = sorted[95] = 96
    expect(result.p95).toBe(96);
    // p99 = sorted[floor(0.99 * 100)] = sorted[99] = 100
    expect(result.p99).toBe(100);
  });

  it("sorts unsorted input correctly", () => {
    const result = computeLatencyStats([50, 10, 30, 20, 40]);
    expect(result.min).toBe(10);
    expect(result.max).toBe(50);
    expect(result.mean).toBe(30);
  });

  it("computes population stddev correctly", () => {
    // samples: [2, 4, 4, 4, 5, 5, 7, 9] → mean=5, variance=4, stddev=2
    const result = computeLatencyStats([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(result.mean).toBe(5);
    expect(result.stddev).toBe(2);
  });
});

describe("computeLatencyStatsByAbility", () => {
  it("returns empty record for empty input", () => {
    const result = computeLatencyStatsByAbility([]);
    expect(Object.keys(result)).toHaveLength(0);
  });

  it("groups by ability and computes stats per group", () => {
    const cases = [
      { ability: "extraction", latencyMs: 10 },
      { ability: "extraction", latencyMs: 20 },
      { ability: "temporal", latencyMs: 50 },
    ];
    const result = computeLatencyStatsByAbility(cases);
    expect(result.extraction.count).toBe(2);
    expect(result.extraction.mean).toBe(15);
    expect(result.temporal.count).toBe(1);
    expect(result.temporal.mean).toBe(50);
  });

  it("single-case ability has min=max=mean and stddev=0", () => {
    const result = computeLatencyStatsByAbility([{ ability: "graph", latencyMs: 33.3 }]);
    expect(result.graph.min).toBe(33.3);
    expect(result.graph.max).toBe(33.3);
    expect(result.graph.mean).toBe(33.3);
    expect(result.graph.stddev).toBe(0);
    expect(result.graph.p50).toBe(33.3);
  });
});
