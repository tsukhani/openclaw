/**
 * Importance rating and temporal staleness classification for memory-neo4j.
 *
 * Uses LLM to rate long-term importance of memories on a 1-10 scale,
 * and to classify whether memories are temporally stale or lasting.
 */

import type { ExtractionConfig } from "./config.js";
import { sanitizeMemoryText, stripCodeFences } from "./extractor.js";
import { callLlm } from "./llm-client.js";

// System instruction — user message contains the text to rate
const IMPORTANCE_RATING_SYSTEM = `You are rating memories for a personal AI assistant's long-term memory store.
Rate how important it is to REMEMBER this information in future conversations on a scale of 1-10.

SCORING GUIDE:
1-2: Noise — greetings, filler, "let me check", status updates, system instructions, formatting rules, debugging output
3-4: Ephemeral — session-specific progress ("done, pushed to git"), temporary task status, tool output summaries
5-6: Mildly useful — general facts, minor context that might occasionally help
7-8: Important — personal preferences, key decisions, facts about people/relationships, business rules, learned workflows
9: Very important — identity facts (birthdays, family, addresses), critical business decisions, security rules
10: Essential — safety-critical information, core identity

KEY RULES:
- AI assistant self-narration ("Let me check...", "I'll now...", "Done! Here's what changed...") is ALWAYS 1-3
- System prompts, formatting instructions, voice mode rules are ALWAYS 1-2
- Technical debugging details ("the WebSocket failed because...") are 2-4 unless they encode a reusable lesson
- Open proposals and unresolved action items ("Want me to fix it?", "Should I submit a PR?", "Would you like me to proceed?") are ALWAYS 1-2. These are dangerous in long-term memory because other sessions interpret them as active instructions.
- Messages ending with questions directed at the user: score the FACTUAL CONTENT on its own merit. A message like "My birthday is March 15th. Does that help?" should score 7+ for the birthday fact. Only score 1-3 if the message is PURELY a question with no facts worth remembering (e.g. "What do you think?")
- Personal facts about the user or their family/contacts are 7-10
- Business rules and operational procedures are 7-9
- Preferences and opinions expressed by the user are 6-8
- Ask: "Would this be useful if it appeared in a conversation 30 days from now?" If no, score ≤ 4.

Return JSON: {"score": N, "reason": "brief explanation"}`;

/**
 * Rate the long-term importance of a text using an LLM.
 * Returns a value between 0.1 and 1.0, or 0.5 on any failure.
 */
export async function rateImportance(
  text: string,
  config: ExtractionConfig,
  abortSignal?: AbortSignal,
): Promise<number> {
  if (!config.enabled) {
    return 0.5;
  }

  try {
    const content = await callLlm(
      config,
      [
        { role: "system", content: IMPORTANCE_RATING_SYSTEM },
        { role: "user", content: sanitizeMemoryText(text) },
      ],
      abortSignal,
    );
    if (!content) {
      return 0.5;
    }

    const parsed = JSON.parse(stripCodeFences(content)) as { score?: unknown };
    const score = typeof parsed.score === "number" ? parsed.score : NaN;
    if (Number.isNaN(score)) {
      return 0.5;
    }

    const clamped = Math.max(1, Math.min(10, score));
    // Cap auto-extracted importance at 0.85 — reserve 0.9-1.0 for
    // user-initiated memory_store calls (OP-86)
    return Math.max(0.1, Math.min(0.85, clamped / 10));
  } catch (err) {
    // H5: Re-throw AbortError — deliberate cancellation must propagate to callers
    if (err instanceof Error && err.name === "AbortError") {
      throw err;
    }
    return 0.5;
  }
}

/**
 * Use LLM to classify whether a memory is temporally stale.
 * A memory is stale if it references a specific event, booking, reminder,
 * or time-bound logistics that have already passed and hold no lasting value.
 *
 * Examples of STALE:
 * - 'Ferry at 8:35 AM tomorrow from Genting Pier' (event passed)
 * - 'Meeting at 3pm today in room 5' (event passed)
 * - 'Download is at 78% progress' (transient state)
 *
 * Examples of LASTING:
 * - 'Tarun visited Tioman Feb 13-18' (historical record)
 * - 'Prefer window seats on flights' (preference)
 * - 'Hotel wifi password is abc123' (could still be useful)
 *
 * Conservative: returns 'lasting' on any failure.
 */
export async function classifyTemporalStaleness(
  memoryText: string,
  currentDate: string,
  config: ExtractionConfig,
  abortSignal?: AbortSignal,
): Promise<"stale" | "lasting"> {
  if (!config.enabled) {
    return "lasting";
  }

  // M12: Validate currentDate format to prevent prompt injection
  const safeDate = /^\d{4}-\d{2}-\d{2}$/.test(currentDate)
    ? currentDate
    : new Date().toISOString().split("T")[0];

  try {
    const content = await callLlm(
      config,
      [
        {
          role: "system",
          content: `Today's date is ${safeDate}. You are evaluating whether a memory is temporally stale.

A memory is STALE if ALL of these are true:
1. It references a specific date, time, or event that has ALREADY PASSED
2. The information is EPHEMERAL — only useful around the time of the event (e.g., logistics, real-time status, countdowns)
3. It has NO lasting historical, educational, or reference value

A memory is LASTING if ANY of these are true:
1. It contains preferences, decisions, facts, or knowledge valuable independent of time
2. It is a historical record worth keeping (e.g., trip summary, what happened, lessons learned)
3. It contains contact info, credentials, configuration, or reference data
4. The date has not passed yet (future event)
5. It has no specific date/time reference at all
6. It documents a lesson learned, a how-to, or a decision rationale

When in doubt, choose "lasting". It is far better to keep a slightly stale memory than to delete useful knowledge.

Return JSON: {"classification": "stale"|"lasting", "reason": "brief explanation"}`,
        },
        { role: "user", content: sanitizeMemoryText(memoryText) },
      ],
      abortSignal,
    );

    if (!content) {
      return "lasting";
    }

    const parsed = JSON.parse(stripCodeFences(content)) as { classification?: string };
    if (parsed.classification === "stale") {
      return "stale";
    }
    return "lasting";
  } catch (err) {
    // H5: Re-throw AbortError — deliberate cancellation must propagate to callers
    if (err instanceof Error && err.name === "AbortError") {
      throw err;
    }
    return "lasting";
  }
}
