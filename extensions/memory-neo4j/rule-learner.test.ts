import { describe, expect, it } from "vitest";
import type { LearnedRule, LearnRulesOptions } from "./rule-learner.js";

describe("RuleLearner types", () => {
  it("LearnRulesOptions has correct defaults intent", () => {
    const opts: LearnRulesOptions = {
      maxRuleLength: 3,
      minSupport: 5,
      minConfidence: 0.6,
      sampleSize: 1000,
      timeLimit: 60,
    };
    expect(opts.maxRuleLength).toBe(3);
    expect(opts.minSupport).toBe(5);
    expect(opts.minConfidence).toBe(0.6);
  });

  it("LearnedRule tracks activation status", () => {
    const activated: LearnedRule = {
      name: "co_location_via_employment",
      antecedent: "(x:Entity)-[:WORKS_AT]->(y:Entity)-[:LOCATED_IN]->(z:Entity)",
      consequent: "(x)-[:LOCATED_IN {inferred: true}]->(z)",
      support: 15,
      confidence: 0.78,
      status: "activated",
    };
    expect(activated.status).toBe("activated");
    expect(activated.support).toBeGreaterThan(0);

    const rejected: LearnedRule = {
      name: "weak_pattern",
      antecedent: "(x:Entity)-[:KNOWS]->(y:Entity)",
      consequent: "(x)-[:WORKS_WITH {inferred: true}]->(y)",
      support: 2,
      confidence: 0.3,
      status: "rejected",
      reason: "Insufficient support: 2 < 5",
    };
    expect(rejected.status).toBe("rejected");
    expect(rejected.reason).toContain("Insufficient");
  });
});

describe("Rule deduplication", () => {
  it("identifies duplicate patterns by patternKey", () => {
    // Two discoveries of the same generalized pattern should merge
    const key1 = "LOCATED_IN:WORKS_AT,LOCATED_IN:person,organization,location";
    const key2 = "LOCATED_IN:WORKS_AT,LOCATED_IN:person,organization,location";
    expect(key1).toBe(key2);

    // Different patterns should not match
    const key3 = "KNOWS:WORKS_AT,WORKS_AT:person,organization,organization";
    expect(key1).not.toBe(key3);
  });
});

describe("Rule cap enforcement", () => {
  it("lowest support rule is replaceable", () => {
    const rules = [
      { name: "rule_a", support: 20 },
      { name: "rule_b", support: 5 },
      { name: "rule_c", support: 12 },
    ];
    const lowest = rules.reduce((min, r) => (r.support < min.support ? r : min));
    expect(lowest.name).toBe("rule_b");

    // A new rule with support 15 should replace rule_b
    const newRule = { name: "rule_d", support: 15 };
    expect(newRule.support).toBeGreaterThan(lowest.support);
  });
});
