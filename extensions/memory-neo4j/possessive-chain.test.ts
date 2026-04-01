/**
 * Tests for possessive-chain parser and LLM decomposer.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { parsePossessiveChain, decomposeChainQuery } from "./possessive-chain.js";

// Mock callLlm for decomposeChainQuery tests (hoisted to top level)
vi.mock("./llm-client.js", () => ({
  callLlm: vi.fn(),
  setPluginLlm: vi.fn(),
}));

// ============================================================================
// parsePossessiveChain (rule-based fallback)
// ============================================================================

describe("parsePossessiveChain", () => {
  describe("basic chain parsing", () => {
    it("parses 'my wife's older son's phone number' with selfEntityName", () => {
      const result = parsePossessiveChain("What is my wife's older son's phone number?", "tarun");
      expect(result.isChain).toBe(true);
      if (!result.isChain) return;

      expect(result.seedEntity).toBe("tarun");
      expect(result.steps).toHaveLength(2);
      expect(result.steps[0].description).toBe("wife");
      expect(result.steps[0].relTypes).toContain("MARRIED_TO");
      expect(result.steps[1].description).toBe("son");
      expect(result.steps[1].qualifiers).toEqual(["older"]);
      expect(result.steps[1].relTypes).toContain("PARENT_OF");
      expect(result.target).toBe("phone number");
      expect(result.targetPropertyKey).toBe("phone");
    });

    it("parses 'Alice's manager's email address'", () => {
      const result = parsePossessiveChain("Alice's manager's email address");
      expect(result.isChain).toBe(true);
      if (!result.isChain) return;

      expect(result.seedEntity).toBe("alice");
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0].description).toBe("manager");
      expect(result.steps[0].relTypes).toContain("REPORTS_TO");
      expect(result.target).toBe("email address");
      expect(result.targetPropertyKey).toBe("email");
    });

    it("parses 'my mother's sister's birthday'", () => {
      const result = parsePossessiveChain("my mother's sister's birthday", "tarun");
      expect(result.isChain).toBe(true);
      if (!result.isChain) return;

      expect(result.seedEntity).toBe("tarun");
      expect(result.steps).toHaveLength(2);
      expect(result.steps[0].description).toBe("mother");
      expect(result.steps[0].relTypes).toContain("CHILD_OF");
      expect(result.steps[1].description).toBe("sister");
      expect(result.steps[1].relTypes).toContain("SIBLING_OF");
      expect(result.target).toBe("birthday");
      expect(result.targetPropertyKey).toBe("birthday");
    });
  });

  describe("longer chains", () => {
    it("parses 3-step chain: my wife's brother's son's name", () => {
      const result = parsePossessiveChain("What is my wife's brother's son's name?", "tarun");
      expect(result.isChain).toBe(true);
      if (!result.isChain) return;

      expect(result.seedEntity).toBe("tarun");
      expect(result.steps).toHaveLength(3);
      expect(result.steps[0].description).toBe("wife");
      expect(result.steps[0].relTypes).toContain("MARRIED_TO");
      expect(result.steps[1].description).toBe("brother");
      expect(result.steps[1].relTypes).toContain("SIBLING_OF");
      expect(result.steps[2].description).toBe("son");
      expect(result.steps[2].relTypes).toContain("PARENT_OF");
      expect(result.target).toBe("name");
      expect(result.targetPropertyKey).toBe("name");
    });
  });

  describe("self-entity resolution", () => {
    it("replaces 'my' with selfEntityName as possessive", () => {
      const result = parsePossessiveChain("my wife's son's phone", "tarun");
      expect(result.isChain).toBe(true);
      if (!result.isChain) return;
      expect(result.seedEntity).toBe("tarun");
    });

    it("handles missing selfEntityName gracefully", () => {
      const result = parsePossessiveChain("my wife's son's phone");
      expect(result.isChain).toBe(true);
    });
  });

  describe("question word stripping", () => {
    it("strips 'What is' prefix", () => {
      const result = parsePossessiveChain("What is John's wife's email?");
      expect(result.isChain).toBe(true);
      if (!result.isChain) return;
      expect(result.seedEntity).toBe("john");
    });

    it("strips 'Who is' prefix", () => {
      const result = parsePossessiveChain("Who is Sarah's husband's boss?");
      expect(result.isChain).toBe(true);
      if (!result.isChain) return;
      expect(result.seedEntity).toBe("sarah");
    });

    it("strips trailing question marks", () => {
      const result = parsePossessiveChain("John's wife's phone???");
      expect(result.isChain).toBe(true);
      if (!result.isChain) return;
      expect(result.target).toBe("phone");
    });
  });

  describe("relationship type mapping", () => {
    it("maps 'wife' to MARRIED_TO", () => {
      const result = parsePossessiveChain("John's wife's phone");
      expect(result.isChain).toBe(true);
      if (!result.isChain) return;
      expect(result.steps[0].relTypes).toContain("MARRIED_TO");
    });

    it("maps 'son' to PARENT_OF and CHILD_OF", () => {
      const result = parsePossessiveChain("John's son's email");
      expect(result.isChain).toBe(true);
      if (!result.isChain) return;
      expect(result.steps[0].relTypes).toContain("PARENT_OF");
      expect(result.steps[0].relTypes).toContain("CHILD_OF");
    });

    it("maps 'boss' to REPORTS_TO", () => {
      const result = parsePossessiveChain("John's boss's email");
      expect(result.isChain).toBe(true);
      if (!result.isChain) return;
      expect(result.steps[0].relTypes).toContain("REPORTS_TO");
    });

    it("falls back to empty relTypes for unknown terms", () => {
      const result = parsePossessiveChain("John's neighbor's dog's name");
      expect(result.isChain).toBe(true);
      if (!result.isChain) return;
      expect(result.steps[0].description).toBe("neighbor");
      expect(result.steps[0].relTypes).toEqual([]);
    });
  });

  describe("target property resolution", () => {
    it("maps 'phone number' to 'phone'", () => {
      const result = parsePossessiveChain("John's wife's phone number");
      expect(result.isChain).toBe(true);
      if (!result.isChain) return;
      expect(result.targetPropertyKey).toBe("phone");
    });

    it("maps 'email address' to 'email'", () => {
      const result = parsePossessiveChain("John's wife's email address");
      expect(result.isChain).toBe(true);
      if (!result.isChain) return;
      expect(result.targetPropertyKey).toBe("email");
    });

    it("returns null for unknown target", () => {
      const result = parsePossessiveChain("John's wife's favorite color");
      expect(result.isChain).toBe(true);
      if (!result.isChain) return;
      expect(result.targetPropertyKey).toBeNull();
    });
  });

  describe("non-chain queries", () => {
    it("rejects single possessive (too few segments)", () => {
      const result = parsePossessiveChain("John's phone number");
      expect(result.isChain).toBe(false);
    });

    it("rejects no possessives", () => {
      const result = parsePossessiveChain("What is the weather today");
      expect(result.isChain).toBe(false);
    });
  });

  describe("qualifier extraction", () => {
    it("extracts 'older' from 'older son'", () => {
      const result = parsePossessiveChain("John's wife's older son's phone");
      expect(result.isChain).toBe(true);
      if (!result.isChain) return;
      const sonStep = result.steps.find((s) => s.description === "son");
      expect(sonStep).toBeDefined();
      expect(sonStep!.qualifiers).toContain("older");
    });

    it("extracts 'younger' from 'younger daughter'", () => {
      const result = parsePossessiveChain("John's wife's younger daughter's email");
      expect(result.isChain).toBe(true);
      if (!result.isChain) return;
      const step = result.steps.find((s) => s.description === "daughter");
      expect(step).toBeDefined();
      expect(step!.qualifiers).toContain("younger");
    });
  });
});

// ============================================================================
// decomposeChainQuery (LLM-based) — response validation
// ============================================================================

describe("decomposeChainQuery", () => {
  let mockCallLlm: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    const { callLlm } = await import("./llm-client.js");
    mockCallLlm = vi.mocked(callLlm);
  });

  const fakeConfig = {
    enabled: true,
    model: "test-model",
    baseUrl: "https://api.example.com",
    timeout: 5000,
    maxRetries: 0,
    concurrency: 1,
    maxTokens: 1024,
    localNerEnabled: false,
  } as Parameters<typeof decomposeChainQuery>[1];

  afterEach(() => {
    mockCallLlm.mockReset();
  });

  it("parses valid LLM response into PossessiveChain", async () => {
    mockCallLlm.mockResolvedValue(
      JSON.stringify({
        seedEntity: "tarun",
        steps: [
          { relTypes: ["MARRIED_TO"], qualifiers: [], description: "wife" },
          { relTypes: ["PARENT_OF", "CHILD_OF"], qualifiers: ["older"], description: "son" },
        ],
        targetProperty: "phone",
      }),
    );

    const result = await decomposeChainQuery("my wife's son's phone", fakeConfig, "tarun");
    expect(result.isChain).toBe(true);
    if (!result.isChain) return;

    expect(result.seedEntity).toBe("tarun");
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].relTypes).toEqual(["MARRIED_TO"]);
    expect(result.steps[0].description).toBe("wife");
    expect(result.steps[1].relTypes).toEqual(["PARENT_OF", "CHILD_OF"]);
    expect(result.steps[1].qualifiers).toEqual(["older"]);
    expect(result.targetPropertyKey).toBe("phone");
  });

  it("handles markdown-wrapped JSON response", async () => {
    mockCallLlm.mockResolvedValue(
      '```json\n{"seedEntity": "alice", "steps": [{"relTypes": ["REPORTS_TO"], "description": "manager"}], "targetProperty": "email"}\n```',
    );

    const result = await decomposeChainQuery("Alice's manager's email", fakeConfig);
    expect(result.isChain).toBe(true);
    if (!result.isChain) return;
    expect(result.seedEntity).toBe("alice");
    expect(result.steps[0].relTypes).toEqual(["REPORTS_TO"]);
  });

  it("returns isChain=false when LLM says not traversable", async () => {
    mockCallLlm.mockResolvedValue(JSON.stringify({ isTraversable: false }));

    const result = await decomposeChainQuery("what is the weather", fakeConfig);
    expect(result.isChain).toBe(false);
  });

  it("returns isChain=false on empty LLM response", async () => {
    mockCallLlm.mockResolvedValue(null);

    const result = await decomposeChainQuery("my wife's son's phone", fakeConfig, "tarun");
    expect(result.isChain).toBe(false);
  });

  it("returns isChain=false on invalid JSON", async () => {
    mockCallLlm.mockResolvedValue("not json at all");

    const result = await decomposeChainQuery("my wife's son's phone", fakeConfig, "tarun");
    expect(result.isChain).toBe(false);
  });

  it("returns isChain=false when steps have no valid relationship types", async () => {
    mockCallLlm.mockResolvedValue(
      JSON.stringify({
        seedEntity: "tarun",
        steps: [{ relTypes: ["!!!INVALID!!!"], description: "test" }],
        targetProperty: null,
      }),
    );

    const result = await decomposeChainQuery("my wife's son's phone", fakeConfig, "tarun");
    expect(result.isChain).toBe(false);
  });

  it("sanitizes relationship types from LLM response", async () => {
    mockCallLlm.mockResolvedValue(
      JSON.stringify({
        seedEntity: "tarun",
        steps: [{ relTypes: ["married_to"], description: "wife" }],
        targetProperty: "phone",
      }),
    );

    const result = await decomposeChainQuery("my wife's phone", fakeConfig, "tarun");
    expect(result.isChain).toBe(true);
    if (!result.isChain) return;
    expect(result.steps[0].relTypes).toEqual(["MARRIED_TO"]);
  });

  it("returns isChain=false on LLM error", async () => {
    mockCallLlm.mockRejectedValue(new Error("API rate limit exceeded"));

    const result = await decomposeChainQuery("my wife's son's phone", fakeConfig, "tarun");
    expect(result.isChain).toBe(false);
    if (result.isChain) return;
    expect(result.reason).toContain("LLM decomposition failed");
  });
});
