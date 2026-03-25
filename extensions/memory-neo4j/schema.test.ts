/**
 * Tests for schema.ts — Schema Validation & Helpers.
 *
 * Tests the exported pure functions: escapeLucene(), validateRelationshipType(),
 * and the exported constants and types.
 */

import { describe, it, expect } from "vitest";
import type { MemorySource } from "./schema.js";
import {
  escapeLucene,
  validateRelationshipType,
  sanitizeRelationshipType,
  WELL_KNOWN_RELATIONSHIP_TYPES,
  MEMORY_CATEGORIES,
  ENTITY_TYPES,
} from "./schema.js";

// ============================================================================
// escapeLucene()
// ============================================================================

describe("escapeLucene", () => {
  it("should return normal text unchanged", () => {
    expect(escapeLucene("hello world")).toBe("hello world");
  });

  it("should return empty string unchanged", () => {
    expect(escapeLucene("")).toBe("");
  });

  it("should escape plus sign", () => {
    expect(escapeLucene("a+b")).toBe("a\\+b");
  });

  it("should escape minus sign", () => {
    expect(escapeLucene("a-b")).toBe("a\\-b");
  });

  it("should escape ampersand", () => {
    expect(escapeLucene("a&b")).toBe("a\\&b");
  });

  it("should escape pipe", () => {
    expect(escapeLucene("a|b")).toBe("a\\|b");
  });

  it("should escape exclamation mark", () => {
    expect(escapeLucene("hello!")).toBe("hello\\!");
  });

  it("should escape parentheses", () => {
    expect(escapeLucene("(group)")).toBe("\\(group\\)");
  });

  it("should escape curly braces", () => {
    expect(escapeLucene("{range}")).toBe("\\{range\\}");
  });

  it("should escape square brackets", () => {
    expect(escapeLucene("[range]")).toBe("\\[range\\]");
  });

  it("should escape caret", () => {
    expect(escapeLucene("boost^2")).toBe("boost\\^2");
  });

  it("should escape double quotes", () => {
    expect(escapeLucene('"exact"')).toBe('\\"exact\\"');
  });

  it("should escape tilde", () => {
    expect(escapeLucene("fuzzy~")).toBe("fuzzy\\~");
  });

  it("should escape asterisk", () => {
    expect(escapeLucene("wild*")).toBe("wild\\*");
  });

  it("should escape question mark", () => {
    expect(escapeLucene("single?")).toBe("single\\?");
  });

  it("should escape colon", () => {
    expect(escapeLucene("field:value")).toBe("field\\:value");
  });

  it("should escape backslash", () => {
    expect(escapeLucene("path\\file")).toBe("path\\\\file");
  });

  it("should escape forward slash", () => {
    expect(escapeLucene("a/b")).toBe("a\\/b");
  });

  it("should escape multiple special characters in one string", () => {
    expect(escapeLucene("(a+b) && c*")).toBe("\\(a\\+b\\) \\&\\& c\\*");
  });

  it("should handle mixed normal and special characters", () => {
    expect(escapeLucene("hello world! [test]")).toBe("hello world\\! \\[test\\]");
  });

  it("should handle strings with only special characters", () => {
    expect(escapeLucene("+-")).toBe("\\+\\-");
  });
});

// ============================================================================
// validateRelationshipType()
// ============================================================================

describe("validateRelationshipType", () => {
  describe("valid relationship types", () => {
    it("should accept WORKS_AT", () => {
      expect(validateRelationshipType("WORKS_AT")).toBe(true);
    });

    it("should accept LIVES_AT", () => {
      expect(validateRelationshipType("LIVES_AT")).toBe(true);
    });

    it("should accept KNOWS", () => {
      expect(validateRelationshipType("KNOWS")).toBe(true);
    });

    it("should accept MARRIED_TO", () => {
      expect(validateRelationshipType("MARRIED_TO")).toBe(true);
    });

    it("should accept PREFERS", () => {
      expect(validateRelationshipType("PREFERS")).toBe(true);
    });

    it("should accept DECIDED", () => {
      expect(validateRelationshipType("DECIDED")).toBe(true);
    });

    it("should accept RELATED_TO", () => {
      expect(validateRelationshipType("RELATED_TO")).toBe(true);
    });

    it("should accept all WELL_KNOWN_RELATIONSHIP_TYPES", () => {
      for (const type of WELL_KNOWN_RELATIONSHIP_TYPES) {
        expect(validateRelationshipType(type)).toBe(true);
      }
    });

    it("should accept any UPPER_SNAKE_CASE type (relationship-type agnostic)", () => {
      expect(validateRelationshipType("PARENT_OF")).toBe(true);
      expect(validateRelationshipType("CHILD_OF")).toBe(true);
      expect(validateRelationshipType("HAS_PHONE")).toBe(true);
      expect(validateRelationshipType("CUSTOM_REL")).toBe(true);
    });
  });

  describe("invalid relationship types", () => {
    it("should reject empty string", () => {
      expect(validateRelationshipType("")).toBe(false);
    });

    it("should accept lowercase (sanitized to uppercase)", () => {
      // validateRelationshipType now normalizes via sanitizeRelationshipType
      expect(validateRelationshipType("works_at")).toBe(true);
    });

    it("should accept mixed case (sanitized to uppercase)", () => {
      expect(validateRelationshipType("Works_At")).toBe(true);
    });

    it("should accept types with whitespace (sanitized)", () => {
      expect(validateRelationshipType(" WORKS_AT ")).toBe(true);
    });

    it("should reject potential Cypher injection", () => {
      expect(validateRelationshipType("WORKS_AT]->(n) DELETE n//")).toBe(false);
    });
  });
});

// ============================================================================
// sanitizeRelationshipType()
// ============================================================================

describe("sanitizeRelationshipType", () => {
  it("should pass through valid UPPER_SNAKE_CASE", () => {
    expect(sanitizeRelationshipType("WORKS_AT")).toBe("WORKS_AT");
    expect(sanitizeRelationshipType("PARENT_OF")).toBe("PARENT_OF");
  });

  it("should normalize lowercase to uppercase", () => {
    expect(sanitizeRelationshipType("works_at")).toBe("WORKS_AT");
  });

  it("should normalize mixed case to uppercase", () => {
    expect(sanitizeRelationshipType("Parent_Of")).toBe("PARENT_OF");
  });

  it("should replace spaces and hyphens with underscores", () => {
    expect(sanitizeRelationshipType("lives at")).toBe("LIVES_AT");
    expect(sanitizeRelationshipType("child-of")).toBe("CHILD_OF");
  });

  it("should trim whitespace", () => {
    expect(sanitizeRelationshipType("  KNOWS  ")).toBe("KNOWS");
  });

  it("should return null for empty string", () => {
    expect(sanitizeRelationshipType("")).toBeNull();
    expect(sanitizeRelationshipType("   ")).toBeNull();
  });

  it("should return null for strings with special characters", () => {
    expect(sanitizeRelationshipType("WORKS_AT]->(n)")).toBeNull();
    expect(sanitizeRelationshipType("rel.type")).toBeNull();
    expect(sanitizeRelationshipType("123_TYPE")).toBeNull();
  });
});

// ============================================================================
// Exported Constants
// ============================================================================

describe("exported constants", () => {
  it("MEMORY_CATEGORIES should contain expected categories", () => {
    expect(MEMORY_CATEGORIES).toContain("preference");
    expect(MEMORY_CATEGORIES).toContain("fact");
    expect(MEMORY_CATEGORIES).toContain("decision");
    expect(MEMORY_CATEGORIES).toContain("entity");
    expect(MEMORY_CATEGORIES).toContain("other");
  });

  it("ENTITY_TYPES should contain expected types", () => {
    expect(ENTITY_TYPES).toContain("person");
    expect(ENTITY_TYPES).toContain("organization");
    expect(ENTITY_TYPES).toContain("location");
    expect(ENTITY_TYPES).toContain("event");
    expect(ENTITY_TYPES).toContain("concept");
  });

  it("WELL_KNOWN_RELATIONSHIP_TYPES should be an array of well-known types", () => {
    expect(Array.isArray(WELL_KNOWN_RELATIONSHIP_TYPES)).toBe(true);
    expect(WELL_KNOWN_RELATIONSHIP_TYPES).toContain("WORKS_AT");
    expect(WELL_KNOWN_RELATIONSHIP_TYPES).toContain("PARENT_OF");
    expect(WELL_KNOWN_RELATIONSHIP_TYPES).toContain("CHILD_OF");
  });
});

// ============================================================================
// MemorySource Type
// ============================================================================

describe("MemorySource type", () => {
  it("should accept all MemorySource values", () => {
    const sources: MemorySource[] = ["user", "auto-capture", "memory-watcher", "import"];
    expect(sources).toHaveLength(4);
  });
});
