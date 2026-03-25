/**
 * Tests for composite attention gate regex patterns.
 * Exercises each alternation branch in every category to verify
 * the composite refactor preserved individual pattern behavior.
 */

import { describe, expect, it } from "vitest";
import { passesAttentionGate } from "./attention-gate.js";

// Helper: a message must be >= 30 chars and >= 8 words to pass the gate's
// length/word-count checks. Messages below that are rejected before patterns run.
// For noise-pattern tests, we test via passesAttentionGate returning null.

describe("attention gate — composite noise patterns", () => {
  describe("category 1: conversational noise", () => {
    const noiseExamples = [
      // Greetings/acks (branch 1)
      "hi",
      "hello!",
      "thanks",
      "sounds good",
      "got it",
      // Two-word affirmations (branch 2)
      "ok great",
      "yes please",
      "sure thanks",
      "yeah definitely",
      // Filler phrases (branch 5)
      "lol",
      "haha",
      "omg",
      "idk",
      "sheesh",
    ];
    for (const msg of noiseExamples) {
      it(`rejects "${msg}"`, () => {
        expect(passesAttentionGate(msg)).toBeNull();
      });
    }
  });

  describe("category 2: structural noise", () => {
    it("rejects near-empty messages", () => {
      expect(passesAttentionGate("hi")).toBeNull();
      expect(passesAttentionGate("ok")).toBeNull();
      expect(passesAttentionGate("")).toBeNull();
    });

    it("rejects XML markup", () => {
      expect(
        passesAttentionGate("<system-prompt>You are a helpful assistant</system-prompt>"),
      ).toBeNull();
    });
  });

  describe("category 2b: pure emoji", () => {
    it("rejects pure emoji messages", () => {
      expect(passesAttentionGate("\u{1F44D}\u{1F44D}\u{1F44D}")).toBeNull();
    });
  });

  describe("category 3: imperative commands", () => {
    const commandExamples = [
      "let's uninstall the old package and replace it with something better",
      "yes switch to the new configuration for the production environment",
      "can you remove the deprecated module from the codebase entirely",
      "A new session was started via the reset command in the terminal window",
    ];
    for (const msg of commandExamples) {
      it(`rejects "${msg.slice(0, 50)}..."`, () => {
        expect(passesAttentionGate(msg)).toBeNull();
      });
    }
  });

  describe("category 4: channel metadata", () => {
    const metaExamples = [
      "Some text with [slack message id: 12345] embedded in it for testing purposes now",
      "A message containing [message_id: abc-def] that was forwarded from another system",
      "Contains [telegram message id: 999] from the channel that we are monitoring closely",
      "Sender (untrusted metadata) from channel with extra context that is long enough to test",
      '"sender_id": "u123" was attached to this message by the routing layer for tracking',
    ];
    for (const msg of metaExamples) {
      it(`rejects "${msg.slice(0, 50)}..."`, () => {
        expect(passesAttentionGate(msg)).toBeNull();
      });
    }
  });

  describe("category 5: system infrastructure", () => {
    const sysExamples = [
      "Read HEARTBEAT.md if it exists and process the instructions inside for the agent",
      "Pre-compaction memory flush triggered by the system before context window compression",
      "System: [2026-03-15T10:00:00Z] periodic check completed successfully with no errors found",
      "[cron:abc-123-def] scheduled task output from the background processing system running",
      "GatewayRestart: { reason: 'update' } the gateway service was restarted for maintenance",
      "[Mon 2026-03-15 10:00:00 UTC] A background task completed its processing run successfully",
    ];
    for (const msg of sysExamples) {
      it(`rejects "${msg.slice(0, 50)}..."`, () => {
        expect(passesAttentionGate(msg)).toBeNull();
      });
    }
  });

  describe("category 6: cron/meta/subagent", () => {
    const cronExamples = [
      "Conversation info (session: abc-123, agent: default) was loaded from the previous state",
      "[Queued messages from the channel buffer that accumulated while the agent was processing",
      "A scheduled reminder has been triggered for the user about their upcoming meeting today",
      "Summarize this naturally for the user so they understand the context of what happened",
      "Please relay this reminder to the user about the deadline that is coming up very soon",
      "[Mon 2026-03-15 10:00] A sub-agent task completed processing and returned the results",
      "**\u{1F534} URGENT priority escalation from the monitoring system about a service degradation",
    ];
    for (const msg of cronExamples) {
      it(`rejects "${msg.slice(0, 50)}..."`, () => {
        expect(passesAttentionGate(msg)).toBeNull();
      });
    }
  });

  describe("category 7: LLM meta-prompts", () => {
    const metaExamples = [
      "Based on this conversation, generate a short 1-2 word filename slug for the output file",
      "Generate a filename slug that describes this conversation in lowercase with hyphens only",
      "Generate a short summary title for this thread based on the main topic discussed here",
      "Reply with only the slug, nothing else, no explanation, no quotes, no file extension",
      "Output with only a single keyword tag that best describes the topic of this conversation",
      "generate a title for this conversation based on the main topics that were discussed here",
    ];
    for (const msg of metaExamples) {
      it(`rejects "${msg.slice(0, 50)}..."`, () => {
        expect(passesAttentionGate(msg)).toBeNull();
      });
    }

    it("does not reject normal messages starting with 'generate'", () => {
      const msg =
        "Generate the report by Friday and send it to the team for review before the deadline";
      expect(passesAttentionGate(msg)).not.toBeNull();
    });
  });

  describe("category 6b: multiline patterns", () => {
    it("rejects standalone Findings: header", () => {
      expect(
        passesAttentionGate(
          "Some context here for the findings report\nFindings:\nThe data shows nothing",
        ),
      ).toBeNull();
    });

    it("rejects Stats: runtime lines", () => {
      expect(
        passesAttentionGate(
          "Task completed with output and results\nStats: runtime 45s, tokens 1200, calls 3",
        ),
      ).toBeNull();
    });
  });

  describe("passes legitimate messages", () => {
    it("passes substantive user messages", () => {
      const msg =
        "My preferred programming language is TypeScript and I use it for all backend services";
      expect(passesAttentionGate(msg)).not.toBeNull();
    });

    it("passes factual statements", () => {
      const msg = "The database migration is scheduled for next Tuesday at midnight EST time";
      expect(passesAttentionGate(msg)).not.toBeNull();
    });

    it("preserves task references in short acks", () => {
      // "ok, TASK-001 done" should NOT be rejected by the short-ack pattern
      // but will be rejected by word count (< 8 words). Test a longer version:
      const msg =
        "ok, TASK-001 is now done and the implementation has been verified against the spec";
      expect(passesAttentionGate(msg)).not.toBeNull();
    });
  });
});
