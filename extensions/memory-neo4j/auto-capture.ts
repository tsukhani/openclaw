/**
 * Auto-capture pipeline for memory-neo4j.
 *
 * Handles the fire-and-forget message capture triggered from the agent_end hook:
 * - captureMessage: embed → dedup → rate → store for a single message
 * - runAutoCapture: full pipeline over a conversation turn's messages
 */

import { randomUUID } from "node:crypto";
import { passesAttentionGate } from "./attention-gate.js";
import type { ExtractionConfig } from "./config.js";
import type { Embeddings } from "./embeddings.js";
import {
  decomposeIntoAtomicFacts,
  isContradiction,
  isSemanticDuplicate,
  rateImportance,
  shouldCapture,
} from "./extractor.js";
import { detectInstructionPattern } from "./instruction-detector.js";
import { extractUserMessages } from "./message-utils.js";
import { metrics } from "./metrics.js";
import { linkMemoryToEpisode } from "./neo4j-client-episode.js";
import type { Neo4jMemoryClient } from "./neo4j-client.js";
import type { Logger, MemorySource } from "./schema.js";
import { detectCredential } from "./sleep-cycle-types.js";
// ============================================================================
// Auto-capture pipeline (fire-and-forget from agent_end hook)
// ============================================================================

/**
 * Shared capture logic for both user and assistant messages.
 * Extracts the common embed → dedup → rate → store pipeline.
 */
async function captureMessage(
  text: string,
  source: "auto-capture",
  importanceThreshold: number,
  importanceDiscount: number,
  agentId: string,
  sessionKey: string | undefined,
  db: Neo4jMemoryClient,
  embeddings: Embeddings,
  extractionConfig: ExtractionConfig,
  logger: Logger,
  precomputedVector?: number[],
  episodeId?: string, // Episodic memory: link stored memory to source episode
): Promise<{ stored: boolean; semanticDeduped: boolean }> {
  const vector = precomputedVector ?? (await embeddings.embed(text));
  let importance: number | undefined;

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
    try {
      importance = await rateImportance(text, extractionConfig);
      if (!Number.isFinite(importance)) {
        importance = 0.5;
      }
    } catch {
      importance = 0.5;
    }
    if (extractionConfig.enabled && importance < importanceThreshold) {
      return { stored: false, semanticDeduped: false };
    }
  }

  // Semantic dedup + inline contradiction check: remaining candidates in 0.75-0.95 band.
  // Pass the vector similarity score as a pre-screen to skip LLM calls
  // for pairs below SEMANTIC_DEDUP_VECTOR_THRESHOLD.
  let supersededIds: Array<{ oldId: string }> = [];
  if (candidates.length > 0) {
    for (const candidate of candidates) {
      if (await isSemanticDuplicate(text, candidate.text, extractionConfig, candidate.score)) {
        logger.debug?.(
          `memory-neo4j: semantic dedup — skipped "${text.slice(0, 60)}..." (duplicate of "${candidate.text.slice(0, 60)}...")`,
        );
        return { stored: false, semanticDeduped: true };
      }
      // Not a duplicate — check if it's a contradiction (inline conflict detection).
      // Only runs when extraction is enabled (needs LLM).
      if (
        extractionConfig.enabled &&
        (await isContradiction(text, candidate.text, extractionConfig))
      ) {
        logger.info(
          `memory-neo4j: inline contradiction detected — "${candidate.text.slice(0, 60)}..." superseded by "${text.slice(0, 60)}..."`,
        );
        supersededIds.push({ oldId: candidate.id });
      }
    }
  }

  // Instruction-pattern detection: quarantine flagged memories
  const instrResult = detectInstructionPattern(text);
  if (instrResult.flagged) {
    logger.debug?.(
      `memory-neo4j: instruction-pattern detected (${instrResult.category}) — quarantining "${text.slice(0, 200)}"`,
    );
  }

  // Real-time credential detection: quarantine memories containing API keys, tokens, passwords.
  // Uses the same detectCredential() from sleep-cycle-types.ts that the sleep credential scan uses.
  let credentialDetected = false;
  try {
    const credLabel = detectCredential(text);
    if (credLabel) {
      credentialDetected = true;
      logger.warn(
        `memory-neo4j: credential detected at capture time (${credLabel}) — quarantining "${text.slice(0, 200)}"`,
      );
    }
  } catch (err) {
    logger.debug?.(`memory-neo4j: credential detection error (non-blocking): ${String(err)}`);
  }

  const shouldQuarantine = instrResult.flagged || credentialDetected;

  const memoryId = randomUUID();
  await db.storeMemory({
    id: memoryId,
    text,
    embedding: vector,
    importance: importance * importanceDiscount,
    category: "other",
    source: source as MemorySource,
    extractionStatus: extractionConfig.enabled ? "pending" : "skipped",
    agentId,
    sessionKey,
    // Trust & safety: quarantine instruction-like or credential content
    ...(shouldQuarantine ? { trustScore: 0.0, quarantined: true } : {}),
  });

  // Supersede contradicted memories now that we have the new memory's ID
  for (const { oldId } of supersededIds) {
    try {
      await db.supersedeMemory(oldId, memoryId);
    } catch (err) {
      logger.debug?.(`memory-neo4j: inline supersede failed for ${oldId}: ${String(err)}`);
    }
  }

  // Link memory to source episode (episodic memory tier)
  if (episodeId) {
    try {
      const session = await db.createSession();
      try {
        await linkMemoryToEpisode(session, memoryId, episodeId);
      } finally {
        await session.close();
      }
    } catch (err) {
      logger.debug?.(`memory-neo4j: episode linking failed: ${String(err)}`);
    }
  }

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
  signal?: AbortSignal,
  decompose: boolean = false,
): Promise<void> {
  if (signal?.aborted) {
    return;
  }
  try {
    const t0 = performance.now();
    let stored = 0;
    let semanticDeduped = 0;

    // Extract and strip messages, then apply heuristic pre-filter on stripped text.
    // shouldCapture runs here (after stripping) so injected context tags don't
    // cause false rejections on raw message content.
    const userMessages = extractUserMessages(messages).filter((text) => shouldCapture(text));
    // Attention gate returns the (possibly truncated) text or null if rejected
    const retained: string[] = [];
    for (const text of userMessages) {
      const gated = passesAttentionGate(text);
      if (gated !== null) {
        retained.push(gated);
      }
    }

    const tGate = performance.now();

    // Collect all texts to embed in a single batch
    const allTexts: string[] = [];
    const allMeta: Array<{
      text: string;
      source: "auto-capture";
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
            allMeta.push({ text: fact, source: "auto-capture", threshold: 0.6, discount: 1.0 });
          }
          logger.debug?.(
            `memory-neo4j: decomposed "${text.slice(0, 60)}..." into ${Math.min(facts.length, 5)} atomic facts`,
          );
        } else {
          allTexts.push(text);
          allMeta.push({ text, source: "auto-capture", threshold: 0.6, discount: 1.0 });
        }
      } else {
        allTexts.push(text);
        allMeta.push({ text, source: "auto-capture", threshold: 0.6, discount: 1.0 });
      }
    }
    // Batch embed all at once
    if (signal?.aborted) {
      return;
    }
    const vectors = allTexts.length > 0 ? await embeddings.embedBatch(allTexts) : [];
    const tEmbed = performance.now();

    // Process each with pre-computed vector
    for (let i = 0; i < allMeta.length; i++) {
      if (signal?.aborted) {
        break;
      }
      try {
        const meta = allMeta[i];
        // C4: Skip messages with empty embedding vectors — they would be stored
        // without a valid embedding, making them invisible to vector search.
        const vec = vectors[i];
        if (!vec || vec.length === 0) {
          logger.debug?.(`memory-neo4j: auto-capture skipping item ${i} — empty embedding vector`);
          continue;
        }
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
          vec,
        );
        if (result.stored) {
          stored++;
        }
        if (result.semanticDeduped) {
          semanticDeduped++;
        }
      } catch (err) {
        logger.debug?.(`memory-neo4j: auto-capture item failed: ${String(err)}`);
      }
    }
    const tProcess = performance.now();

    // Track gate rejections and outcomes
    const rejectedGate = userMessages.length - retained.length;
    if (rejectedGate > 0) {
      metrics.record("memories_rejected_gate", rejectedGate);
    }
    if (stored > 0) {
      metrics.record("memories_stored", stored);
    }
    if (semanticDeduped > 0) {
      metrics.record("memories_deduped", semanticDeduped);
    }

    const totalMs = tProcess - t0;
    const gateMs = tGate - t0;
    const embedMs = tEmbed - tGate;
    const processMs = tProcess - tEmbed;
    logger.info(
      `memory-neo4j: [bench] auto-capture ${totalMs.toFixed(0)}ms total (gate=${gateMs.toFixed(0)}ms, embed=${embedMs.toFixed(0)}ms, process=${processMs.toFixed(0)}ms), ` +
        `${retained.length} gated, ${stored} stored, ${semanticDeduped} deduped`,
    );
  } catch (err) {
    logger.warn(`memory-neo4j: auto-capture failed: ${String(err)}`);
  }
}

// Export auto-capture internals for testing
export { captureMessage as _captureMessage, runAutoCapture as _runAutoCapture };
// Also export the non-underscored names for use within plugin-hooks.ts
export { captureMessage, runAutoCapture };
