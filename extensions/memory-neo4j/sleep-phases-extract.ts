/**
 * Sleep cycle Phase 2 group — entity extraction and retroactive tagging.
 *
 * - Phase 2:  Entity extraction (runBackgroundExtraction for pending memories)
 * - Phase 2b: Retroactive tagging (generate tags for memories missing them)
 */

import type { ExtractionConfig } from "./config.js";
import type { Embeddings } from "./embeddings.js";
import { extractTagsOnly, runBackgroundExtraction } from "./extractor.js";
import type { Neo4jMemoryClient } from "./neo4j-client.js";
import type { Logger } from "./schema.js";
import type { SleepCycleOptions, SleepCycleResult } from "./sleep-cycle-types.js";

// ============================================================================
// Phase 2: Entity Extraction
// ============================================================================

export async function runExtraction(
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
    extractionBatchSize = 50,
    extractionDelayMs = 1000,
    llmConcurrency = 8,
    onPhaseStart,
    onProgress,
  } = options;

  if (abortSignal?.aborted) return;

  if (!config.enabled) {
    logger.info("memory-neo4j: [sleep] Phase 2 skipped — extraction not enabled");
    return;
  }

  onPhaseStart?.("extraction");
  logger.info("memory-neo4j: [sleep] Phase 2: Entity Extraction");

  try {
    // Get initial count
    const counts = await db.countByExtractionStatus(agentId);
    result.extraction.total = counts.pending + counts.skipped;

    if (result.extraction.total > 0) {
      let hasMore = true;
      while (hasMore && !abortSignal?.aborted) {
        const pending = await db.listPendingExtractions(extractionBatchSize, agentId);

        if (pending.length === 0) {
          hasMore = false;
          break;
        }

        // Process in parallel chunks of llmConcurrency
        for (let i = 0; i < pending.length && !abortSignal?.aborted; i += llmConcurrency) {
          const chunk = pending.slice(i, i + llmConcurrency);
          const outcomes = await Promise.allSettled(
            chunk.map((memory) =>
              runBackgroundExtraction(
                memory.id,
                memory.text,
                db,
                embeddings,
                config,
                logger,
                memory.extractionRetries,
                abortSignal,
              ),
            ),
          );

          for (const outcome of outcomes) {
            result.extraction.processed++;
            if (outcome.status === "fulfilled" && outcome.value.success) {
              result.extraction.succeeded++;
            } else {
              result.extraction.failed++;
            }
          }

          if (result.extraction.processed % 10 === 0 || i + llmConcurrency >= pending.length) {
            onProgress?.(
              "extraction",
              `${result.extraction.processed}/${result.extraction.total} processed`,
            );
          }
        }

        // Delay between batches (abort-aware)
        if (hasMore && !abortSignal?.aborted) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, extractionDelayMs);
            // If abort fires during delay, resolve immediately
            abortSignal?.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                resolve();
              },
              { once: true },
            );
          });
        }
      }
    }

    logger.info(
      `memory-neo4j: [sleep] Phase 2 complete — ${result.extraction.succeeded} extracted, ${result.extraction.failed} failed`,
    );
  } catch (err) {
    logger.warn(`memory-neo4j: [sleep] Phase 2 error: ${String(err)}`);
  }
}

// ============================================================================
// Phase 2b: Retroactive Tagging
// ============================================================================

export async function runRetroactiveTagging(
  db: Neo4jMemoryClient,
  config: ExtractionConfig,
  logger: Logger,
  options: SleepCycleOptions,
  result: SleepCycleResult,
): Promise<void> {
  const {
    agentId,
    abortSignal,
    skipRetroactiveTagging = false,
    retroactiveTagBatchSize = 50,
    extractionDelayMs = 1000,
    llmConcurrency = 8,
    onPhaseStart,
    onProgress,
  } = options;

  if (abortSignal?.aborted) return;

  if (!config.enabled) {
    logger.info("memory-neo4j: [sleep] Phase 2b skipped — extraction not enabled");
    return;
  }
  if (skipRetroactiveTagging) {
    logger.info("memory-neo4j: [sleep] Phase 2b skipped — retroactive tagging disabled");
    return;
  }

  onPhaseStart?.("retroactiveTagging");
  logger.info("memory-neo4j: [sleep] Phase 2b: Retroactive Tagging");

  try {
    let hasMore = true;
    let runningTotal = 0;
    // Circuit-breaker: track the first ID of each batch to detect stalls
    // (e.g. incrementTaggingRetries silently fails → same memory loops forever)
    let lastBatchFirstId: string | undefined;
    let stalledCount = 0;
    while (hasMore && !abortSignal?.aborted) {
      const untagged = await db.listUntaggedMemories(retroactiveTagBatchSize, agentId);

      if (untagged.length === 0) {
        hasMore = false;
        break;
      }

      // Circuit-breaker: if the same memory leads consecutive batches, we're stuck
      if (untagged[0].id === lastBatchFirstId) {
        stalledCount++;
        if (stalledCount >= 3) {
          logger.warn(
            "memory-neo4j: [sleep] Phase 2b stalled — same memories in 3 consecutive batches, breaking",
          );
          break;
        }
      } else {
        stalledCount = 0;
      }
      lastBatchFirstId = untagged[0].id;

      // Accumulate total across all batches
      runningTotal += untagged.length;
      result.retroactiveTagging.total = runningTotal;

      // Process in parallel chunks of llmConcurrency
      for (let i = 0; i < untagged.length && !abortSignal?.aborted; i += llmConcurrency) {
        const chunk = untagged.slice(i, i + llmConcurrency);
        const outcomes = await Promise.allSettled(
          chunk.map((memory) => extractTagsOnly(memory.text, config, abortSignal)),
        );

        for (let k = 0; k < outcomes.length; k++) {
          const outcome = outcomes[k];
          const memory = chunk[k];

          if (outcome.status === "fulfilled" && outcome.value && outcome.value.length > 0) {
            try {
              await db.batchEntityOperations(memory.id, [], [], outcome.value);
              result.retroactiveTagging.tagged++;
              onProgress?.(
                "retroactiveTagging",
                `Tagged "${memory.text.slice(0, 50)}..." with ${outcome.value.length} tags`,
              );
            } catch (err) {
              result.retroactiveTagging.failed++;
              logger.warn(
                `memory-neo4j: [sleep] retroactive tagging write failed for ${memory.id.slice(0, 8)}: ${String(err)}`,
              );
              await db.incrementTaggingRetries(memory.id).catch((retryErr) => {
                logger.warn(
                  `memory-neo4j: [sleep] incrementTaggingRetries failed for ${memory.id.slice(0, 8)}: ${String(retryErr)}`,
                );
              });
            }
          } else {
            result.retroactiveTagging.failed++;
            // Increment retry counter so this memory is eventually skipped
            // after maxRetries (default 3), preventing infinite loops.
            await db.incrementTaggingRetries(memory.id).catch((retryErr) => {
              logger.warn(
                `memory-neo4j: [sleep] incrementTaggingRetries failed for ${memory.id.slice(0, 8)}: ${String(retryErr)}`,
              );
            });
          }
        }
      }

      // Check if there are more untagged memories by whether this batch was full
      hasMore = untagged.length >= retroactiveTagBatchSize;

      // Delay between batches (abort-aware)
      if (hasMore && !abortSignal?.aborted) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, extractionDelayMs);
          abortSignal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
      }
    }

    logger.info(
      `memory-neo4j: [sleep] Phase 2b complete — ${result.retroactiveTagging.tagged} tagged, ${result.retroactiveTagging.failed} failed`,
    );
  } catch (err) {
    logger.warn(`memory-neo4j: [sleep] Phase 2b error: ${String(err)}`);
  }
}
