import { describe, it, expect } from "vitest";
import { isUnsafeRegex } from "./neo4j-client-memory.js";

describe("isUnsafeRegex", () => {
  it("rejects nested quantifiers: (a+)+$", () => {
    const result = isUnsafeRegex("(a+)+$");
    expect(result).toContain("nested quantifiers");
  });

  it("rejects nested quantifiers: (.*a{1,})*", () => {
    const result = isUnsafeRegex("(.*a{1,})*");
    expect(result).toContain("nested quantifiers");
  });

  it("rejects nested quantifiers: (x+|y+)+", () => {
    const result = isUnsafeRegex("(x+|y+)+");
    expect(result).toContain("nested quantifiers");
  });

  it("rejects excessive alternation (>10 pipes)", () => {
    const pattern = "a|b|c|d|e|f|g|h|i|j|k|l";
    const result = isUnsafeRegex(pattern);
    expect(result).toContain("alternation branches");
  });

  it("accepts simple valid patterns", () => {
    expect(isUnsafeRegex("old project.*2024")).toBeNull();
    expect(isUnsafeRegex("foo|bar|baz")).toBeNull();
    expect(isUnsafeRegex("test\\d+")).toBeNull();
    expect(isUnsafeRegex("(?i)hello world")).toBeNull();
  });

  it("accepts patterns with non-nested quantifiers in groups", () => {
    // Group without inner quantifier, outer quantifier is fine
    expect(isUnsafeRegex("(abc)+")).toBeNull();
    expect(isUnsafeRegex("(a|b)*")).toBeNull();
  });

  it("accepts up to 10 pipes but rejects 11+", () => {
    // 10 pipes exactly — boundary, should be safe
    const tenPipes = "a|b|c|d|e|f|g|h|i|j|k"; // 10 pipes
    expect(isUnsafeRegex(tenPipes)).toBeNull();
    // 11 pipes — over the limit
    const elevenPipes = "a|b|c|d|e|f|g|h|i|j|k|l"; // 11 pipes
    expect(isUnsafeRegex(elevenPipes)).toContain("alternation");
  });
});
