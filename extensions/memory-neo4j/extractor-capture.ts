/**
 * Heuristic pre-filter for auto-capture in memory-neo4j.
 *
 * Provides fast noise rejection for messages before they reach the
 * LLM-based attention gate, filtering out greetings, filler, system
 * markup, code dumps, JSON blobs, and repetitive content.
 */

/**
 * Noise pattern constants for the heuristic pre-filter.
 * Exported for unit testing.
 */
export const NOISE_PATTERNS = {
  /** Single-word acknowledgements — full message match, optional trailing punctuation. */
  GREETING_WORD:
    /^(ok|sure|thanks|yes|no|done|noted|cool|nice|great|yep|nope|gotcha|alright)[.!?]*$/i,
  /** Filler phrases with optional trailing particle and/or punctuation — full message match. */
  FILLER_PHRASE:
    /^(let me check|one moment|working on it|got it|on it|will do|no problem|sounds good)(\s+(lah|lor|meh|ah))?[.!?]*$/i,
  /** Standalone Malaysian particles — full message match. */
  PARTICLE: /^(lah|lor|meh|ah)[.!?]*$/i,
  /** System markup markers — starts-with match (message may be longer). */
  SYSTEM_MARKUP:
    /^(HEARTBEAT_OK|NO_REPLY|<function|tool_call|`tool|\[Inter-session message\]|\[Queued messages)/,
  /** Tool output patterns — matched against any line in the message (multiline). */
  TOOL_OUTPUT: /^\(Command exited with code|^HTTP\/1\.[01] |^\$ \w/m,
} as const;

/**
 * Heuristic pre-filter for the auto-capture attention gate.
 *
 * Returns false (reject) for messages that are obviously noise — no LLM call is made.
 * Rejection rules (OP-86):
 *   1. Too short (trimmed length < 15 chars)
 *   2. Greeting/filler/particle patterns
 *   3. System markup (HEARTBEAT_OK, NO_REPLY, <function, tool_call, etc.)
 *   4. Code dumps (>60% code-like lines AND >10 lines AND no prose punctuation)
 *   5. Pure JSON blob or XML declaration
 *   6. Tool output patterns (command exit, HTTP response, shell prompt)
 *   7. Repetitive content (single word/phrase repeated >=3 times)
 *
 * Exported for unit testing and wiring into the agent_end pipeline.
 */
export function shouldCapture(text: string): boolean {
  const trimmed = text.trim();

  // Rule 1: Too short
  if (trimmed.length < 15) {
    return false;
  }

  // Rule 2: Greeting/filler/particle patterns (full-message match)
  if (NOISE_PATTERNS.GREETING_WORD.test(trimmed)) {
    return false;
  }
  if (NOISE_PATTERNS.FILLER_PHRASE.test(trimmed)) {
    return false;
  }
  if (NOISE_PATTERNS.PARTICLE.test(trimmed)) {
    return false;
  }

  // Rule 3: System markup (starts-with)
  if (NOISE_PATTERNS.SYSTEM_MARKUP.test(trimmed)) {
    return false;
  }

  // Rule 5: Pure JSON blob — check before code-dump rule since JSON may span many lines
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(trimmed);
      return false; // valid JSON — obvious noise
    } catch {
      // Not valid JSON — continue checking
    }
  }

  // Pure XML declaration
  if (trimmed.startsWith("<?xml")) {
    return false;
  }

  // Rule 6: Tool output patterns (any line)
  if (NOISE_PATTERNS.TOOL_OUTPUT.test(trimmed)) {
    return false;
  }

  // Rule 7: Repetitive content — all tokens are the same word/phrase
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length >= 3) {
    const lower = tokens.map((t) => t.toLowerCase());
    const unique = new Set(lower);
    if (unique.size === 1) {
      return false;
    }
  }

  // Rule 4: Code dump — >60% of lines start with whitespace or code-special chars,
  // total lines >10, and no sentence-ending punctuation anywhere (would indicate prose)
  const lines = trimmed.split("\n");
  if (lines.length > 10) {
    const codeLineCount = lines.filter((l) => /^[\s\t]|^[{}[\]<>/|\\*#@!]/.test(l)).length;
    const codeFraction = codeLineCount / lines.length;
    const hasSentenceEnding = lines.some((l) => /[.!?]\s*$/.test(l.trim()));
    if (codeFraction > 0.6 && !hasSentenceEnding) {
      return false;
    }
  }

  return true;
}
