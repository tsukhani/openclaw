/**
 * Sleep cycle Phase 6-7 group — task lifecycle management.
 *
 * - classifyTaskMemory: LLM-based memory classification (lasting vs noise)
 * - Phase 6: Task ledger cleanup (archive stale tasks in TASKS.md)
 * - Phase 7: Task-memory cleanup (remove task-noise memories for completed tasks)
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { ExtractionConfig } from "./config.js";
import { stripCodeFences } from "./extractor.js";
import { callLlm } from "./llm-client.js";
import type { Neo4jMemoryClient } from "./neo4j-client.js";
import type { Logger } from "./schema.js";
import type { SleepCycleOptions, SleepCycleResult } from "./sleep-cycle-types.js";
import { parseTaskLedger, reviewAndArchiveStaleTasks } from "./task-ledger.js";

// ============================================================================
// Task-Memory Classification (shared helper)
// ============================================================================

/**
 * Use LLM to classify whether a memory is "lasting" (valuable independent
 * of the completed task) or "noise" (only useful while the task was active).
 *
 * Conservative: returns "lasting" on any failure to avoid deleting valuable memories.
 */
export async function classifyTaskMemory(
  memoryText: string,
  taskTitle: string,
  config: ExtractionConfig,
  abortSignal?: AbortSignal,
): Promise<"lasting" | "noise"> {
  if (!config.enabled) {
    return "lasting";
  }

  try {
    const safeTitle = taskTitle
      .replace(/[`"'\n\r]/g, " ")
      .trim()
      .slice(0, 200);
    const content = await callLlm(
      config,
      [
        {
          role: "system",
          content: `A task titled "${safeTitle}" has been completed. The following memory was created during this task.

Classify this memory:
- "lasting" if it contains a decision, preference, fact, or knowledge that is valuable INDEPENDENT of the task
- "noise" if it contains task progress, debugging steps, intermediate state, or context that is only useful while the task was active

When in doubt, choose "lasting". It is better to keep some noise than to delete valuable knowledge.

Return JSON: {"classification": "lasting"|"noise", "reason": "brief explanation"}`,
        },
        { role: "user", content: memoryText },
      ],
      abortSignal,
    );

    if (!content) {
      return "lasting";
    }

    const parsed = JSON.parse(stripCodeFences(content)) as { classification?: string };
    if (parsed.classification === "noise") {
      return "noise";
    }
    return "lasting";
  } catch {
    // On any failure, keep the memory (conservative)
    return "lasting";
  }
}

// ============================================================================
// Phase 6: Task Ledger Cleanup
// ============================================================================

export async function runTaskLedger(
  db: Neo4jMemoryClient,
  logger: Logger,
  options: SleepCycleOptions,
  result: SleepCycleResult,
): Promise<void> {
  const { abortSignal, workspaceDir, staleTaskMaxAgeMs, onPhaseStart, onProgress } = options;

  // db is not used in this phase (TASKS.md is filesystem-only), but kept for signature consistency.
  void db;

  if (abortSignal?.aborted) return;

  if (!workspaceDir) {
    logger.info("memory-neo4j: [sleep] Phase 6: Task Ledger Cleanup — SKIPPED (no workspace dir)");
    return;
  }

  onPhaseStart?.("taskLedger");
  logger.info("memory-neo4j: [sleep] Phase 6: Task Ledger Cleanup");

  try {
    const staleResult = await reviewAndArchiveStaleTasks(workspaceDir, staleTaskMaxAgeMs);

    if (staleResult) {
      result.taskLedger.staleCount = staleResult.staleCount;
      result.taskLedger.archivedCount = staleResult.archivedCount;
      result.taskLedger.archivedIds = staleResult.archivedIds;

      if (staleResult.archivedCount > 0) {
        onProgress?.(
          "taskLedger",
          `Archived ${staleResult.archivedCount} stale tasks: ${staleResult.archivedIds.join(", ")}`,
        );
      } else {
        onProgress?.("taskLedger", "No stale tasks found");
      }
    } else {
      onProgress?.("taskLedger", "TASKS.md not found — skipped");
    }

    logger.info(
      `memory-neo4j: [sleep] Phase 6 complete — ${result.taskLedger.archivedCount} stale tasks archived`,
    );
  } catch (err) {
    logger.warn(`memory-neo4j: [sleep] Phase 6 error: ${String(err)}`);
  }
}

// ============================================================================
// Phase 7: Task-Memory Cleanup
// ============================================================================

export async function runTaskMemoryCleanup(
  db: Neo4jMemoryClient,
  config: ExtractionConfig,
  logger: Logger,
  options: SleepCycleOptions,
  result: SleepCycleResult,
): Promise<void> {
  const {
    agentId,
    abortSignal,
    workspaceDir,
    skipTaskMemoryCleanup = false,
    taskMemoryMaxAgeDays = 7,
    llmConcurrency = 8,
    onPhaseStart,
    onProgress,
  } = options;

  if (abortSignal?.aborted) return;

  if (!workspaceDir) {
    logger.info("memory-neo4j: [sleep] Phase 7: Task-Memory Cleanup — SKIPPED (no workspace dir)");
    return;
  }
  if (!config.enabled) {
    logger.info(
      "memory-neo4j: [sleep] Phase 7: Task-Memory Cleanup — SKIPPED (extraction not enabled)",
    );
    return;
  }
  if (skipTaskMemoryCleanup) {
    logger.info("memory-neo4j: [sleep] Phase 7: Task-Memory Cleanup — SKIPPED (disabled)");
    return;
  }

  onPhaseStart?.("taskMemoryCleanup");
  logger.info("memory-neo4j: [sleep] Phase 7: Task-Memory Cleanup");

  try {
    const tasksPath = path.join(workspaceDir, "TASKS.md");
    let tasksContent: string | null = null;
    try {
      tasksContent = await fs.readFile(tasksPath, "utf-8");
    } catch {
      // TASKS.md doesn't exist — skip
    }

    if (tasksContent) {
      const ledger = parseTaskLedger(tasksContent);
      const now = new Date();
      const maxAgeMs = taskMemoryMaxAgeDays * 24 * 60 * 60 * 1000;

      // Filter to recently completed tasks (within maxAgeDays)
      const recentCompleted = ledger.completedTasks.filter((task) => {
        // Use the "Completed" field, "Updated" field, or "Started" field as date source
        const dateStr =
          task.details?.match(/Completed:\s*(\S+)/)?.[1] || task.updated || task.started;
        if (!dateStr) {
          return false;
        }
        // Try to parse date — accept formats like "2026-02-16", "2026-02-16 09:15"
        const cleaned = dateStr
          .trim()
          .replace(/\s+[A-Z]{2,5}$/, "")
          .replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/, "$1T$2");
        const date = new Date(cleaned);
        if (Number.isNaN(date.getTime())) {
          return false;
        }
        return now.getTime() - date.getTime() <= maxAgeMs;
      });

      result.taskMemoryCleanup.tasksChecked = recentCompleted.length;

      if (recentCompleted.length > 0) {
        onProgress?.(
          "taskMemoryCleanup",
          `Found ${recentCompleted.length} recently completed tasks to check`,
        );

        // Collect all memories to evaluate across all tasks (dedup by id)
        const memoriesToEvaluate = new Map<
          string,
          { id: string; text: string; category: string; taskTitle: string }
        >();

        // Build keyword lists for all tasks upfront, then search in parallel
        const taskKeywords = recentCompleted.map((task) => {
          const keywords = [task.id];
          const titleWords = task.title
            .split(/\s+/)
            .filter((w) => w.length > 3)
            .map((w) => w.replace(/[^a-zA-Z0-9-]/g, ""))
            .filter((w) => w.length > 3);
          keywords.push(...titleWords);
          return { task, keywords };
        });

        const searchOutcomes = await Promise.allSettled(
          taskKeywords.map(({ keywords }) => db.searchMemoriesByKeywords(keywords, 50, agentId)),
        );

        for (let i = 0; i < searchOutcomes.length; i++) {
          if (abortSignal?.aborted) break;
          const outcome = searchOutcomes[i];
          const { task } = taskKeywords[i];
          if (outcome.status !== "fulfilled") continue;

          for (const mem of outcome.value) {
            // Skip core memories — those are user-curated
            if (mem.category === "core") continue;
            if (!memoriesToEvaluate.has(mem.id)) {
              memoriesToEvaluate.set(mem.id, { ...mem, taskTitle: task.title });
            }
          }
        }

        // Classify memories in parallel batches using LLM
        const toEvaluate = [...memoriesToEvaluate.values()];
        result.taskMemoryCleanup.memoriesEvaluated = toEvaluate.length;

        if (toEvaluate.length > 0) {
          onProgress?.("taskMemoryCleanup", `Evaluating ${toEvaluate.length} memories with LLM`);
        }

        const toRemove: string[] = [];

        for (let i = 0; i < toEvaluate.length && !abortSignal?.aborted; i += llmConcurrency) {
          const batch = toEvaluate.slice(i, i + llmConcurrency);

          const outcomes = await Promise.allSettled(
            batch.map((mem) => classifyTaskMemory(mem.text, mem.taskTitle, config, abortSignal)),
          );

          for (let k = 0; k < outcomes.length; k++) {
            const outcome = outcomes[k];
            const mem = batch[k];

            if (outcome.status === "fulfilled" && outcome.value === "noise") {
              toRemove.push(mem.id);
              onProgress?.(
                "taskMemoryCleanup",
                `Noise: "${mem.text.slice(0, 60)}..." (task: ${mem.taskTitle})`,
              );
            } else if (outcome.status === "fulfilled" && outcome.value === "lasting") {
              onProgress?.("taskMemoryCleanup", `Lasting: "${mem.text.slice(0, 60)}..."`);
            }
            // On failure, keep the memory (conservative)
          }
        }

        // Remove noise memories
        if (toRemove.length > 0 && !abortSignal?.aborted) {
          await db.invalidateMemories(toRemove);
          result.taskMemoryCleanup.memoriesRemoved = toRemove.length;
          onProgress?.("taskMemoryCleanup", `Invalidated ${toRemove.length} task-noise memories`);
        }
      } else {
        onProgress?.("taskMemoryCleanup", "No recently completed tasks found");
      }
    } else {
      onProgress?.("taskMemoryCleanup", "TASKS.md not found — skipped");
    }

    logger.info(
      `memory-neo4j: [sleep] Phase 7 complete — ${result.taskMemoryCleanup.tasksChecked} tasks checked, ${result.taskMemoryCleanup.memoriesEvaluated} memories evaluated, ${result.taskMemoryCleanup.memoriesRemoved} removed`,
    );
  } catch (err) {
    logger.warn(`memory-neo4j: [sleep] Phase 7 error: ${String(err)}`);
  }
}
