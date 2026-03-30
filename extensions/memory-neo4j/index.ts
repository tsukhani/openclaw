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
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
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
import { cleanupSelfEntityWatchers, registerMemoryHooks } from "./plugin-hooks.js";
import { registerMemoryTools } from "./plugin-tools.js";
import { QueryResultCache } from "./search-cache.js";
import { hybridSearch } from "./search.js";
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
    const extractionConfig = resolveExtractionConfig(cfg.extraction, cfg.disposition);
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

    // M30: Wire search cache to the db client when cache is enabled in config
    if (cfg.cache?.enabled) {
      db.searchCache = new QueryResultCache(cfg.cache.maxSize, cfg.cache.ttlMs);
    }

    api.logger.debug?.(
      `memory-neo4j: registered (uri: ${cfg.neo4j.uri}, provider: ${cfg.embedding.provider}, model: ${cfg.embedding.model}, ` +
        `extraction: ${extractionConfig.enabled ? extractionConfig.model : "disabled"})`,
    );

    if (extractionConfig.enabled) {
      api.logger.debug?.(
        `memory-neo4j: extraction enabled (model: ${extractionConfig.model}). ` +
          `LLM calls will be made for entity extraction, importance rating, and dedup. ` +
          `Override model via extraction.model config or EXTRACTION_MODEL env var.`,
      );
    }

    // ========================================================================
    // Tools (using factory pattern for agentId)
    // ========================================================================

    registerMemoryTools(api, db, embeddings, cfg, extractionConfig, api.logger, metrics);

    // ========================================================================
    // Memory Runtime (doctor probe + status visibility)
    // ========================================================================

    api.registerMemoryRuntime({
      async getMemorySearchManager({ purpose }) {
        // For status probes, verify Neo4j is reachable and fetch summary counts
        // in a single lightweight query (avoids full driver initialization).
        let memoriesCount: number | undefined;
        let entitiesCount: number | undefined;
        if (purpose === "status") {
          const counts = await db.probeStatusCounts();
          if (!counts) {
            return { manager: null, error: "Neo4j connection failed" };
          }
          memoriesCount = counts.memories;
          entitiesCount = counts.entities;
        }
        const manager = {
          status() {
            return {
              backend: "builtin" as const,
              provider: cfg.embedding.provider,
              model: cfg.embedding.model,
              files: memoriesCount,
              chunks: entitiesCount,
              custom: { neo4jUri: cfg.neo4j.uri },
            };
          },
          async probeEmbeddingAvailability() {
            try {
              await embeddings.embed("probe");
              return { ok: true };
            } catch (err) {
              return { ok: false, error: String(err) };
            }
          },
          async probeVectorAvailability() {
            return db.verifyConnection();
          },
          async close() {
            // Don't close shared db/embeddings — owned by the service lifecycle
          },
        };
        return { manager };
      },
      resolveMemoryBackendConfig() {
        return { backend: "builtin" as const };
      },
    });

    // ========================================================================
    // CLI Commands (delegated to cli.ts)
    // ========================================================================

    registerCli(api, { db, embeddings, cfg, extractionConfig, vectorDim });

    // ========================================================================
    // Lifecycle Hooks
    // ========================================================================

    // C1: Use a shared mutable ref so stop() can abort and start() can create a fresh controller.
    // Without this, the signal stays aborted after stop+start and all sleep cycles are skipped.
    // registerMemoryHooks reads abortRef.controller.signal, so replacing the controller
    // on start() gives all closures a live signal automatically.
    const abortRef = { controller: new AbortController() };
    let cronJob: Cron | null = null;
    let healthCheckInterval: ReturnType<typeof setInterval> | null = null;

    const { outstandingCaptures, sessionCleanupInterval } = registerMemoryHooks(
      api,
      db,
      embeddings,
      cfg,
      extractionConfig,
      abortRef,
      api.logger,
      metrics,
    );

    // ========================================================================
    // Service
    // ========================================================================

    api.registerService({
      id: "memory-neo4j",
      start: async () => {
        // C1: Create a fresh AbortController on each start() so the signal is live
        // after a stop/start cycle. All closures read abortRef.controller.signal.
        abortRef.controller = new AbortController();

        try {
          await db.ensureInitialized();

          api.logger.info(
            `memory-neo4j: service started (uri: ${cfg.neo4j.uri}, model: ${cfg.embedding.model})`,
          );

          // Pre-warm embedding cache with core memories so first recall is fast
          if (cfg.autoRecall) {
            try {
              const cores = await db.listCoreForInjection("default");
              if (cores && cores.length > 0) {
                const texts = cores.map((c: { text: string }) => c.text);
                await embeddings.embedBatch(texts);
                api.logger.debug?.(
                  `memory-neo4j: pre-warmed embedding cache with ${texts.length} core memories`,
                );
              }
            } catch (prewarmErr) {
              api.logger.debug?.(
                `memory-neo4j: embedding cache pre-warm failed — ${String(prewarmErr)}`,
              );
            }

            // M27: Warm up Neo4j query plan cache and HNSW index pages so the
            // first real user query doesn't eat the cold-start penalty.
            try {
              await hybridSearch(db, embeddings, "warmup", 1, "default", false, {});
              api.logger.debug?.("memory-neo4j: search warm-up complete");
            } catch {
              // Best-effort — don't block startup
            }
          }
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
          // M10: Croner's protect:true prevents overlapping runs — no manual guard needed
          cronJob = new Cron(schedule, { timezone: tz, protect: true }, async () => {
            if (abortRef.controller.signal.aborted) return;
            try {
              api.logger.info("memory-neo4j: starting auto sleep-cycle");
              await runSleepCycle(db, embeddings, extractionConfig, api.logger, {
                abortSignal: abortRef.controller.signal,
                llmConcurrency: extractionConfig.concurrency,
              });
              api.logger.info("memory-neo4j: auto sleep-cycle complete");
            } catch (err) {
              api.logger.error(`memory-neo4j: auto sleep-cycle error — ${String(err)}`);
            }
          });
          api.logger.info(
            `memory-neo4j: auto sleep-cycle scheduled (cron: ${schedule}, tz: ${tz})`,
          );
        }

        // L3: Clear any leaked interval from a previous start() without stop()
        if (healthCheckInterval !== null) {
          clearInterval(healthCheckInterval);
        }
        // Periodic connection pool health check
        healthCheckInterval = setInterval(async () => {
          try {
            await db.verifyConnection();
          } catch (healthErr) {
            api.logger.debug?.(
              `memory-neo4j: connection health check failed — ${String(healthErr)}`,
            );
          }
        }, 60_000);
        healthCheckInterval.unref();
      },
      stop: async () => {
        if (cronJob !== null) {
          cronJob.stop();
          cronJob = null;
        }
        if (healthCheckInterval !== null) {
          clearInterval(healthCheckInterval);
          healthCheckInterval = null;
        }
        clearInterval(sessionCleanupInterval);
        abortRef.controller.abort();
        if (metrics instanceof LoggingMetricsCollector) {
          metrics.flush();
          metrics.stop();
        }

        // OP-135: Drain in-flight auto-capture promises before closing DB.
        // Without this, fire-and-forget captures that passed their last
        // signal.aborted check throw "driver already closed" mid-write,
        // leaving memories stuck in extractionStatus='pending' forever.
        if (outstandingCaptures.size > 0) {
          api.logger.info(
            `memory-neo4j: draining ${outstandingCaptures.size} in-flight auto-capture(s)...`,
          );
          const DRAIN_TIMEOUT_MS = 10_000;
          // L4: Track timeout so we can clear it after the race to prevent orphan timers
          let drainTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              Promise.allSettled([...outstandingCaptures]),
              new Promise((resolve) => {
                drainTimer = setTimeout(resolve, DRAIN_TIMEOUT_MS);
              }),
            ]);
          } finally {
            if (drainTimer) clearTimeout(drainTimer);
          }
          if (outstandingCaptures.size > 0) {
            api.logger.warn(
              `memory-neo4j: drain timeout — ${outstandingCaptures.size} capture(s) still in-flight, proceeding with shutdown`,
            );
          }
        }

        cleanupSelfEntityWatchers();
        await db.close();
        api.logger.info("memory-neo4j: service stopped");
      },
    });
  },
};

// L5: Test-only re-exports moved to ./_testing.ts to keep the public API clean.
// Tests should import from "./_testing.js" instead of "./index.js".

// ============================================================================
// Public API — MetricsCollector for external consumers (e.g. Prometheus adapters)
// ============================================================================

export type { MetricsCollector } from "./metrics.js";
export { NO_OP_METRICS, LoggingMetricsCollector } from "./metrics.js";

// ============================================================================
// Export
// ============================================================================

export default memoryNeo4jPlugin;
