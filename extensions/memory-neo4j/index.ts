/**
 * OpenClaw Memory (Neo4j) Plugin
 *
 * Drop-in replacement for memory-lancedb with three-signal hybrid search,
 * entity extraction, and knowledge graph capabilities.
 *
 * Provides:
 * - memory_recall: Hybrid search (vector + BM25 + graph traversal)
 * - memory_store: Store memories with background entity extraction
 * - memory_forget: Delete memories with cascade cleanup
 *
 * Architecture decisions: see docs/memory-neo4j/ARCHITECTURE.md
 */

import { Cron } from "croner";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { registerCli } from "./cli.js";
import {
  DEFAULT_EMBEDDING_DIMS,
  EMBEDDING_DIMENSIONS,
  memoryNeo4jConfigSchema,
  resolveExtractionConfig,
  vectorDimsForModel,
} from "./config.js";
import { Embeddings } from "./embeddings.js";
import { setPluginLlm } from "./llm-client.js";
import { LoggingMetricsCollector, NO_OP_METRICS, type MetricsCollector } from "./metrics.js";
import { Neo4jMemoryClient } from "./neo4j-client.js";
import { registerMemoryHooks } from "./plugin-hooks.js";
import { registerMemoryTools } from "./plugin-tools.js";
import { runSleepCycle } from "./sleep-cycle.js";

// ============================================================================
// Plugin Definition
// ============================================================================

const memoryNeo4jPlugin = {
  id: "memory-neo4j",
  name: "Memory (Neo4j)",
  description:
    "Neo4j-backed long-term memory with three-signal hybrid search, entity extraction, and knowledge graph",
  kind: "memory" as const,
  configSchema: memoryNeo4jConfigSchema,

  register(api: OpenClawPluginApi) {
    // Inject native LLM routing so all LLM calls go through OpenClaw's model stack
    setPluginLlm(api.runtime.llm);

    // Parse configuration
    const cfg = memoryNeo4jConfigSchema.parse(api.pluginConfig);
    const extractionConfig = resolveExtractionConfig(cfg.extraction);
    const vectorDim = vectorDimsForModel(cfg.embedding.model);

    // Warn on empty neo4j password (may be valid for some setups, but usually a misconfiguration)
    if (!cfg.neo4j.password) {
      api.logger.warn(
        "memory-neo4j: neo4j.password is empty — this may be intentional for passwordless setups, but verify your configuration",
      );
    }

    // Warn when using default embedding dimensions for an unknown model
    const isKnownModel =
      cfg.embedding.model in EMBEDDING_DIMENSIONS ||
      Object.keys(EMBEDDING_DIMENSIONS).some((known) => cfg.embedding.model.startsWith(known));
    if (!isKnownModel) {
      api.logger.warn(
        `memory-neo4j: unknown embedding model "${cfg.embedding.model}" — using default ${DEFAULT_EMBEDDING_DIMS} dimensions. ` +
          `If your model outputs a different dimension, vector operations will fail. ` +
          `Known models: ${Object.keys(EMBEDDING_DIMENSIONS).join(", ")}`,
      );
    }

    // Create metrics collector (no-op when not configured)
    const metrics: MetricsCollector =
      cfg.metrics?.enabled === true
        ? new LoggingMetricsCollector(api.logger, cfg.metrics.logIntervalMs)
        : NO_OP_METRICS;

    // Create shared resources
    const db = new Neo4jMemoryClient(
      cfg.neo4j.uri,
      cfg.neo4j.username,
      cfg.neo4j.password,
      vectorDim,
      api.logger,
    );
    const embeddings = new Embeddings(
      cfg.embedding.apiKey,
      cfg.embedding.model,
      cfg.embedding.provider,
      cfg.embedding.baseUrl,
      api.logger,
      metrics,
    );

    api.logger.debug?.(
      `memory-neo4j: registered (uri: ${cfg.neo4j.uri}, provider: ${cfg.embedding.provider}, model: ${cfg.embedding.model}, ` +
        `extraction: ${extractionConfig.enabled ? extractionConfig.model : "disabled"})`,
    );

    // ========================================================================
    // Tools (using factory pattern for agentId)
    // ========================================================================

    registerMemoryTools(api, db, embeddings, cfg, extractionConfig, api.logger, metrics);

    // ========================================================================
    // CLI Commands (delegated to cli.ts)
    // ========================================================================

    registerCli(api, { db, embeddings, cfg, extractionConfig, vectorDim });

    // ========================================================================
    // Lifecycle Hooks
    // ========================================================================

    const sleepAbortController = new AbortController();
    let sleepCycleRunning = false;
    let cronJob: Cron | null = null;

    registerMemoryHooks(
      api,
      db,
      embeddings,
      cfg,
      extractionConfig,
      sleepAbortController,
      api.logger,
      metrics,
    );

    // ========================================================================
    // Service
    // ========================================================================

    api.registerService({
      id: "memory-neo4j",
      start: async () => {
        try {
          await db.ensureInitialized();
          api.logger.info(
            `memory-neo4j: service started (uri: ${cfg.neo4j.uri}, model: ${cfg.embedding.model})`,
          );
        } catch (err) {
          api.logger.error(
            `memory-neo4j: failed to start — ${String(err)}. Memory tools will attempt lazy initialization.`,
          );
          // Don't throw — allow graceful degradation.
          // Tools will retry initialization on first use.
        }

        if (cfg.sleepCycle.schedule) {
          const schedule = cfg.sleepCycle.schedule;
          const tz = cfg.sleepCycle.tz ?? "local";
          cronJob = new Cron(schedule, { timezone: tz, protect: true }, async () => {
            if (sleepAbortController.signal.aborted) return;
            // protect:true prevents overlapping runs; guard flag is an extra safeguard
            if (sleepCycleRunning) {
              api.logger.debug?.("memory-neo4j: auto sleep-cycle skipped (already running)");
              return;
            }
            sleepCycleRunning = true;
            try {
              api.logger.info("memory-neo4j: starting auto sleep-cycle");
              await runSleepCycle(db, embeddings, extractionConfig, api.logger, {
                abortSignal: sleepAbortController.signal,
              });
              api.logger.info("memory-neo4j: auto sleep-cycle complete");
            } catch (err) {
              api.logger.error(`memory-neo4j: auto sleep-cycle error — ${String(err)}`);
            } finally {
              sleepCycleRunning = false;
            }
          });
          api.logger.info(
            `memory-neo4j: auto sleep-cycle scheduled (cron: ${schedule}, tz: ${tz})`,
          );
        }
      },
      stop: async () => {
        if (cronJob !== null) {
          cronJob.stop();
          cronJob = null;
        }
        sleepAbortController.abort();
        if (metrics instanceof LoggingMetricsCollector) {
          metrics.flush();
          metrics.stop();
        }
        await db.close();
        api.logger.info("memory-neo4j: service stopped");
      },
    });
  },
};

// ============================================================================
// Re-exports for testing (consumers import from index.js)
// ============================================================================

export { _taskLedgerCache, _getActiveTaskIdForCapture } from "./auto-capture.js";
export { _captureMessage, _runAutoCapture } from "./auto-capture.js";

// ============================================================================
// Public API — MetricsCollector for external consumers (e.g. Prometheus adapters)
// ============================================================================

export type { MetricsCollector } from "./metrics.js";
export { NO_OP_METRICS, LoggingMetricsCollector } from "./metrics.js";

// ============================================================================
// Export
// ============================================================================

export default memoryNeo4jPlugin;
