import { describe, expect, it } from "vitest";
import type { ConstraintDefinition, ConstraintViolation } from "./consistency-checker.js";

describe("ConstraintDefinition types", () => {
  it("accepts valid uniqueness constraint", () => {
    const constraint: ConstraintDefinition = {
      name: "single_birthdate",
      type: "uniqueness",
      severity: "error",
      entityType: "person",
      relationshipType: "HAS_BIRTHDATE",
      agentId: "test-agent",
    };
    expect(constraint.type).toBe("uniqueness");
    expect(constraint.severity).toBe("error");
  });

  it("accepts valid mutual exclusion constraint", () => {
    const constraint: ConstraintDefinition = {
      name: "alive_or_deceased",
      type: "mutual_exclusion",
      severity: "error",
      entityType: "person",
      relationshipType: "IS_ALIVE",
      secondaryRelationshipType: "IS_DECEASED",
      agentId: "test-agent",
    };
    expect(constraint.type).toBe("mutual_exclusion");
    expect(constraint.secondaryRelationshipType).toBe("IS_DECEASED");
  });

  it("accepts valid temporal ordering constraint", () => {
    const constraint: ConstraintDefinition = {
      name: "birth_before_death",
      type: "temporal_ordering",
      severity: "error",
      entityType: "person",
      relationshipType: "BORN_ON",
      secondaryRelationshipType: "DIED_ON",
      agentId: "test-agent",
    };
    expect(constraint.type).toBe("temporal_ordering");
  });

  it("accepts valid cardinality constraint", () => {
    const constraint: ConstraintDefinition = {
      name: "max_employers",
      type: "cardinality",
      severity: "warning",
      entityType: "person",
      relationshipType: "WORKS_AT",
      maxCardinality: 3,
      agentId: "test-agent",
    };
    expect(constraint.maxCardinality).toBe(3);
    expect(constraint.severity).toBe("warning");
  });

  it("accepts valid type constraint", () => {
    const constraint: ConstraintDefinition = {
      name: "works_at_org",
      type: "type_constraint",
      severity: "error",
      entityType: "person",
      relationshipType: "WORKS_AT",
      requiredTargetType: "organization",
      agentId: "test-agent",
    };
    expect(constraint.requiredTargetType).toBe("organization");
  });
});

describe("ConstraintViolation structure", () => {
  it("has required fields", () => {
    const violation: ConstraintViolation = {
      type: "uniqueness",
      constraintName: "single_birthdate",
      severity: "error",
      offendingEntityId: "entity-123",
      offendingEntityName: "John",
      conflictingMemoryId: "memory-456",
      message: 'Entity "John" has multiple active HAS_BIRTHDATE relationships',
    };
    expect(violation.type).toBe("uniqueness");
    expect(violation.severity).toBe("error");
    expect(violation.message).toContain("John");
  });
});
