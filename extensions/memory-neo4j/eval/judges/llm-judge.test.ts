import { describe, expect, it } from "vitest";
import { extractJson, normalizeCorrectness, normalizeVerdict } from "./llm-judge.js";

describe("context verdict fallback parsing", () => {
  // The fallback logic in parseContextVerdict checks PARTIAL before COMPLETE
  // so "PARTIALLY COMPLETE" correctly maps to PARTIAL.
  // We test normalizeVerdict here (exact match) and extractJson for JSON parsing.

  it("detects COMPLETE via normalizeVerdict", () => {
    expect(normalizeVerdict("COMPLETE")).toBe("COMPLETE");
  });

  it("detects PARTIAL via normalizeVerdict", () => {
    expect(normalizeVerdict("PARTIAL")).toBe("PARTIAL");
  });

  it("defaults unknown to INSUFFICIENT", () => {
    expect(normalizeVerdict("UNKNOWN")).toBe("INSUFFICIENT");
    expect(normalizeVerdict(null)).toBe("INSUFFICIENT");
    expect(normalizeVerdict(undefined)).toBe("INSUFFICIENT");
  });

  it("handles case insensitivity", () => {
    expect(normalizeVerdict("complete")).toBe("COMPLETE");
    expect(normalizeVerdict("Partial")).toBe("PARTIAL");
  });
});

describe("extractJson", () => {
  it("extracts JSON from markdown code fence", () => {
    const raw = '```json\n{"verdict": "COMPLETE", "reasoning": "good"}\n```';
    const json = extractJson(raw);
    expect(JSON.parse(json)).toEqual({ verdict: "COMPLETE", reasoning: "good" });
  });

  it("extracts JSON with braces in reasoning", () => {
    const raw = '{"verdict": "COMPLETE", "reasoning": "the memory {user} was found"}';
    const json = extractJson(raw);
    expect(JSON.parse(json)).toEqual({
      verdict: "COMPLETE",
      reasoning: "the memory {user} was found",
    });
  });

  it("handles plain text without JSON", () => {
    const raw = "no json here";
    expect(extractJson(raw)).toBe("no json here");
  });

  it("stops at matching brace when trailing braces exist", () => {
    const raw = '{"verdict": "COMPLETE"} and then {some other text}';
    const json = extractJson(raw);
    expect(JSON.parse(json)).toEqual({ verdict: "COMPLETE" });
  });

  it("handles nested objects correctly", () => {
    const raw = '{"verdict": "COMPLETE", "meta": {"score": 1}} trailing text';
    const json = extractJson(raw);
    expect(JSON.parse(json)).toEqual({ verdict: "COMPLETE", meta: { score: 1 } });
  });

  it("handles escaped quotes inside strings", () => {
    const raw = '{"reasoning": "the user said \\"hello\\"", "verdict": "PARTIAL"}';
    const json = extractJson(raw);
    expect(JSON.parse(json)).toEqual({
      reasoning: 'the user said "hello"',
      verdict: "PARTIAL",
    });
  });
});

describe("normalizeCorrectness", () => {
  it("normalizes exact strings", () => {
    expect(normalizeCorrectness("correct")).toBe("correct");
    expect(normalizeCorrectness("partial")).toBe("partial");
    expect(normalizeCorrectness("incorrect")).toBe("incorrect");
  });

  it("defaults unknown to incorrect", () => {
    expect(normalizeCorrectness("UNKNOWN")).toBe("incorrect");
    expect(normalizeCorrectness(null)).toBe("incorrect");
    expect(normalizeCorrectness(undefined)).toBe("incorrect");
  });

  it("handles case insensitivity", () => {
    expect(normalizeCorrectness("CORRECT")).toBe("correct");
    expect(normalizeCorrectness("Partial")).toBe("partial");
  });
});
