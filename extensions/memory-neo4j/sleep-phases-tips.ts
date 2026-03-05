/**
 * Sleep cycle Phase 8 — tip generation from session failure patterns.
 *
 * Scans recent session logs for failure+correction patterns and stores
 * reusable lesson memories (category: "lesson") inspired by the EMPO² paper.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ExtractionConfig } from "./config.js";
import type { Embeddings } from "./embeddings.js";
import { stripCodeFences } from "./extractor.js";
import { callOpenRouter } from "./llm-client.js";
import type { Neo4jMemoryClient } from "./neo4j-client.js";
import type { Logger } from "./schema.js";
import type { SleepCycleOptions, SleepCycleResult } from "./sleep-cycle-types.js";

// ============================================================================
// Tip Generation Prompt
// ============================================================================

const TIP_GENERATION_SYSTEM = `You are analyzing an AI assistant's session logs to extract reusable lessons learned from failures and corrections.

Given a list of failure patterns (tool errors + the agent's subsequent correction), generate actionable lesson memories.

A lesson memory should:
1. Be a clear, reusable rule: "When doing X, use Y approach instead of Z because [reason]"
2. Be specific enough to be immediately actionable (not vague platitudes)
3. Be self-contained — write in second person ("When you...")
4. Focus on the CORRECTION, not just the failure

Return JSON:
{
  "tips": [
    {
      "text": "When sending Telegram voice messages, first save the .opus file to the workspace directory (not /tmp) before sending — /tmp is not in the allowed media directory list and will cause an error.",
      "importance": 0.85
    }
  ]
}

Rules:
- Only generate a tip if the failure + correction reveals a REUSABLE lesson (not a one-time fix)
- Importance 0.7-0.9 for good lessons; 0.9+ for critical ones that prevent data loss or broken workflows
- Skip trivial failures (file not found, typos, etc.) unless there is a pattern worth learning
- Maximum 5 tips per call
- If no valuable lessons can be extracted, return {"tips": []}`;

// ============================================================================
// Session failure pattern extraction helper
// ============================================================================

/**
 * Parse a session JSONL file and extract failure+correction patterns.
 * A failure pattern is a toolResult with an error/non-zero exit code followed
 * by an assistant message that corrected the approach.
 */
async function extractFailurePatterns(
  sessionPath: string,
  maxPatterns: number,
): Promise<Array<{ failure: string; correction: string }>> {
  const patterns: Array<{ failure: string; correction: string }> = [];

  let fileContent: string;
  try {
    fileContent = await fs.readFile(sessionPath, "utf-8");
  } catch {
    return [];
  }

  const lines = fileContent.split("\n").filter((l) => l.trim());
  const messages: Array<{ role: string; content: string }> = [];

  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (obj.type !== "message") continue;

      const msg = obj.message as Record<string, unknown>;
      if (!msg || typeof msg !== "object") continue;

      const role = String(msg.role ?? "");

      if (role === "toolResult") {
        const content = msg.content as Array<Record<string, unknown>> | undefined;
        const details = msg.details as Record<string, unknown> | undefined;
        const toolName = String(msg.toolName ?? "");

        const contentText = Array.isArray(content)
          ? content
              .filter((c) => c.type === "text")
              .map((c) => String(c.text ?? ""))
              .join("\n")
              .slice(0, 500)
          : "";

        const exitCode = typeof details?.exitCode === "number" ? details.exitCode : null;
        const hasError = Boolean(details?.error) || (exitCode !== null && exitCode !== 0);
        const hasErrorText =
          contentText.toLowerCase().includes("error") ||
          contentText.toLowerCase().includes("failed") ||
          contentText.toLowerCase().includes("permission denied") ||
          contentText.toLowerCase().includes("no such file") ||
          contentText.toLowerCase().includes("not found") ||
          contentText.toLowerCase().includes("command not found");

        if (hasError || hasErrorText) {
          messages.push({
            role: "failure",
            content: `Tool: ${toolName}\nError: ${contentText}`,
          });
        }
      } else if (role === "assistant") {
        const content = msg.content as Array<Record<string, unknown>> | undefined;
        if (!Array.isArray(content)) continue;

        const textContent = content
          .filter((c) => c.type === "text")
          .map((c) => String(c.text ?? ""))
          .join("\n")
          .slice(0, 400);

        const toolCalls = content
          .filter((c) => c.type === "toolCall")
          .map((c) => {
            const args = c.arguments as Record<string, unknown> | undefined;
            const argsStr = args ? JSON.stringify(args).slice(0, 200) : "";
            return `${String(c.name ?? "tool")}: ${argsStr}`;
          })
          .join("; ");

        const combined = [textContent, toolCalls ? `Tools: ${toolCalls}` : ""]
          .filter(Boolean)
          .join("\n")
          .slice(0, 600);

        if (combined) {
          messages.push({ role: "assistant", content: combined });
        }
      }
    } catch {
      // Skip malformed lines
    }
  }

  // Find failure + correction pairs
  for (let i = 0; i < messages.length - 1 && patterns.length < maxPatterns; i++) {
    const current = messages[i];
    const next = messages[i + 1];
    if (current.role === "failure" && next.role === "assistant") {
      patterns.push({ failure: current.content, correction: next.content });
    }
  }

  return patterns;
}

// ============================================================================
// Phase 8: Tip Generation
// ============================================================================

export async function runTipGeneration(
  db: Neo4jMemoryClient,
  embeddings: Embeddings,
  config: ExtractionConfig,
  logger: Logger,
  options: SleepCycleOptions,
  result: SleepCycleResult,
): Promise<void> {
  const {
    agentId,
    abortSignal,
    skipTipGeneration = false,
    tipGenMaxSessionAgeDays = 7,
    tipGenMaxFailures = 50,
    onPhaseStart,
    onProgress,
  } = options;

  if (abortSignal?.aborted) return;

  if (!config.enabled) {
    logger.info("memory-neo4j: [sleep] Phase 8 skipped — extraction not enabled");
    return;
  }
  if (skipTipGeneration) {
    logger.info("memory-neo4j: [sleep] Phase 8 skipped — tip generation disabled");
    return;
  }

  onPhaseStart?.("tipGeneration");
  logger.info("memory-neo4j: [sleep] Phase 8: Tip Generation");

  try {
    const home = process.env.OPENCLAW_HOME?.trim() || process.env.HOME || "";
    const agentDirId = agentId ?? "main";
    const sessionsDir = path.join(home, ".openclaw", "agents", agentDirId, "sessions");

    let sessionFiles: string[] = [];
    try {
      const entries = await fs.readdir(sessionsDir);
      const cutoff = Date.now() - tipGenMaxSessionAgeDays * 24 * 60 * 60 * 1000;
      const stats = await Promise.allSettled(
        entries
          .filter((e) => e.endsWith(".jsonl"))
          .map(async (e) => {
            const fullPath = path.join(sessionsDir, e);
            const stat = await fs.stat(fullPath);
            return { path: fullPath, mtime: stat.mtimeMs };
          }),
      );
      sessionFiles = stats
        .filter(
          (r): r is PromiseFulfilledResult<{ path: string; mtime: number }> =>
            r.status === "fulfilled",
        )
        .filter((r) => r.value.mtime >= cutoff)
        .sort((a, b) => b.value.mtime - a.value.mtime)
        .map((r) => r.value.path);
    } catch {
      logger.info("memory-neo4j: [sleep] Phase 8: sessions dir not found, skipping");
    }

    if (sessionFiles.length > 0) {
      result.tipGeneration.sessionsScanned = sessionFiles.length;
      onProgress?.("tipGeneration", `Scanning ${sessionFiles.length} recent sessions`);

      const allPatterns: Array<{ failure: string; correction: string }> = [];
      for (const sessionFile of sessionFiles) {
        if (abortSignal?.aborted) break;
        const patterns = await extractFailurePatterns(sessionFile, tipGenMaxFailures);
        allPatterns.push(...patterns);
        if (allPatterns.length >= tipGenMaxFailures) break;
      }

      result.tipGeneration.failurePatternsFound = allPatterns.length;

      if (allPatterns.length > 0) {
        onProgress?.(
          "tipGeneration",
          `Found ${allPatterns.length} failure patterns — generating tips`,
        );

        // Phase 1: Collect all tip objects from all LLM batches (no embedding yet)
        const collectedTips: Array<{ text: string; importance: number }> = [];

        const BATCH_SIZE = 10;
        for (let i = 0; i < allPatterns.length && !abortSignal?.aborted; i += BATCH_SIZE) {
          const batch = allPatterns.slice(i, i + BATCH_SIZE);
          const promptContent = batch
            .map(
              (p, idx) => `Pattern ${idx + 1}:\nFAILURE: ${p.failure}\nCORRECTION: ${p.correction}`,
            )
            .join("\n\n---\n\n");

          try {
            const content = await callOpenRouter(
              config,
              [
                { role: "system", content: TIP_GENERATION_SYSTEM },
                { role: "user", content: promptContent },
              ],
              abortSignal,
            );

            if (!content) continue;

            // Use stripCodeFences before JSON.parse — some models wrap JSON in ``` fences.
            // Without this, a SyntaxError would be silently swallowed and the whole batch dropped.
            const parsed = JSON.parse(stripCodeFences(content)) as { tips?: unknown };
            const rawTips = Array.isArray(parsed.tips) ? parsed.tips : [];

            for (const tip of rawTips) {
              if (abortSignal?.aborted) break;
              if (
                !tip ||
                typeof tip !== "object" ||
                typeof (tip as Record<string, unknown>).text !== "string"
              )
                continue;

              const tipObj = tip as Record<string, unknown>;
              const text = String(tipObj.text).trim();
              if (!text || text.length < 20) continue;

              const importance =
                typeof tipObj.importance === "number"
                  ? Math.min(1.0, Math.max(0.1, tipObj.importance))
                  : 0.8;

              collectedTips.push({ text, importance });
            }
          } catch (err) {
            // Log parse/LLM failures so dropped batches are visible in logs
            logger.warn(
              `memory-neo4j: [sleep] Phase 8: tip batch failed (batch ${Math.floor(i / BATCH_SIZE) + 1}): ${String(err)}`,
            );
          }
        }

        result.tipGeneration.tipsGenerated = collectedTips.length;

        // Phase 2: Batch-embed all tip texts in one call (OP-107).
        // Then batch-store all tips in a single UNWIND statement.
        // This reduces up to 50×3 serial roundtrips to 2 operations.
        if (collectedTips.length > 0 && !abortSignal?.aborted) {
          let tipEmbeddings: number[][];
          try {
            tipEmbeddings = await embeddings.embedBatch(collectedTips.map((t) => t.text));
          } catch (embedErr) {
            logger.warn(
              `memory-neo4j: [sleep] Phase 8: embedBatch failed — tips not stored this cycle: ${String(embedErr)}`,
            );
            tipEmbeddings = [];
          }

          const toStore = collectedTips
            .map((tip, idx) => ({
              tip,
              embedding: tipEmbeddings[idx] ?? [],
            }))
            .filter(({ embedding }) => embedding.length > 0)
            .map(({ tip, embedding }) => ({
              id: randomUUID(),
              text: tip.text,
              embedding,
              importance: tip.importance,
              category: "lesson" as const,
              source: "auto-capture-assistant" as const,
              extractionStatus: "pending" as const,
              agentId: agentId ?? "main",
            }));

          if (toStore.length > 0) {
            try {
              const stored = await db.storeManyMemories(toStore);
              result.tipGeneration.tipsStored += stored;
              onProgress?.(
                "tipGeneration",
                `Stored ${stored} lessons from ${collectedTips.length} generated tips`,
              );
            } catch {
              // Skip on storage failure
            }
          }
        }
      } else {
        onProgress?.("tipGeneration", "No failure patterns found in recent sessions");
      }
    } else {
      onProgress?.("tipGeneration", "No recent sessions to scan");
    }

    logger.info(
      `memory-neo4j: [sleep] Phase 8 complete — ${result.tipGeneration.sessionsScanned} sessions, ${result.tipGeneration.failurePatternsFound} patterns, ${result.tipGeneration.tipsStored} tips stored`,
    );
  } catch (err) {
    logger.warn(`memory-neo4j: [sleep] Phase 8 error: ${String(err)}`);
  }
}
