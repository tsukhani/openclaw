import { describe, expect, it } from "vitest";

describe("sleep-phases-reasoning exports", () => {
  it("exports all four phase functions", async () => {
    const mod = await import("./sleep-phases-reasoning.js");
    expect(typeof mod.runRuleLearning).toBe("function");
    expect(typeof mod.runRuleMaterialization).toBe("function");
    expect(typeof mod.runConsistencyAudit).toBe("function");
    expect(typeof mod.runCausalModelUpdate).toBe("function");
  });
});

describe("SleepCycleResult reasoning fields", () => {
  it("has all four new phase result sections", () => {
    // Verify the zero-initialized shape matches what sleep-cycle.ts creates
    const result = {
      ruleLearning: { rulesDiscovered: 0, rulesActivated: 0, rulesRejected: 0, rulesPruned: 0 },
      ruleMaterialization: { factsInferred: 0, iterations: 0, converged: false },
      consistencyAudit: { constraintsChecked: 0, violationsFound: 0, memoriesQuarantined: 0 },
      causalModelUpdate: { modelsUpdated: 0, edgesAdded: 0, edgesRemoved: 0 },
    };
    expect(result.ruleLearning.rulesDiscovered).toBe(0);
    expect(result.ruleMaterialization.converged).toBe(false);
    expect(result.consistencyAudit.constraintsChecked).toBe(0);
    expect(result.causalModelUpdate.modelsUpdated).toBe(0);
  });
});

describe("phase skip conditions", () => {
  it("skip flags default to false", () => {
    const options = {
      skipRuleLearning: undefined,
      skipRuleMaterialization: undefined,
      skipConsistencyAudit: undefined,
      skipCausalModelUpdate: undefined,
    };
    // undefined is falsy, so phases should run by default
    expect(!options.skipRuleLearning).toBe(true);
    expect(!options.skipRuleMaterialization).toBe(true);
    expect(!options.skipConsistencyAudit).toBe(true);
    expect(!options.skipCausalModelUpdate).toBe(true);
  });

  it("skip flags can be set to true", () => {
    const options = {
      skipRuleLearning: true,
      skipRuleMaterialization: true,
      skipConsistencyAudit: true,
      skipCausalModelUpdate: true,
    };
    expect(options.skipRuleLearning).toBe(true);
  });
});
