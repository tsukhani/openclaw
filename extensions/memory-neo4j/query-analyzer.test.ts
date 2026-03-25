import { describe, expect, it } from "vitest";
import { extractTemporalConstraint } from "./query-analyzer.js";

// Fixed reference date: Wednesday, 2025-03-15 12:00:00 UTC
const NOW = new Date("2025-03-15T12:00:00Z");

function d(iso: string): Date {
  return new Date(iso);
}

describe("extractTemporalConstraint", () => {
  // =========================================================================
  // Day Keywords
  // =========================================================================

  describe("day keywords", () => {
    it("extracts 'yesterday'", () => {
      const result = extractTemporalConstraint("what did we discuss yesterday", NOW);
      expect(result).not.toBeNull();
      expect(result!.originalExpression).toBe("yesterday");
      expect(d(result!.startDate).toDateString()).toBe("Fri Mar 14 2025");
      expect(d(result!.endDate).toDateString()).toBe("Fri Mar 14 2025");
      expect(result!.cleanedQuery).toBe("what did we discuss");
    });

    it("extracts 'today'", () => {
      const result = extractTemporalConstraint("meetings today", NOW);
      expect(result).not.toBeNull();
      expect(result!.originalExpression).toBe("today");
      expect(d(result!.startDate).toDateString()).toBe("Sat Mar 15 2025");
      expect(result!.cleanedQuery).toBe("meetings");
    });

    it("extracts 'tomorrow'", () => {
      const result = extractTemporalConstraint("what's planned for tomorrow", NOW);
      expect(result).not.toBeNull();
      expect(result!.originalExpression).toBe("tomorrow");
      expect(d(result!.startDate).toDateString()).toBe("Sun Mar 16 2025");
    });
  });

  // =========================================================================
  // Relative Periods
  // =========================================================================

  describe("relative periods (last/this/next week/month/year)", () => {
    it("extracts 'last week'", () => {
      const result = extractTemporalConstraint("conversations from last week", NOW);
      expect(result).not.toBeNull();
      expect(result!.originalExpression).toBe("last week");
      // NOW is Saturday Mar 15, 2025. Last week = Mon Mar 3 - Sun Mar 9
      expect(d(result!.startDate).toDateString()).toBe("Mon Mar 03 2025");
      expect(d(result!.endDate).toDateString()).toBe("Sun Mar 09 2025");
      expect(result!.cleanedQuery).toBe("conversations from");
    });

    it("extracts 'this week'", () => {
      const result = extractTemporalConstraint("what happened this week", NOW);
      expect(result).not.toBeNull();
      expect(result!.originalExpression).toBe("this week");
      // This week = Mon Mar 10 - Sun Mar 16
      expect(d(result!.startDate).toDateString()).toBe("Mon Mar 10 2025");
      expect(d(result!.endDate).toDateString()).toBe("Sun Mar 16 2025");
    });

    it("extracts 'next month'", () => {
      const result = extractTemporalConstraint("deadlines next month", NOW);
      expect(result).not.toBeNull();
      expect(result!.originalExpression).toBe("next month");
      expect(d(result!.startDate).toDateString()).toBe("Tue Apr 01 2025");
      expect(d(result!.endDate).toDateString()).toBe("Wed Apr 30 2025");
    });

    it("extracts 'last month'", () => {
      const result = extractTemporalConstraint("summary of last month", NOW);
      expect(result).not.toBeNull();
      expect(d(result!.startDate).toDateString()).toBe("Sat Feb 01 2025");
      expect(d(result!.endDate).toDateString()).toBe("Fri Feb 28 2025");
    });

    it("extracts 'this year'", () => {
      const result = extractTemporalConstraint("goals this year", NOW);
      expect(result).not.toBeNull();
      expect(d(result!.startDate).toDateString()).toBe("Wed Jan 01 2025");
      expect(d(result!.endDate).toDateString()).toBe("Wed Dec 31 2025");
    });

    it("extracts 'last year'", () => {
      const result = extractTemporalConstraint("what did we accomplish last year", NOW);
      expect(result).not.toBeNull();
      expect(d(result!.startDate).toDateString()).toBe("Mon Jan 01 2024");
      expect(d(result!.endDate).toDateString()).toBe("Tue Dec 31 2024");
    });
  });

  // =========================================================================
  // Last N Units
  // =========================================================================

  describe("last/past N days/weeks/months", () => {
    it("extracts 'last 3 days'", () => {
      const result = extractTemporalConstraint("changes in the last 3 days", NOW);
      expect(result).not.toBeNull();
      expect(result!.originalExpression).toBe("last 3 days");
      expect(d(result!.startDate).toDateString()).toBe("Wed Mar 12 2025");
      expect(d(result!.endDate).toDateString()).toBe("Sat Mar 15 2025");
      expect(result!.cleanedQuery).toBe("changes in the");
    });

    it("extracts 'past 2 weeks'", () => {
      const result = extractTemporalConstraint("activity in the past 2 weeks", NOW);
      expect(result).not.toBeNull();
      expect(result!.originalExpression).toBe("past 2 weeks");
      expect(d(result!.startDate).toDateString()).toBe("Sat Mar 01 2025");
    });

    it("extracts 'last 1 month'", () => {
      const result = extractTemporalConstraint("events last 1 month", NOW);
      expect(result).not.toBeNull();
      expect(d(result!.startDate).toDateString()).toBe("Sat Feb 15 2025");
    });

    it("handles written-out numbers: 'last three days'", () => {
      const result = extractTemporalConstraint("updates from the last three days", NOW);
      expect(result).not.toBeNull();
      expect(result!.originalExpression).toBe("last three days");
      expect(d(result!.startDate).toDateString()).toBe("Wed Mar 12 2025");
    });

    it("handles written-out numbers: 'past twenty days'", () => {
      const result = extractTemporalConstraint("what happened in the past twenty days", NOW);
      expect(result).not.toBeNull();
      expect(result!.originalExpression).toBe("past twenty days");
    });
  });

  // =========================================================================
  // N Units Ago
  // =========================================================================

  describe("N days/weeks/months ago", () => {
    it("extracts '3 days ago'", () => {
      const result = extractTemporalConstraint("what was decided 3 days ago", NOW);
      expect(result).not.toBeNull();
      expect(result!.originalExpression).toBe("3 days ago");
      expect(d(result!.startDate).toDateString()).toBe("Wed Mar 12 2025");
      expect(d(result!.endDate).toDateString()).toBe("Wed Mar 12 2025");
      expect(result!.cleanedQuery).toBe("what was decided");
    });

    it("extracts 'two weeks ago'", () => {
      const result = extractTemporalConstraint("meeting two weeks ago", NOW);
      expect(result).not.toBeNull();
      expect(result!.originalExpression).toBe("two weeks ago");
      // 2 weeks before Mar 15 = Mar 1; start of that week
      const start = d(result!.startDate);
      expect(start.getFullYear()).toBe(2025);
      expect(start.getMonth()).toBe(1); // Feb (week containing Mar 1)
    });

    it("extracts '1 month ago'", () => {
      const result = extractTemporalConstraint("conversations 1 month ago", NOW);
      expect(result).not.toBeNull();
      expect(result!.originalExpression).toBe("1 month ago");
      // 1 month before Mar 15 = Feb 15 → Feb 1 to Feb 28
      expect(d(result!.startDate).toDateString()).toBe("Sat Feb 01 2025");
      expect(d(result!.endDate).toDateString()).toBe("Fri Feb 28 2025");
    });
  });

  // =========================================================================
  // Named Months
  // =========================================================================

  describe("named months (in/last/next)", () => {
    it("extracts 'in January'", () => {
      const result = extractTemporalConstraint("discussions in January", NOW);
      expect(result).not.toBeNull();
      expect(result!.originalExpression).toBe("in January");
      expect(d(result!.startDate).toDateString()).toBe("Wed Jan 01 2025");
      expect(d(result!.endDate).toDateString()).toBe("Fri Jan 31 2025");
    });

    it("extracts 'in January 2024'", () => {
      const result = extractTemporalConstraint("what happened in January 2024", NOW);
      expect(result).not.toBeNull();
      expect(d(result!.startDate).toDateString()).toBe("Mon Jan 01 2024");
      expect(d(result!.endDate).toDateString()).toBe("Wed Jan 31 2024");
    });

    it("extracts 'last March' — same month, goes to previous year", () => {
      // NOW is March 2025. "last March" should refer to March 2024 since
      // March hasn't fully passed but the month index is equal.
      const result = extractTemporalConstraint("decisions made last March", NOW);
      expect(result).not.toBeNull();
      expect(result!.originalExpression).toBe("last March");
      expect(d(result!.startDate).toDateString()).toBe("Fri Mar 01 2024");
      expect(d(result!.endDate).toDateString()).toBe("Sun Mar 31 2024");
    });

    it("extracts 'last December' — earlier month, same year", () => {
      const result = extractTemporalConstraint("events last December", NOW);
      expect(result).not.toBeNull();
      expect(d(result!.startDate).toDateString()).toBe("Sun Dec 01 2024");
    });

    it("extracts 'next February'", () => {
      const result = extractTemporalConstraint("plans for next February", NOW);
      expect(result).not.toBeNull();
      // Feb already passed in 2025, so next Feb = 2026
      expect(d(result!.startDate).toDateString()).toBe("Sun Feb 01 2026");
      expect(d(result!.endDate).toDateString()).toBe("Sat Feb 28 2026");
    });

    it("extracts abbreviated month 'in Jan'", () => {
      const result = extractTemporalConstraint("something in Jan", NOW);
      expect(result).not.toBeNull();
      expect(d(result!.startDate).toDateString()).toBe("Wed Jan 01 2025");
    });
  });

  // =========================================================================
  // Year
  // =========================================================================

  describe("year", () => {
    it("extracts 'in 2025'", () => {
      const result = extractTemporalConstraint("what happened in 2025", NOW);
      expect(result).not.toBeNull();
      expect(result!.originalExpression).toBe("in 2025");
      expect(d(result!.startDate).toDateString()).toBe("Wed Jan 01 2025");
      expect(d(result!.endDate).toDateString()).toBe("Wed Dec 31 2025");
    });

    it("extracts 'in 2023'", () => {
      const result = extractTemporalConstraint("projects in 2023", NOW);
      expect(result).not.toBeNull();
      expect(d(result!.startDate).getFullYear()).toBe(2023);
      expect(d(result!.endDate).getFullYear()).toBe(2023);
    });
  });

  // =========================================================================
  // Before / After / Since
  // =========================================================================

  describe("before/after/since", () => {
    it("extracts 'before January 2025'", () => {
      const result = extractTemporalConstraint("everything before January 2025", NOW);
      expect(result).not.toBeNull();
      expect(result!.originalExpression).toBe("before January 2025");
      expect(d(result!.startDate).getFullYear()).toBe(2000);
      // endDate should be just before Jan 1 2025
      expect(d(result!.endDate).getTime()).toBeLessThan(new Date("2025-01-01").getTime());
    });

    it("extracts 'after March'", () => {
      const result = extractTemporalConstraint("changes after March", NOW);
      expect(result).not.toBeNull();
      expect(result!.originalExpression).toBe("after March");
      expect(d(result!.startDate).toDateString()).toBe("Sat Mar 01 2025");
    });

    it("extracts 'since yesterday'", () => {
      const result = extractTemporalConstraint("updates since yesterday", NOW);
      expect(result).not.toBeNull();
      expect(result!.originalExpression).toBe("since yesterday");
      expect(d(result!.startDate).toDateString()).toBe("Fri Mar 14 2025");
      expect(d(result!.endDate).toDateString()).toBe("Sat Mar 15 2025");
    });

    it("extracts 'after 3 days ago'", () => {
      const result = extractTemporalConstraint("activity after 3 days ago", NOW);
      expect(result).not.toBeNull();
      expect(d(result!.startDate).toDateString()).toBe("Wed Mar 12 2025");
    });

    it("extracts 'before two weeks ago'", () => {
      const result = extractTemporalConstraint("messages before two weeks ago", NOW);
      expect(result).not.toBeNull();
      expect(result!.originalExpression).toBe("before two weeks ago");
      expect(d(result!.endDate).getTime()).toBeLessThan(new Date("2025-03-01").getTime());
    });
  });

  // =========================================================================
  // Between
  // =========================================================================

  describe("between X and Y", () => {
    it("extracts 'between January and March'", () => {
      const result = extractTemporalConstraint("discussions between January and March", NOW);
      expect(result).not.toBeNull();
      expect(result!.originalExpression).toBe("between January and March");
      expect(d(result!.startDate).toDateString()).toBe("Wed Jan 01 2025");
      expect(d(result!.endDate).toDateString()).toBe("Mon Mar 31 2025");
      expect(result!.cleanedQuery).toBe("discussions");
    });

    it("extracts 'between January 2024 and March 2025'", () => {
      const result = extractTemporalConstraint("data between January 2024 and March 2025", NOW);
      expect(result).not.toBeNull();
      expect(d(result!.startDate).toDateString()).toBe("Mon Jan 01 2024");
      expect(d(result!.endDate).toDateString()).toBe("Mon Mar 31 2025");
    });

    it("extracts 'between Feb and Apr'", () => {
      const result = extractTemporalConstraint("meetings between Feb and Apr", NOW);
      expect(result).not.toBeNull();
      expect(d(result!.startDate).getMonth()).toBe(1); // Feb
      expect(d(result!.endDate).getMonth()).toBe(3); // Apr
    });
  });

  // =========================================================================
  // Edge Cases
  // =========================================================================

  describe("edge cases", () => {
    it("returns null for queries with no temporal content", () => {
      expect(extractTemporalConstraint("favorite color", NOW)).toBeNull();
      expect(extractTemporalConstraint("what is TypeScript", NOW)).toBeNull();
      expect(extractTemporalConstraint("Alice's phone number", NOW)).toBeNull();
    });

    it("returns null for empty query", () => {
      expect(extractTemporalConstraint("", NOW)).toBeNull();
    });

    it("defaults to Date.now() when now is not provided", () => {
      const result = extractTemporalConstraint("what happened yesterday");
      expect(result).not.toBeNull();
      expect(result!.originalExpression).toBe("yesterday");
    });

    it("cleans up double spaces after stripping", () => {
      const result = extractTemporalConstraint("what happened last week with the project", NOW);
      expect(result).not.toBeNull();
      expect(result!.cleanedQuery).toBe("what happened with the project");
    });

    it("handles query that is entirely a temporal expression", () => {
      const result = extractTemporalConstraint("last week", NOW);
      expect(result).not.toBeNull();
      expect(result!.cleanedQuery).toBe("");
    });

    it("'last 3 days' takes priority over 'last' in 'last week' pattern", () => {
      const result = extractTemporalConstraint("show me the last 3 days of data", NOW);
      expect(result).not.toBeNull();
      expect(result!.originalExpression).toBe("last 3 days");
    });

    it("case insensitive matching", () => {
      const result = extractTemporalConstraint("what happened LAST WEEK", NOW);
      expect(result).not.toBeNull();
      expect(result!.originalExpression).toBe("LAST WEEK");
    });

    it("'last' as in 'last March' does not match 'last week' pattern", () => {
      const result = extractTemporalConstraint("meeting last March", NOW);
      expect(result).not.toBeNull();
      // Should match named month pattern, not relative period
      expect(result!.originalExpression).toBe("last March");
      expect(d(result!.startDate).getMonth()).toBe(2); // March
    });
  });

  // =========================================================================
  // CleanedQuery stripping
  // =========================================================================

  describe("cleanedQuery stripping", () => {
    it("strips temporal from middle of query", () => {
      const result = extractTemporalConstraint(
        "what did we discuss last week about deployment",
        NOW,
      );
      expect(result).not.toBeNull();
      expect(result!.cleanedQuery).toBe("what did we discuss about deployment");
    });

    it("strips temporal from start of query", () => {
      const result = extractTemporalConstraint("yesterday we talked about bugs", NOW);
      expect(result).not.toBeNull();
      expect(result!.cleanedQuery).toBe("we talked about bugs");
    });

    it("strips temporal from end of query", () => {
      const result = extractTemporalConstraint("deployment issues last month", NOW);
      expect(result).not.toBeNull();
      expect(result!.cleanedQuery).toBe("deployment issues");
    });
  });
});
