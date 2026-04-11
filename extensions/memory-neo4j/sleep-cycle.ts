/**
 * Multi-phase sleep cycle for memory consolidation — orchestrator.
 *
 * Phases:
 * 1.  DEDUPLICATION - Merge near-duplicate memories (reduce redundancy)
 * 1b. SEMANTIC DEDUP - LLM-based paraphrase detection
 * 1c. CONFLICT DETECTION - Resolve contradictory memories
 * 1d. ENTITY DEDUP - Merge near-duplicate entities (reduce entity bloat)
 * 2.  EXTRACTION - Form entity relationships (strengthen connections)
 * 2b. RETROACTIVE TAGGING - Generate tags for tag-less memories
 * 3.  DECAY/PRUNING - Remove old, low-importance memories (forgetting curve)
 * 3b. TEMPORAL STALENESS - Remove memories about past events/dates (temporal decay)
 * 3c. RETROACTIVE CONFLICT SCAN - Find older memories conflicting with newer ones
 * 4.  CLEANUP - Remove orphaned entities/tags (garbage collection)
 * 5.  NOISE CLEANUP - Remove dangerous pattern memories
 * 5b. CREDENTIAL SCAN - Remove memories containing leaked credentials
 * 6.  TIP GENERATION - Store reusable lessons from session failure patterns
 * 10. LINK CREATION - Create SIMILAR + TEMPORAL_NEXT edges between memories (OP-182)
 *
 * Research basis:
 * - ACT-R memory model for retrieval-based importance
 * - Ebbinghaus forgetting curve for decay
 * - MemGPT/Letta for tiered memory architecture
 */

import type { ExtractionConfig } from "./config.js";
import type { Embeddings } from "./embeddings.js";
import { metrics } from "./metrics.js";
import { deleteExpiredEpisodes } from "./neo4j-client-episode.js";
import type { Neo4jMemoryClient } from "./neo4j-client.js";
import type { Logger } from "./schema.js";
// Import types for use in this file and re-export for external consumers (backward-compatible).
import type { SleepCycleOptions, SleepCycleResult } from "./sleep-cycle-types.js";
import { runCredentialScan, runNoiseCleanup, runOrphanCleanup } from "./sleep-phases-cleanup.js";
import { runCommunityDetection } from "./sleep-phases-community.js";
import {
  runDecay,
  runPendingConflictRetry,
  runRetroactiveConflictScan,
  runTemporalStaleness,
} from "./sleep-phases-decay.js";
import { runConflictDetection, runDedup, runEntityDedup } from "./sleep-phases-dedup.js";
import { runExtraction, runRetroactiveTagging } from "./sleep-phases-extract.js";
import {
  createCausalLinks,
  createSemanticLinks,
  createTemporalLinks,
} from "./sleep-phases-links.js";
import { runObservationGeneration } from "./sleep-phases-observations.js";
import {
  runRuleLearning,
  runRuleMaterialization,
  runConsistencyAudit,
  runCausalModelUpdate,
} from "./sleep-phases-reasoning.js";
import {
  runEntityReclassification,
  runRelationshipReclassification,
} from "./sleep-phases-reclassify.js";
import { runReflection } from "./sleep-phases-reflect.js";
import { runTipGeneration } from "./sleep-phases-tips.js";
export type { SleepCycleOptions, SleepCycleResult };

// C1: Module-level mutex to prevent concurrent sleep cycles (CLI + cron overlap).
// A simple boolean flag is sufficient because Node.js is single-threaded — the
// check-and-set is atomic within the event loop microtask.
let _sleepCycleRunning = false;

// ============================================================================
// Orchestrator
// ============================================================================

/**
 * Run the full sleep cycle — all phases of memory consolidation.
 */
export async function runSleepCycle(
  db: Neo4jMemoryClient,
  embeddings: Embeddings,
  config: ExtractionConfig,
  logger: Logger,
  options: SleepCycleOptions = {},
): Promise<SleepCycleResult> {
  const startTime = Date.now();
  metrics.record("sleep_cycles_run");
  const { abortSignal } = options;

  // C1: Mutex guard — prevent concurrent sleep cycles (CLI + cron overlap)
  if (_sleepCycleRunning) {
    logger.warn(
      "memory-neo4j: [sleep] Sleep cycle already running — skipping concurrent invocation",
    );
    return {
      dedup: { clustersFound: 0, memoriesMerged: 0 },
      conflict: { pairsFound: 0, resolved: 0, invalidated: 0 },
      semanticDedup: { pairsChecked: 0, duplicatesMerged: 0 },
      entityDedup: { pairsFound: 0, merged: 0 },
      decay: { memoriesPruned: 0 },
      temporalStaleness: { memoriesChecked: 0, memoriesRemoved: 0 },
      retroactiveConflictScan: { memoriesScanned: 0, memoriesSuperseded: 0 },
      pendingConflictRetry: { pairsRetried: 0, resolved: 0, permanentlySkipped: 0 },
      extraction: { total: 0, processed: 0, succeeded: 0, failed: 0 },
      retroactiveTagging: { total: 0, tagged: 0, failed: 0 },
      cleanup: { entitiesRemoved: 0, tagsRemoved: 0, singleUseTagsRemoved: 0 },
      credentialScan: { memoriesScanned: 0, credentialsFound: 0, memoriesRemoved: 0 },
      tipGeneration: {
        sessionsScanned: 0,
        failurePatternsFound: 0,
        tipsGenerated: 0,
        tipsStored: 0,
      },
      entityReclassification: { entitiesEvaluated: 0, entitiesReclassified: 0, failed: 0 },
      relationshipReclassification: {
        relationshipsEvaluated: 0,
        relationshipsReclassified: 0,
        failed: 0,
      },
      linkCreation: { semanticLinksCreated: 0, temporalLinksCreated: 0, causalLinksCreated: 0 },
      observationGeneration: {
        entitiesProcessed: 0,
        observationsCreated: 0,
        observationsUpdated: 0,
      },
      reflection: {
        entitiesReflected: 0,
        opinionsCreated: 0,
        opinionsUpdated: 0,
        opinionsArchived: 0,
        opinionsGeneralized: 0,
      },
      ruleLearning: { rulesDiscovered: 0, rulesActivated: 0, rulesRejected: 0, rulesPruned: 0 },
      ruleMaterialization: { factsInferred: 0, iterations: 0, converged: false },
      consistencyAudit: { constraintsChecked: 0, violationsFound: 0, memoriesQuarantined: 0 },
      causalModelUpdate: { modelsUpdated: 0, edgesAdded: 0, edgesRemoved: 0 },
      durationMs: 0,
      aborted: true,
    };
  }
  _sleepCycleRunning = true;

  try {
    const result: SleepCycleResult = {
      dedup: { clustersFound: 0, memoriesMerged: 0 },
      conflict: { pairsFound: 0, resolved: 0, invalidated: 0 },
      semanticDedup: { pairsChecked: 0, duplicatesMerged: 0 },
      entityDedup: { pairsFound: 0, merged: 0 },
      decay: { memoriesPruned: 0 },
      temporalStaleness: { memoriesChecked: 0, memoriesRemoved: 0 },
      retroactiveConflictScan: { memoriesScanned: 0, memoriesSuperseded: 0 },
      pendingConflictRetry: { pairsRetried: 0, resolved: 0, permanentlySkipped: 0 },
      extraction: { total: 0, processed: 0, succeeded: 0, failed: 0 },
      retroactiveTagging: { total: 0, tagged: 0, failed: 0 },
      cleanup: { entitiesRemoved: 0, tagsRemoved: 0, singleUseTagsRemoved: 0 },
      credentialScan: { memoriesScanned: 0, credentialsFound: 0, memoriesRemoved: 0 },
      tipGeneration: {
        sessionsScanned: 0,
        failurePatternsFound: 0,
        tipsGenerated: 0,
        tipsStored: 0,
      },
      entityReclassification: { entitiesEvaluated: 0, entitiesReclassified: 0, failed: 0 },
      relationshipReclassification: {
        relationshipsEvaluated: 0,
        relationshipsReclassified: 0,
        failed: 0,
      },
      linkCreation: { semanticLinksCreated: 0, temporalLinksCreated: 0, causalLinksCreated: 0 },
      observationGeneration: {
        entitiesProcessed: 0,
        observationsCreated: 0,
        observationsUpdated: 0,
      },
      reflection: {
        entitiesReflected: 0,
        opinionsCreated: 0,
        opinionsUpdated: 0,
        opinionsArchived: 0,
        opinionsGeneralized: 0,
      },
      ruleLearning: { rulesDiscovered: 0, rulesActivated: 0, rulesRejected: 0, rulesPruned: 0 },
      ruleMaterialization: { factsInferred: 0, iterations: 0, converged: false },
      consistencyAudit: { constraintsChecked: 0, violationsFound: 0, memoriesQuarantined: 0 },
      causalModelUpdate: { modelsUpdated: 0, edgesAdded: 0, edgesRemoved: 0 },
      durationMs: 0,
      aborted: false,
    };

    // ── Stage 1 (sequential — data dependencies) ──────────────────────────

    // Phase 1 + 1b: Vector dedup + semantic dedup (combined — share one DB call)
    await runDedup(db, config, logger, options, result);

    // Phase 1c: Conflict detection
    await runConflictDetection(db, config, logger, options, result);

    // Phase 1d: Entity deduplication
    await runEntityDedup(db, logger, options, result);

    // Phase 2: Entity extraction
    await runExtraction(db, embeddings, config, logger, options, result);

    // Phase 2b: Retroactive tagging
    await runRetroactiveTagging(db, config, logger, options, result);

    // Phase 10: Semantic + temporal link creation (OP-182)
    if (!abortSignal?.aborted && !options.skipLinkCreation) {
      options.onPhaseStart?.("linkCreation");
      logger.info("memory-neo4j: [sleep] Phase 10: Creating semantic + temporal links");
      const linkAgentId = options.agentId ?? "default";
      const linkSession = await db.createSession();
      try {
        const semanticCount = await createSemanticLinks(
          linkSession,
          linkAgentId,
          logger,
          abortSignal,
        );
        const temporalCount = await createTemporalLinks(
          linkSession,
          linkAgentId,
          logger,
          abortSignal,
        );
        const causalCount = await createCausalLinks(
          linkSession,
          linkAgentId,
          config,
          logger,
          abortSignal,
        );
        result.linkCreation.semanticLinksCreated = semanticCount;
        result.linkCreation.temporalLinksCreated = temporalCount;
        result.linkCreation.causalLinksCreated = causalCount;
        logger.info(
          `memory-neo4j: [sleep] Phase 10 complete — created ${semanticCount} semantic links, ${temporalCount} temporal links, ${causalCount} causal links`,
        );
      } catch (err) {
        logger.warn(`memory-neo4j: [sleep] Phase 10 link creation failed: ${String(err)}`);
      } finally {
        await linkSession.close();
      }
    }

    // Phase 11: Per-entity observation generation (OP-183)
    if (!abortSignal?.aborted && !options.skipObservationGeneration && config.enabled) {
      options.onPhaseStart?.("observationGeneration");
      logger.info("memory-neo4j: [sleep] Phase 11: Observation Generation");
      const obsAgentId = options.agentId ?? "default";
      const obsSession = await db.createSession();
      try {
        const obsResult = await runObservationGeneration(obsSession, obsAgentId, config, logger, {
          abortSignal,
          maxEntitiesPerRun: options.observationMaxEntities,
        });
        result.observationGeneration.entitiesProcessed = obsResult.entitiesProcessed;
        result.observationGeneration.observationsCreated = obsResult.observationsCreated;
        result.observationGeneration.observationsUpdated = obsResult.observationsUpdated;
      } catch (err) {
        logger.warn(`memory-neo4j: [sleep] Phase 11 observation generation failed: ${String(err)}`);
      } finally {
        await obsSession.close();
      }
    }

    // Phase 12: Reflection / opinion generation (OP-186)
    if (!abortSignal?.aborted && !options.skipReflection && config.enabled) {
      options.onPhaseStart?.("reflection");
      logger.info("memory-neo4j: [sleep] Phase 12: Reflection (opinion/belief synthesis)");
      const reflectAgentId = options.agentId ?? "default";
      const reflectSession = await db.createSession();
      try {
        const reflectResult = await runReflection(reflectSession, reflectAgentId, config, logger, {
          abortSignal,
          maxEntitiesPerRun: options.reflectionMaxEntities,
        });
        result.reflection.entitiesReflected = reflectResult.entitiesReflected;
        result.reflection.opinionsCreated = reflectResult.opinionsCreated;
        result.reflection.opinionsUpdated = reflectResult.opinionsUpdated;
        result.reflection.opinionsArchived = reflectResult.opinionsArchived;
        result.reflection.opinionsGeneralized = reflectResult.opinionsGeneralized;
      } catch (err) {
        logger.warn(`memory-neo4j: [sleep] Phase 12 reflection failed: ${String(err)}`);
      } finally {
        await reflectSession.close();
      }
    }

    // Phase 2c: Community detection (opt-in via communityDetectionConfig)
    if (!abortSignal?.aborted && options.communityDetectionConfig?.enabled) {
      options.onPhaseStart?.("communityDetection");
      const agentId = options.agentId ?? "default";
      const session = await db.createSession();
      try {
        const cdResult = await runCommunityDetection(
          session,
          agentId,
          options.communityDetectionConfig,
          logger,
          abortSignal,
        );
        logger.debug?.(
          `memory-neo4j: [sleep] community detection — ${cdResult.communitiesFound} communities, ${cdResult.entitiesGrouped} entities`,
        );
      } catch (err) {
        logger.warn(`memory-neo4j: [sleep] community detection failed: ${String(err)}`);
      } finally {
        await session.close();
      }
    }

    // ── Stage 2 (parallel — all groups independent) ──────────────────────

    await Promise.all([
      // Group A: Decay pipeline (internally sequential: 3 → 3b → 3c → 3d)
      (async () => {
        // Phase 3: Decay & pruning
        await runDecay(db, logger, options, result);

        // Phase 3b: Temporal staleness
        await runTemporalStaleness(db, config, logger, options, result);

        // Phase 3c: Retroactive conflict scan
        if (!abortSignal?.aborted && config.enabled) {
          await runRetroactiveConflictScan(db, config, logger, options, result);
        }

        // Phase 3d: Pending conflict retry (OP-125)
        if (!abortSignal?.aborted && config.enabled) {
          await runPendingConflictRetry(db, config, logger, options, result);
        }
      })(),

      // Group B: Cleanup (5 + 5b + episode cleanup — all independent cleanup ops)
      (async () => {
        // Phase 5: Noise pattern cleanup
        await runNoiseCleanup(db, logger, options, result);

        // Phase 5b: Credential scanning
        await runCredentialScan(db, logger, options, result);

        // Phase 5c: Episode retention cleanup (opt-in via episodicMemoryConfig)
        if (!abortSignal?.aborted && options.episodicMemoryConfig?.enabled) {
          options.onPhaseStart?.("episodeCleanup");
          const retentionDays = options.episodicMemoryConfig.retentionDays ?? 30;
          const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
          const session = await db.createSession();
          try {
            const deleted = await deleteExpiredEpisodes(session, cutoff, options.agentId);
            if (deleted > 0) {
              logger.info(
                `memory-neo4j: [sleep] episode cleanup — deleted ${deleted} expired episodes`,
              );
            }
          } catch (err) {
            logger.warn(`memory-neo4j: [sleep] episode cleanup failed: ${String(err)}`);
          } finally {
            await session.close();
          }
        }
      })(),

      // Group C: Tip generation
      (async () => {
        await runTipGeneration(db, embeddings, config, logger, options, result);
      })(),

      // Group D: Reclassification (internally sequential)
      (async () => {
        // Phase 9: Entity reclassification
        if (!abortSignal?.aborted && config.enabled) {
          await runEntityReclassification(db, config, logger, options, result);
        }

        // Phase 9b: Relationship reclassification
        if (!abortSignal?.aborted && config.enabled) {
          await runRelationshipReclassification(db, config, logger, options, result);
        }
      })(),
    ]);

    // ── Stage 3 (sequential — depends on Stage 2 decay creating orphans) ─

    if (!abortSignal?.aborted) {
      // Phase 4: Orphan cleanup (must run after decay may have created orphans)
      await runOrphanCleanup(db, logger, options, result);
    }

    // ── Stage 4 (sequential — neuro-symbolic reasoning phases) ─────────

    if (!abortSignal?.aborted) {
      const reasoningAgentId = options.agentId ?? "default";
      const reasoningCfg = options.reasoningConfig;

      // Phase 14: Rule Learning
      if (!options.skipRuleLearning) {
        await runRuleLearning(db, logger, reasoningAgentId, reasoningCfg, result, abortSignal);
      }

      // Phase 15: Rule Materialization
      if (!abortSignal?.aborted && !options.skipRuleMaterialization) {
        await runRuleMaterialization(
          db,
          logger,
          reasoningAgentId,
          reasoningCfg,
          result,
          abortSignal,
        );
      }

      // Phase 16: Consistency Audit
      if (!abortSignal?.aborted && !options.skipConsistencyAudit) {
        await runConsistencyAudit(db, logger, reasoningAgentId, result, abortSignal);
      }

      // Phase 17: Causal Model Update
      if (!abortSignal?.aborted && !options.skipCausalModelUpdate) {
        await runCausalModelUpdate(db, logger, reasoningAgentId, result, abortSignal);
      }
    }

    result.durationMs = Date.now() - startTime;
    metrics.record("sleep_cycle_duration_ms", result.durationMs);
    result.aborted = abortSignal?.aborted ?? false;

    logger.info(
      `memory-neo4j: [sleep] Sleep cycle complete in ${(result.durationMs / 1000).toFixed(1)}s` +
        (result.aborted ? " (aborted)" : ""),
    );

    return result;
  } finally {
    _sleepCycleRunning = false;
  }
}
