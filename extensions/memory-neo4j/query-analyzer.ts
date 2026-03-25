/**
 * Lightweight, regex-based temporal expression extractor for memory search queries.
 * Extracts date range constraints from natural language and returns cleaned queries
 * with temporal expressions stripped for better semantic search.
 *
 * Zero dependencies — pure regex, no dateparser or heavy NLP libs.
 */

// ============================================================================
// Types
// ============================================================================

export type TemporalConstraint = {
  startDate: string; // ISO-8601
  endDate: string; // ISO-8601
  originalExpression: string;
  cleanedQuery: string;
};

// ============================================================================
// Number Parsing
// ============================================================================

const WORD_TO_NUMBER: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
};

function parseNumber(s: string): number | null {
  const n = WORD_TO_NUMBER[s.toLowerCase()];
  if (n != null) return n;
  const parsed = parseInt(s, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

// ============================================================================
// Month Parsing
// ============================================================================

const MONTH_NAMES: Record<string, number> = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

function parseMonth(s: string): number | null {
  return MONTH_NAMES[s.toLowerCase()] ?? null;
}

// ============================================================================
// Date Helpers
// ============================================================================

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function endOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}

function startOfWeek(d: Date): Date {
  const day = d.getDay(); // 0=Sun
  const diff = day === 0 ? 6 : day - 1; // Monday-based week
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - diff);
  return startOfDay(start);
}

function endOfWeek(d: Date): Date {
  const s = startOfWeek(d);
  return endOfDay(new Date(s.getFullYear(), s.getMonth(), s.getDate() + 6));
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function endOfMonth(d: Date): Date {
  return endOfDay(new Date(d.getFullYear(), d.getMonth() + 1, 0));
}

function startOfYear(d: Date): Date {
  return new Date(d.getFullYear(), 0, 1);
}

function endOfYear(d: Date): Date {
  return endOfDay(new Date(d.getFullYear(), 11, 31));
}

// ============================================================================
// Pattern Definitions
// ============================================================================

type PatternMatcher = (query: string, now: Date) => TemporalMatch | null;

type TemporalMatch = {
  startDate: Date;
  endDate: Date;
  matchedText: string;
  matchIndex: number;
  matchLength: number;
};

// --- Pattern: 'yesterday', 'today', 'tomorrow' ---

const DAY_KEYWORD_RE = /\b(yesterday|today|tomorrow)\b/i;

function matchDayKeyword(query: string, now: Date): TemporalMatch | null {
  const m = DAY_KEYWORD_RE.exec(query);
  if (!m) return null;
  const word = m[1].toLowerCase();
  const base = startOfDay(now);
  let target: Date;
  if (word === "yesterday") {
    target = new Date(base.getFullYear(), base.getMonth(), base.getDate() - 1);
  } else if (word === "tomorrow") {
    target = new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1);
  } else {
    target = base;
  }
  return {
    startDate: startOfDay(target),
    endDate: endOfDay(target),
    matchedText: m[0],
    matchIndex: m.index,
    matchLength: m[0].length,
  };
}

// --- Pattern: 'last/this/next week/month/year' ---

const RELATIVE_PERIOD_RE = /\b(last|this|next)\s+(week|month|year)\b/i;

function matchRelativePeriod(query: string, now: Date): TemporalMatch | null {
  const m = RELATIVE_PERIOD_RE.exec(query);
  if (!m) return null;
  const modifier = m[1].toLowerCase();
  const unit = m[2].toLowerCase();

  let startDate: Date;
  let endDate: Date;

  if (unit === "week") {
    const base =
      modifier === "last"
        ? new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7)
        : modifier === "next"
          ? new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7)
          : now;
    startDate = startOfWeek(base);
    endDate = endOfWeek(base);
  } else if (unit === "month") {
    const offset = modifier === "last" ? -1 : modifier === "next" ? 1 : 0;
    const base = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    startDate = startOfMonth(base);
    endDate = endOfMonth(base);
  } else {
    // year
    const offset = modifier === "last" ? -1 : modifier === "next" ? 1 : 0;
    const base = new Date(now.getFullYear() + offset, 0, 1);
    startDate = startOfYear(base);
    endDate = endOfYear(base);
  }

  return {
    startDate,
    endDate,
    matchedText: m[0],
    matchIndex: m.index,
    matchLength: m[0].length,
  };
}

// --- Pattern: 'last N days/weeks/months', 'past N days/weeks/months' ---

const NUMBER_PATTERN = `(\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty)`;
const LAST_N_RE = new RegExp(
  `\\b(?:last|past)\\s+${NUMBER_PATTERN}\\s+(days?|weeks?|months?)\\b`,
  "i",
);

function matchLastN(query: string, now: Date): TemporalMatch | null {
  const m = LAST_N_RE.exec(query);
  if (!m) return null;
  const n = parseNumber(m[1]);
  if (n == null || n <= 0) return null;
  const unit = m[2].toLowerCase().replace(/s$/, "");

  let startDate: Date;
  if (unit === "day") {
    startDate = startOfDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - n));
  } else if (unit === "week") {
    startDate = startOfDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - n * 7));
  } else {
    startDate = startOfDay(new Date(now.getFullYear(), now.getMonth() - n, now.getDate()));
  }

  return {
    startDate,
    endDate: endOfDay(now),
    matchedText: m[0],
    matchIndex: m.index,
    matchLength: m[0].length,
  };
}

// --- Pattern: 'N days/weeks/months ago' ---

const AGO_RE = new RegExp(`\\b${NUMBER_PATTERN}\\s+(days?|weeks?|months?)\\s+ago\\b`, "i");

function matchAgo(query: string, now: Date): TemporalMatch | null {
  const m = AGO_RE.exec(query);
  if (!m) return null;
  const n = parseNumber(m[1]);
  if (n == null || n <= 0) return null;
  const unit = m[2].toLowerCase().replace(/s$/, "");

  let target: Date;
  if (unit === "day") {
    target = new Date(now.getFullYear(), now.getMonth(), now.getDate() - n);
  } else if (unit === "week") {
    target = new Date(now.getFullYear(), now.getMonth(), now.getDate() - n * 7);
  } else {
    target = new Date(now.getFullYear(), now.getMonth() - n, now.getDate());
  }

  // "N days ago" = that single day; "N weeks/months ago" = that single unit
  let startDate: Date;
  let endDate: Date;
  if (unit === "day") {
    startDate = startOfDay(target);
    endDate = endOfDay(target);
  } else if (unit === "week") {
    startDate = startOfWeek(target);
    endDate = endOfWeek(target);
  } else {
    startDate = startOfMonth(target);
    endDate = endOfMonth(target);
  }

  return {
    startDate,
    endDate,
    matchedText: m[0],
    matchIndex: m.index,
    matchLength: m[0].length,
  };
}

// --- Pattern: 'in January', 'in 2025', 'last March', 'next February' ---

const MONTH_LIST =
  "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec";
const IN_MONTH_RE = new RegExp(`\\bin\\s+(${MONTH_LIST})(?:\\s+(\\d{4}))?\\b`, "i");
const RELATIVE_MONTH_RE = new RegExp(`\\b(last|next)\\s+(${MONTH_LIST})\\b`, "i");
const IN_YEAR_RE = /\bin\s+(20\d{2})\b/i;

function matchNamedMonth(query: string, now: Date): TemporalMatch | null {
  // "in January" or "in January 2025"
  let m = IN_MONTH_RE.exec(query);
  if (m) {
    const month = parseMonth(m[1]);
    if (month == null) return null;
    const year = m[2] ? parseInt(m[2], 10) : now.getFullYear();
    const startDate = new Date(year, month, 1);
    const endDate = endOfMonth(startDate);
    return {
      startDate,
      endDate,
      matchedText: m[0],
      matchIndex: m.index,
      matchLength: m[0].length,
    };
  }

  // "last March", "next February"
  m = RELATIVE_MONTH_RE.exec(query);
  if (m) {
    const modifier = m[1].toLowerCase();
    const month = parseMonth(m[2]);
    if (month == null) return null;

    let year = now.getFullYear();
    if (modifier === "last") {
      // If the month hasn't occurred yet this year, go back an extra year
      if (month >= now.getMonth()) year--;
    } else {
      // next: if month already passed, go forward a year
      if (month <= now.getMonth()) year++;
    }

    const startDate = new Date(year, month, 1);
    const endDate = endOfMonth(startDate);
    return {
      startDate,
      endDate,
      matchedText: m[0],
      matchIndex: m.index,
      matchLength: m[0].length,
    };
  }

  return null;
}

function matchYear(query: string, _now: Date): TemporalMatch | null {
  const m = IN_YEAR_RE.exec(query);
  if (!m) return null;
  const year = parseInt(m[1], 10);
  return {
    startDate: startOfYear(new Date(year, 0, 1)),
    endDate: endOfYear(new Date(year, 0, 1)),
    matchedText: m[0],
    matchIndex: m.index,
    matchLength: m[0].length,
  };
}

// --- Pattern: 'before/after <date expression>' ---

const BEFORE_AFTER_RE = new RegExp(
  `\\b(before|after|since)\\s+(?:(${MONTH_LIST})\\s+(\\d{4})|(${MONTH_LIST})\\s+(\\d{1,2})(?:st|nd|rd|th)?|(${MONTH_LIST})|(yesterday|today|tomorrow)|${NUMBER_PATTERN}\\s+(days?|weeks?|months?)\\s+ago)\\b`,
  "i",
);

function matchBeforeAfter(query: string, now: Date): TemporalMatch | null {
  const m = BEFORE_AFTER_RE.exec(query);
  if (!m) return null;

  const direction = m[1].toLowerCase(); // before, after, since
  let pivotStart: Date;
  let pivotEnd: Date;

  if (m[2] && m[3]) {
    // "before/after January 2025"
    const month = parseMonth(m[2]);
    if (month == null) return null;
    const year = parseInt(m[3], 10);
    pivotStart = new Date(year, month, 1);
    pivotEnd = endOfMonth(pivotStart);
  } else if (m[4] && m[5]) {
    // "before/after March 15" or "March 15th"
    const month = parseMonth(m[4]);
    if (month == null) return null;
    const day = parseInt(m[5], 10);
    pivotStart = new Date(now.getFullYear(), month, day);
    pivotEnd = endOfDay(pivotStart);
  } else if (m[6]) {
    // "before/after January"
    const month = parseMonth(m[6]);
    if (month == null) return null;
    pivotStart = new Date(now.getFullYear(), month, 1);
    pivotEnd = endOfMonth(pivotStart);
  } else if (m[7]) {
    // "before/after yesterday/today/tomorrow"
    const word = m[7].toLowerCase();
    const base = startOfDay(now);
    if (word === "yesterday") {
      pivotStart = new Date(base.getFullYear(), base.getMonth(), base.getDate() - 1);
    } else if (word === "tomorrow") {
      pivotStart = new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1);
    } else {
      pivotStart = base;
    }
    pivotEnd = endOfDay(pivotStart);
  } else if (m[8] && m[9]) {
    // "before/after 3 days ago"
    const n = parseNumber(m[8]);
    if (n == null || n <= 0) return null;
    const unit = m[9].toLowerCase().replace(/s$/, "");
    if (unit === "day") {
      pivotStart = startOfDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - n));
    } else if (unit === "week") {
      pivotStart = startOfDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - n * 7));
    } else {
      pivotStart = startOfDay(new Date(now.getFullYear(), now.getMonth() - n, now.getDate()));
    }
    pivotEnd = endOfDay(pivotStart);
  } else {
    return null;
  }

  let startDate: Date;
  let endDate: Date;

  if (direction === "before") {
    // Far past to just before pivot
    startDate = new Date(2000, 0, 1);
    endDate = new Date(pivotStart.getTime() - 1);
  } else {
    // after/since: from pivot to now
    startDate = pivotStart;
    endDate = endOfDay(now);
  }

  return {
    startDate,
    endDate,
    matchedText: m[0],
    matchIndex: m.index,
    matchLength: m[0].length,
  };
}

// --- Pattern: 'between X and Y' ---

const BETWEEN_MONTH_RE = new RegExp(
  `\\bbetween\\s+(${MONTH_LIST})(?:\\s+(\\d{4}))?\\s+and\\s+(${MONTH_LIST})(?:\\s+(\\d{4}))?\\b`,
  "i",
);

function matchBetween(query: string, now: Date): TemporalMatch | null {
  const m = BETWEEN_MONTH_RE.exec(query);
  if (!m) return null;

  const month1 = parseMonth(m[1]);
  const month2 = parseMonth(m[3]);
  if (month1 == null || month2 == null) return null;

  const year1 = m[2] ? parseInt(m[2], 10) : now.getFullYear();
  const year2 = m[4] ? parseInt(m[4], 10) : now.getFullYear();

  const startDate = new Date(year1, month1, 1);
  const endDate = endOfMonth(new Date(year2, month2, 1));

  return {
    startDate,
    endDate,
    matchedText: m[0],
    matchIndex: m.index,
    matchLength: m[0].length,
  };
}

// ============================================================================
// Pattern Priority (ordered — first match wins)
// ============================================================================

// Order matters: more specific patterns first to avoid partial matches.
// "last 3 days" must match before "last" in "last week".
// "before January 2025" must match before "in January".
const PATTERNS: PatternMatcher[] = [
  matchBetween,
  matchBeforeAfter,
  matchLastN,
  matchAgo,
  matchDayKeyword,
  matchRelativePeriod,
  matchNamedMonth,
  matchYear,
];

// ============================================================================
// Main Extractor
// ============================================================================

/**
 * Extract a temporal constraint from a natural language query.
 *
 * Returns the date range and a cleaned query with the temporal expression removed
 * for better semantic search. Returns null if no temporal expression is found.
 *
 * @param query - The search query string
 * @param now - Reference date for resolving relative expressions (default: current time)
 */
export function extractTemporalConstraint(query: string, now?: Date): TemporalConstraint | null {
  const refDate = now ?? new Date();

  for (const pattern of PATTERNS) {
    const match = pattern(query, refDate);
    if (match) {
      // Strip matched text and clean up whitespace
      const cleaned =
        query.slice(0, match.matchIndex) + query.slice(match.matchIndex + match.matchLength);
      const cleanedQuery = cleaned.replace(/\s{2,}/g, " ").trim();

      return {
        startDate: match.startDate.toISOString(),
        endDate: match.endDate.toISOString(),
        originalExpression: match.matchedText,
        cleanedQuery,
      };
    }
  }

  return null;
}
