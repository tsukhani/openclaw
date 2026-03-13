/**
 * Auto-capture pipeline for memory-neo4j.
 *
 * Handles the fire-and-forget message capture triggered from the agent_end hook:
 * - Task ledger cache layer (getActiveTaskIdForCapture)
 * - captureMessage: embed → dedup → rate → store for a single message
 * - runAutoCapture: full pipeline over a conversation turn's messages
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { passesAttentionGate, passesAssistantAttentionGate } from "./attention-gate.js";
import type { ExtractionConfig } from "./config.js";
import type { Embeddings } from "./embeddings.js";
import { decomposeIntoAtomicFacts, isSemanticDuplicate, rateImportance } from "./extractor.js";
import { extractUserMessages, extractAssistantMessages } from "./message-utils.js";
import { metrics } from "./metrics.js";
import type { Neo4jMemoryClient } from "./neo4j-client.js";
import type { Logger, MemorySource } from "./schema.js";
import { detectTaskSignals } from "./task-detector.js";
import {
  addTaskToLedger,
  completeTaskInLedger,
  parseTaskLedger,
  updateTaskInLedger,
} from "./task-ledger.js";

// ============================================================================
// Layer 3: TASKS.md cache for auto-capture task tagging
// ============================================================================

/** Cached result of TASKS.md parsing for auto-capture task tagging, keyed by workspace dir. */
export const _taskLedgerCache = new Map<
  string,
  { activeTaskId: string | undefined; expiresAt: number }
>();
const TASK_LEDGER_CACHE_TTL_MS = 60_000; // 60 seconds

/**
 * Get the active task ID from TASKS.md (if exactly one active task).
 * Results are cached with a 60-second TTL to avoid re-parsing on every message.
 */
async function getActiveTaskIdForCapture(
  workspaceDir: string | undefined,
  logger: Logger,
): Promise<string | undefined> {
  const cacheKey = workspaceDir ?? "__default__";
  const now = Date.now();
  const cached = _taskLedgerCache.get(cacheKey);
  if (cached && now < cached.expiresAt) {
    return cached.activeTaskId;
  }

  let activeTaskId: string | undefined;
  if (workspaceDir) {
    try {
      const tasksPath = path.join(workspaceDir, "TASKS.md");
      const content = await fs.readFile(tasksPath, "utf-8");
      const ledger = parseTaskLedger(content);
      // Only auto-tag when there's exactly one active task to avoid ambiguity
      if (ledger.activeTasks.length === 1) {
        activeTaskId = ledger.activeTasks[0].id;
      }
    } catch {
      // TASKS.md doesn't exist or can't be read — no auto-tagging
    }
  }

  // Keep cache bounded — evict oldest entry if over limit
  const MAX_CACHE_ENTRIES = 10;
  if (_taskLedgerCache.size >= MAX_CACHE_ENTRIES) {
    const firstKey = _taskLedgerCache.keys().next().value;
    if (firstKey !== undefined) _taskLedgerCache.delete(firstKey);
  }
  _taskLedgerCache.set(cacheKey, { activeTaskId, expiresAt: now + TASK_LEDGER_CACHE_TTL_MS });
  return activeTaskId;
}

// Exported for testing
export { getActiveTaskIdForCapture as _getActiveTaskIdForCapture };

function invalidateTaskLedgerCache(workspaceDir: string | undefined): void {
  _taskLedgerCache.delete(workspaceDir ?? "__default__");
}

function normalizeTaskTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

async function loadActiveTasks(
  workspaceDir: string,
): Promise<Array<{ id: string; title: string }> | null> {
  const tasksPath = path.join(workspaceDir, "TASKS.md");

  try {
    const content = await fs.readFile(tasksPath, "utf-8");
    if (!content.trim()) {
      return [];
    }
    const ledger = parseTaskLedger(content);
    return ledger.activeTasks.map((task) => ({ id: task.id, title: task.title }));
  } catch {
    return null;
  }
}

async function findMatchingActiveTaskId(
  workspaceDir: string,
  title: string,
  preferredTaskId?: string,
): Promise<string | undefined> {
  const activeTasks = await loadActiveTasks(workspaceDir);
  if (!activeTasks || activeTasks.length === 0) {
    return undefined;
  }

  if (preferredTaskId && activeTasks.some((task) => task.id === preferredTaskId)) {
    return preferredTaskId;
  }

  const normalizedTitle = normalizeTaskTitle(title);
  if (normalizedTitle.length > 0) {
    const exactMatches = activeTasks.filter(
      (task) => normalizeTaskTitle(task.title) === normalizedTitle,
    );
    if (exactMatches.length === 1) {
      return exactMatches[0].id;
    }

    const containsMatches = activeTasks.filter((task) => {
      const candidateTitle = normalizeTaskTitle(task.title);
      return candidateTitle.includes(normalizedTitle) || normalizedTitle.includes(candidateTitle);
    });
    if (containsMatches.length === 1) {
      return containsMatches[0].id;
    }
  }

  if (activeTasks.length === 1) {
    return activeTasks[0].id;
  }

  return undefined;
}

async function runTaskAutoCapture(
  retainedAssistant: string[],
  config: ExtractionConfig,
  workspaceDir: string,
  logger: Logger,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const assistantText = retainedAssistant.join("\n\n").trim();
    const result = await detectTaskSignals(assistantText, config, signal);
    if (result.skipped || result.signals.length === 0) {
      return;
    }

    for (const taskSignal of result.signals) {
      if (signal?.aborted) {
        return;
      }

      try {
        if (taskSignal.kind === "new_task") {
          await addTaskToLedger(workspaceDir, {
            title: taskSignal.title,
            status: "in_progress",
            details: taskSignal.details,
            currentStep: taskSignal.currentStep,
            started: undefined,
            updated: undefined,
            blockedOn: undefined,
          });
          invalidateTaskLedgerCache(workspaceDir);
          continue;
        }

        const taskId = await findMatchingActiveTaskId(
          workspaceDir,
          taskSignal.title,
          taskSignal.completedTaskId,
        );
        if (!taskId) {
          logger.debug?.(
            `memory-neo4j: task auto-capture could not match "${taskSignal.title}" (${taskSignal.kind})`,
          );
          continue;
        }

        if (taskSignal.kind === "task_update") {
          await updateTaskInLedger(workspaceDir, taskId, {
            status: "in_progress",
            details: taskSignal.details,
            currentStep: taskSignal.currentStep,
          });
          invalidateTaskLedgerCache(workspaceDir);
          continue;
        }

        await completeTaskInLedger(workspaceDir, taskId);
        invalidateTaskLedgerCache(workspaceDir);
      } catch (err) {
        logger.warn(`memory-neo4j: task auto-capture signal failed: ${String(err)}`);
      }
    }
  } catch (err) {
    logger.warn(`memory-neo4j: task auto-capture failed: ${String(err)}`);
  }
}

// ============================================================================
// Auto-capture pipeline (fire-and-forget from agent_end hook)
// ============================================================================

/**
 * Shared capture logic for both user and assistant messages.
 * Extracts the common embed → dedup → rate → store pipeline.
 */
async function captureMessage(
  text: string,
  source: "auto-capture" | "auto-capture-assistant",
  importanceThreshold: number,
  importanceDiscount: number,
  agentId: string,
  sessionKey: string | undefined,
  db: Neo4jMemoryClient,
  embeddings: Embeddings,
  extractionConfig: ExtractionConfig,
  logger: Logger,
  precomputedVector?: number[],
  taskId?: string, // Layer 3: optional task ID for auto-tagging
): Promise<{ stored: boolean; semanticDeduped: boolean }> {
  // For assistant messages, rate importance first (before embedding) to skip early.
  // When extraction is disabled, rateImportance returns 0.5 (the fallback), so we
  // skip the early importance gate to avoid silently blocking all assistant captures.
  const rateFirst = source === "auto-capture-assistant" && extractionConfig.enabled;

  let importance: number | undefined;
  if (rateFirst) {
    importance = await rateImportance(text, extractionConfig);
    if (importance < importanceThreshold) {
      return { stored: false, semanticDeduped: false };
    }
  }

  const vector = precomputedVector ?? (await embeddings.embed(text));

  // Single vector search at lower threshold, split by score band
  const candidates = await db.findSimilar(vector, 0.75, 3, agentId);

  // Exact dedup: any candidate with score >= 0.95 means it's a duplicate
  const exactDup = candidates.find((c) => c.score >= 0.95);
  if (exactDup) {
    return { stored: false, semanticDeduped: false };
  }

  // Rate importance if not already done.
  // When extraction is disabled, rateImportance returns a fixed 0.5 fallback,
  // so skip the threshold check to avoid silently blocking all captures.
  if (importance === undefined) {
    importance = await rateImportance(text, extractionConfig);
    if (extractionConfig.enabled && importance < importanceThreshold) {
      return { stored: false, semanticDeduped: false };
    }
  }

  // Semantic dedup: remaining candidates in 0.75-0.95 band
  // Pass the vector similarity score as a pre-screen to skip LLM calls
  // for pairs below SEMANTIC_DEDUP_VECTOR_THRESHOLD.
  if (candidates.length > 0) {
    for (const candidate of candidates) {
      if (await isSemanticDuplicate(text, candidate.text, extractionConfig, candidate.score)) {
        logger.debug?.(
          `memory-neo4j: semantic dedup — skipped "${text.slice(0, 60)}..." (duplicate of "${candidate.text.slice(0, 60)}...")`,
        );
        return { stored: false, semanticDeduped: true };
      }
    }
  }

  await db.storeMemory({
    id: randomUUID(),
    text,
    embedding: vector,
    importance: importance * importanceDiscount,
    category: "other",
    source: source as MemorySource,
    extractionStatus: extractionConfig.enabled ? "pending" : "skipped",
    agentId,
    sessionKey,
    // Layer 3: auto-tag with active task ID when available
    ...(taskId ? { taskId } : {}),
  });
  return { stored: true, semanticDeduped: false };
}

/**
 * Run the full auto-capture pipeline asynchronously.
 * Processes user and assistant messages through attention gate → capture.
 */
async function runAutoCapture(
  messages: unknown[],
  agentId: string,
  sessionKey: string | undefined,
  db: Neo4jMemoryClient,
  embeddings: Embeddings,
  extractionConfig: ExtractionConfig,
  logger: Logger,
  workspaceDir?: string, // Layer 3: workspace dir for task auto-tagging
  captureAssistant: boolean = false,
  signal?: AbortSignal,
  decompose: boolean = false,
): Promise<void> {
  if (signal?.aborted) return;
  try {
    const t0 = performance.now();
    let stored = 0;
    let semanticDeduped = 0;

    // Process user messages
    const userMessages = extractUserMessages(messages);
    const retained = userMessages.filter((text) => passesAttentionGate(text));

    // Process assistant messages (only when explicitly enabled)
    const assistantMessages = captureAssistant ? extractAssistantMessages(messages) : [];
    const retainedAssistant = assistantMessages.filter((text) =>
      passesAssistantAttentionGate(text),
    );
    const tGate = performance.now();

    // Collect all texts to embed in a single batch
    const allTexts: string[] = [];
    const allMeta: Array<{
      text: string;
      source: "auto-capture" | "auto-capture-assistant";
      threshold: number;
      discount: number;
    }> = [];

    // Minimum text length to bother decomposing — short messages are already atomic
    const DECOMPOSE_MIN_CHARS = 200;

    for (const text of retained) {
      // Decompose long user messages into atomic facts when enabled
      if (decompose && text.length >= DECOMPOSE_MIN_CHARS) {
        const facts = await decomposeIntoAtomicFacts(text, extractionConfig, signal);
        if (facts && facts.length > 1) {
          // Cap at 5 facts to bound LLM/embedding cost per message
          for (const fact of facts.slice(0, 5)) {
            allTexts.push(fact);
            allMeta.push({ text: fact, source: "auto-capture", threshold: 0.75, discount: 1.0 });
          }
          logger.debug?.(
            `memory-neo4j: decomposed "${text.slice(0, 60)}..." into ${Math.min(facts.length, 5)} atomic facts`,
          );
        } else {
          allTexts.push(text);
          allMeta.push({ text, source: "auto-capture", threshold: 0.75, discount: 1.0 });
        }
      } else {
        allTexts.push(text);
        allMeta.push({ text, source: "auto-capture", threshold: 0.75, discount: 1.0 });
      }
    }
    for (const text of retainedAssistant) {
      allTexts.push(text);
      allMeta.push({ text, source: "auto-capture-assistant", threshold: 0.8, discount: 0.75 });
    }

    // Batch embed all at once
    if (signal?.aborted) return;
    const vectors = allTexts.length > 0 ? await embeddings.embedBatch(allTexts) : [];
    const tEmbed = performance.now();

    // Layer 3: Detect active task for auto-tagging
    const activeTaskId = await getActiveTaskIdForCapture(workspaceDir, logger);

    // Process each with pre-computed vector
    for (let i = 0; i < allMeta.length; i++) {
      if (signal?.aborted) break;
      try {
        const meta = allMeta[i];
        const result = await captureMessage(
          meta.text,
          meta.source,
          meta.threshold,
          meta.discount,
          agentId,
          sessionKey,
          db,
          embeddings,
          extractionConfig,
          logger,
          vectors[i],
          activeTaskId, // Layer 3: auto-tag with active task ID
        );
        if (result.stored) stored++;
        if (result.semanticDeduped) semanticDeduped++;
      } catch (err) {
        logger.debug?.(`memory-neo4j: auto-capture item failed: ${String(err)}`);
      }
    }
    const tProcess = performance.now();

    // Track gate rejections and outcomes
    const rejectedGate =
      userMessages.length - retained.length + assistantMessages.length - retainedAssistant.length;
    if (rejectedGate > 0) metrics.record("memories_rejected_gate", rejectedGate);
    if (stored > 0) metrics.record("memories_stored", stored);
    if (semanticDeduped > 0) metrics.record("memories_deduped", semanticDeduped);

    const totalMs = tProcess - t0;
    const gateMs = tGate - t0;
    const embedMs = tEmbed - tGate;
    const processMs = tProcess - tEmbed;
    logger.info(
      `memory-neo4j: [bench] auto-capture ${totalMs.toFixed(0)}ms total (gate=${gateMs.toFixed(0)}ms, embed=${embedMs.toFixed(0)}ms, process=${processMs.toFixed(0)}ms), ` +
        `${retained.length}+${retainedAssistant.length} gated, ${stored} stored, ${semanticDeduped} deduped`,
    );

    // Layer 4: Task auto-detection
    if (extractionConfig.autoCaptureTasks && workspaceDir && retainedAssistant.length > 0) {
      await runTaskAutoCapture(retainedAssistant, extractionConfig, workspaceDir, logger, signal);
    }
  } catch (err) {
    logger.warn(`memory-neo4j: auto-capture failed: ${String(err)}`);
  }
}

// Export auto-capture internals for testing
export { captureMessage as _captureMessage, runAutoCapture as _runAutoCapture };
export {
  runTaskAutoCapture as _runTaskAutoCapture,
  findMatchingActiveTaskId as _findMatchingActiveTaskId,
};
// Also export the non-underscored names for use within plugin-hooks.ts
export { captureMessage, runAutoCapture };
