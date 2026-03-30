/**
 * Memory tool registrations for the memory-neo4j plugin.
 *
 * Registers: memory_recall, memory_store, memory_forget
 */

import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/memory-neo4j";
import { stringEnum } from "openclaw/plugin-sdk/memory-neo4j";
import type { ExtractionConfig, MemoryNeo4jConfig } from "./config.js";
import { MEMORY_CATEGORIES } from "./config.js";
import type { Embeddings } from "./embeddings.js";
import { isNeo4jConnectionError } from "./errors.js";
import { decomposeIntoAtomicFacts } from "./extractor.js";
import { detectInstructionPattern } from "./instruction-detector.js";
import type { MetricsCollector } from "./metrics.js";
import { NO_OP_METRICS } from "./metrics.js";
import { queryEpisodes } from "./neo4j-client-episode.js";
import type { Neo4jMemoryClient } from "./neo4j-client.js";
import { resolveSelfEntityName } from "./plugin-hooks.js";
import type { Logger, MemoryCategory, MemorySource } from "./schema.js";
import { buildSearchOptions, hybridSearch } from "./search.js";

/**
 * Shared wrapper for tool operations that may fail due to Neo4j connection errors.
 * Catches connection errors and returns a fallback response; rethrows all others.
 */
async function withConnectionGuard<T>(
  logger: Logger,
  metrics: MetricsCollector,
  operation: string,
  fn: () => Promise<T>,
  fallbackResponse: T,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isNeo4jConnectionError(err)) {
      logger.error(`memory-neo4j: ${operation} failed (Neo4j connection error) — ${String(err)}`);
      metrics.increment(`${operation}.connection_errors`);
      return fallbackResponse;
    }
    logger.error(`memory-neo4j: ${operation} failed (non-connection error) — ${String(err)}`);
    throw err;
  }
}

export function registerMemoryTools(
  api: OpenClawPluginApi,
  db: Neo4jMemoryClient,
  embeddings: Embeddings,
  cfg: MemoryNeo4jConfig,
  extractionConfig: ExtractionConfig,
  logger: Logger,
  metrics: MetricsCollector = NO_OP_METRICS,
): void {
  // memory_recall — Three-signal hybrid search
  api.registerTool(
    (ctx) => {
      const agentId = ctx.agentId || "default";
      return {
        name: "memory_recall",
        label: "Memory Recall",
        description:
          "Search through long-term memories. Use when you need context about user preferences, past decisions, or previously discussed topics.",
        parameters: Type.Object({
          query: Type.String({ description: "Search query" }),
          limit: Type.Optional(Type.Number({ description: "Max results (default: 5)" })),
          includeExpired: Type.Optional(
            Type.Boolean({ description: "Include superseded/expired memories (default: false)" }),
          ),
          asOf: Type.Optional(
            Type.String({
              description:
                "ISO-8601 date — recall memories valid at this point in time (e.g. 2026-01-01)",
            }),
          ),
          includeQuarantined: Type.Optional(
            Type.Boolean({
              description:
                "Include quarantined memories (flagged as instruction-like). Default: false",
            }),
          ),
        }),
        async execute(_toolCallId: string, params: unknown) {
          const {
            query,
            limit: rawLimit = 5,
            includeExpired = false,
            asOf,
            includeQuarantined = false,
          } = params as {
            query: string;
            limit?: number;
            includeExpired?: boolean;
            asOf?: string;
            includeQuarantined?: boolean;
          };
          // H9: Guard against NaN from non-numeric input (NaN propagates through Math.min/max)
          const limit = Number.isFinite(rawLimit)
            ? Math.floor(Math.min(50, Math.max(1, rawLimit)))
            : 5;

          // H11: Validate asOf is a parseable ISO-8601 date to prevent silent incorrect temporal results
          const validatedAsOf = asOf
            ? Number.isNaN(Date.parse(asOf))
              ? undefined
              : asOf
            : undefined;

          const recallResult = await withConnectionGuard(
            logger,
            metrics,
            "recall",
            async () => {
              const t0Recall = performance.now();
              // C6: Config selfEntityName takes priority; fall back to USER.md resolution
              const selfEntityName =
                cfg.selfEntityName ??
                (ctx.workspaceDir ? await resolveSelfEntityName(ctx.workspaceDir) : undefined);

              const r = await hybridSearch(
                db,
                embeddings,
                query,
                limit,
                agentId,
                extractionConfig.enabled,
                buildSearchOptions({
                  cfg,
                  extractionConfig,
                  db,
                  logger,
                  selfEntityName,
                  includeExpired,
                  asOf: validatedAsOf,
                  includeQuarantined,
                }),
              );
              metrics.histogram("auto_recall.latency_ms", performance.now() - t0Recall);
              metrics.increment("memories.recalled", r.length);
              return r;
            },
            null,
          );
          if (recallResult === null) {
            return {
              content: [
                {
                  type: "text",
                  text: "Memory service temporarily unavailable (Neo4j connection error). Memories could not be searched.",
                },
              ],
              details: { count: 0, error: "neo4j_connection" },
            };
          }
          const results = recallResult;

          if (results.length === 0) {
            return {
              content: [{ type: "text", text: "No relevant memories found." }],
              details: { count: 0 },
            };
          }

          const text = results
            .map((r, i) => {
              const base = `${i + 1}. [${r.category}] ${r.text} (${(r.score * 100).toFixed(0)}%)`;
              if (!r.signals) return base;
              const parts: string[] = [];
              if (r.signals.vector.rank > 0) parts.push(`vec:#${r.signals.vector.rank}`);
              if (r.signals.bm25.rank > 0) parts.push(`bm25:#${r.signals.bm25.rank}`);
              if (r.signals.graph.rank > 0) parts.push(`graph:#${r.signals.graph.rank}`);
              return parts.length > 0 ? `${base} [${parts.join(" ")}]` : base;
            })
            .join("\n");

          const sanitizedResults = results.map((r) => ({
            id: r.id,
            text: r.text,
            category: r.category,
            importance: r.importance,
            score: r.score,
          }));

          return {
            content: [
              {
                type: "text",
                text: `Found ${results.length} memories:\n\n${text}`,
              },
            ],
            details: { count: results.length, memories: sanitizedResults },
          };
        },
      };
    },
    { name: "memory_recall" },
  );

  // memory_store — Store with background entity extraction
  api.registerTool(
    (ctx) => {
      const agentId = ctx.agentId || "default";
      const sessionKey = ctx.sessionKey;
      return {
        name: "memory_store",
        label: "Memory Store",
        description:
          "Save important information in long-term memory. Use for preferences, facts, decisions.",
        parameters: Type.Object({
          text: Type.String({ description: "Information to remember" }),
          importance: Type.Optional(
            Type.Number({
              description: "Importance 0-1 (default: 0.7)",
            }),
          ),
          category: Type.Optional(stringEnum(MEMORY_CATEGORIES)),
        }),
        async execute(_toolCallId: string, params: unknown) {
          const {
            text,
            importance = 0.7,
            category = "other",
          } = params as {
            text: string;
            importance?: number;
            category?: MemoryCategory;
          };

          // Minimum text length to bother decomposing — short messages are already atomic
          const DECOMPOSE_MIN_CHARS = 200;
          // Cap decomposed facts per store call (same as auto-capture)
          const MAX_DECOMPOSED_FACTS = 5;

          // 1. Attempt atomic fact decomposition for long texts
          if (cfg.decomposition.enabled && text.length >= DECOMPOSE_MIN_CHARS) {
            const facts = await decomposeIntoAtomicFacts(text, extractionConfig);
            if (facts && facts.length > 1) {
              const capped = facts.slice(0, MAX_DECOMPOSED_FACTS);
              logger.info(
                `memory-neo4j: memory_store decomposed "${text.slice(0, 60)}..." into ${capped.length} atomic facts`,
              );

              const storedIds: string[] = [];
              for (const fact of capped) {
                // Each fact gets its own embedding
                const factVector = await embeddings.embed(fact);

                // Per-fact dedup check
                const existing = await withConnectionGuard(
                  logger,
                  metrics,
                  "store",
                  () => db.findSimilar(factVector, 0.95, 1, agentId),
                  null,
                );
                if (existing === null) {
                  return {
                    content: [
                      {
                        type: "text",
                        text: "Memory service temporarily unavailable (Neo4j connection error). Memory could not be saved.",
                      },
                    ],
                    details: { action: "error", error: "neo4j_connection" },
                  };
                }
                if (existing.length > 0) {
                  logger.debug?.(
                    `memory-neo4j: decomposed fact skipped (duplicate): "${fact.slice(0, 60)}..."`,
                  );
                  continue;
                }

                // Instruction-pattern detection per fact
                const instrResult =
                  cfg.instructionDetection?.enabled !== false
                    ? detectInstructionPattern(fact)
                    : { flagged: false as const };
                const isQuarantined = instrResult.flagged;

                const factId = randomUUID();
                const storeResult = await withConnectionGuard(
                  logger,
                  metrics,
                  "store",
                  async () => {
                    await db.storeMemory({
                      id: factId,
                      text: fact,
                      embedding: factVector,
                      importance:
                        category === "core"
                          ? 1.0
                          : Number.isFinite(importance)
                            ? Math.min(1, Math.max(0, importance))
                            : 0.7,
                      category,
                      source: "user" as MemorySource,
                      extractionStatus: extractionConfig.enabled ? "pending" : "skipped",
                      agentId,
                      sessionKey,
                      ...(isQuarantined ? { trustScore: 0.0, quarantined: true } : {}),
                    });
                    return true;
                  },
                  false,
                );
                if (!storeResult) {
                  return {
                    content: [
                      {
                        type: "text",
                        text: "Memory service temporarily unavailable (Neo4j connection error). Memory could not be saved.",
                      },
                    ],
                    details: { action: "error", error: "neo4j_connection" },
                  };
                }
                storedIds.push(factId);
                metrics.increment("memories.stored");
              }

              if (storedIds.length === 0) {
                return {
                  content: [
                    {
                      type: "text",
                      text: "All decomposed facts were duplicates of existing memories.",
                    },
                  ],
                  details: { action: "duplicate", decomposed: true },
                };
              }

              return {
                content: [
                  {
                    type: "text",
                    text: `Stored ${storedIds.length} atomic facts from: "${text.slice(0, 100)}${text.length > 100 ? "..." : ""}"`,
                  },
                ],
                details: {
                  action: "created",
                  ids: storedIds,
                  decomposed: true,
                  factCount: storedIds.length,
                },
              };
            }
          }

          // Fallback: store original text as-is (no decomposition or < 2 facts returned)

          // 1. Generate embedding (uses OpenAI — not a Neo4j call, so don't catch as connection error)
          const vector = await embeddings.embed(text);

          // 2. Check for duplicates (vector similarity > 0.95)
          const existing = await withConnectionGuard(
            logger,
            metrics,
            "store",
            () => db.findSimilar(vector, 0.95, 1, agentId),
            null,
          );
          if (existing === null) {
            return {
              content: [
                {
                  type: "text",
                  text: "Memory service temporarily unavailable (Neo4j connection error). Memory could not be saved.",
                },
              ],
              details: { action: "error", error: "neo4j_connection" },
            };
          }
          if (existing.length > 0) {
            return {
              content: [
                {
                  type: "text",
                  text: `Similar memory already exists: "${existing[0].text}"`,
                },
              ],
              details: {
                action: "duplicate",
                existingId: existing[0].id,
                existingText: existing[0].text,
              },
            };
          }

          // 3. Instruction-pattern detection (quarantine flagged memories)
          const instrResult =
            cfg.instructionDetection?.enabled !== false
              ? detectInstructionPattern(text)
              : { flagged: false as const };
          const isQuarantined = instrResult.flagged;
          if (isQuarantined) {
            logger.debug?.(
              `memory-neo4j: instruction-pattern detected in memory_store — quarantining`,
            );
          }

          // 4. Store memory immediately (fast path)
          // Core memories get importance locked at 1.0 and are immune from
          // decay and pruning (filtered by category in the sleep cycle).
          const memoryId = randomUUID();
          const storeResult = await withConnectionGuard(
            logger,
            metrics,
            "store",
            async () => {
              await db.storeMemory({
                id: memoryId,
                text,
                embedding: vector,
                // H9: Guard against NaN importance — default to 0.7 if non-finite
                importance:
                  category === "core"
                    ? 1.0
                    : Number.isFinite(importance)
                      ? Math.min(1, Math.max(0, importance))
                      : 0.7,
                category,
                source: "user" as MemorySource,
                extractionStatus: extractionConfig.enabled ? "pending" : "skipped",
                agentId,
                sessionKey,
                ...(isQuarantined ? { trustScore: 0.0, quarantined: true } : {}),
              });
              return true;
            },
            false,
          );
          if (!storeResult) {
            return {
              content: [
                {
                  type: "text",
                  text: "Memory service temporarily unavailable (Neo4j connection error). Memory could not be saved.",
                },
              ],
              details: { action: "error", error: "neo4j_connection" },
            };
          }

          // 5. Conflict detection: check if this memory supersedes existing ones
          let supersededCount = 0;
          if (cfg.conflictDetection.enabled) {
            try {
              supersededCount = await db.detectConflicts(
                memoryId,
                text,
                vector,
                agentId,
                extractionConfig,
                {
                  similarityThreshold: cfg.conflictDetection.similarityThreshold,
                  maxCandidates: cfg.conflictDetection.maxCandidates,
                },
              );
            } catch (err) {
              // Non-fatal — log but don't fail the store
              logger.warn(`memory-neo4j: conflict detection failed: ${String(err)}`);
            }
          }

          // 6. Extraction is deferred to sleep cycle (like human memory consolidation)
          // See: runSleepCycleExtraction() and `openclaw memory sleep` command

          metrics.increment("memories.stored");
          if (supersededCount > 0) {
            metrics.increment("conflicts.superseded", supersededCount);
          }

          const quarantineNote = isQuarantined
            ? " [quarantined: instruction-like pattern detected]"
            : "";
          return {
            content: [
              {
                type: "text",
                text: `Stored: "${text.slice(0, 100)}${text.length > 100 ? "..." : ""}"${supersededCount > 0 ? ` (superseded ${supersededCount} older ${supersededCount === 1 ? "memory" : "memories"})` : ""}${quarantineNote}`,
              },
            ],
            details: {
              action: "created",
              id: memoryId,
              supersededCount,
              quarantined: isQuarantined,
            },
          };
        },
      };
    },
    { name: "memory_store" },
  );

  // memory_forget — Delete with cascade
  api.registerTool(
    (ctx) => {
      const agentId = ctx.agentId || "default";
      return {
        name: "memory_forget",
        label: "Memory Forget",
        description: "Delete specific memories. GDPR-compliant.",
        parameters: Type.Object({
          query: Type.Optional(Type.String({ description: "Search to find memory" })),
          memoryId: Type.Optional(Type.String({ description: "Specific memory ID" })),
        }),
        async execute(_toolCallId: string, params: unknown) {
          const { query, memoryId } = params as {
            query?: string;
            memoryId?: string;
          };

          // Direct delete by ID
          if (memoryId) {
            try {
              const deleted = await db.deleteMemory(memoryId, agentId);
              if (!deleted) {
                return {
                  content: [
                    {
                      type: "text",
                      text: `Memory ${memoryId} not found.`,
                    },
                  ],
                  details: { action: "not_found", id: memoryId },
                };
              }
              return {
                content: [
                  {
                    type: "text",
                    text: `Memory ${memoryId} forgotten.`,
                  },
                ],
                details: { action: "deleted", id: memoryId },
              };
            } catch (err) {
              if (isNeo4jConnectionError(err)) {
                logger.error(
                  `memory-neo4j: forget failed (Neo4j connection error) — ${String(err)}`,
                );
                return {
                  content: [
                    {
                      type: "text",
                      text: "Memory service temporarily unavailable (Neo4j connection error). Memory could not be deleted.",
                    },
                  ],
                  details: { action: "error", error: "neo4j_connection" },
                };
              }
              throw err;
            }
          }

          // Search-based delete
          if (query) {
            const searchResult = await withConnectionGuard(
              logger,
              metrics,
              "forget_search",
              async () => {
                const v = await embeddings.embed(query);
                return { vector: v, results: await db.vectorSearch(v, 5, 0.7, agentId) };
              },
              null,
            );
            if (searchResult === null) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Memory service temporarily unavailable (Neo4j connection error). Memory search for deletion failed.",
                  },
                ],
                details: { action: "error", error: "neo4j_connection" },
              };
            }
            const { results } = searchResult;

            if (results.length === 0) {
              return {
                content: [{ type: "text", text: "No matching memories found." }],
                details: { found: 0 },
              };
            }

            // L12: Auto-delete only on very high confidence (0.97 threshold —
            // 0.95 can match similar but distinct memories, risking unintended deletion)
            if (results.length === 1 && results[0].score > 0.97) {
              const deleteOk = await withConnectionGuard(
                logger,
                metrics,
                "forget_delete",
                async () => {
                  await db.deleteMemory(results[0].id, agentId);
                  return true;
                },
                false,
              );
              if (!deleteOk) {
                return {
                  content: [
                    {
                      type: "text",
                      text: "Memory service temporarily unavailable (Neo4j connection error). Memory could not be deleted.",
                    },
                  ],
                  details: { action: "error", error: "neo4j_connection" },
                };
              }
              return {
                content: [
                  {
                    type: "text",
                    text: `Forgotten: "${results[0].text}"`,
                  },
                ],
                details: { action: "deleted", id: results[0].id },
              };
            }

            // Multiple candidates — ask user to specify
            const list = results.map((r) => `- [${r.id}] ${r.text.slice(0, 60)}...`).join("\n");

            const sanitizedCandidates = results.map((r) => ({
              id: r.id,
              text: r.text,
              category: r.category,
              score: r.score,
            }));

            return {
              content: [
                {
                  type: "text",
                  text: `Found ${results.length} candidates. Specify memoryId:\n${list}`,
                },
              ],
              details: {
                action: "candidates",
                candidates: sanitizedCandidates,
              },
            };
          }

          return {
            content: [{ type: "text", text: "Provide query or memoryId." }],
            details: { error: "missing_param" },
          };
        },
      };
    },
    { name: "memory_forget" },
  );

  // memory_episodes — Query episodic memory tier (opt-in)
  if (cfg.episodicMemory?.enabled) {
    api.registerTool(
      (ctx) => {
        const agentId = ctx.agentId || "default";
        return {
          name: "memory_episodes",
          label: "Memory Episodes",
          description:
            "Retrieve raw conversation episodes (non-lossy). Use when you need exact wording or full context from past conversations.",
          parameters: Type.Object({
            sessionKey: Type.Optional(Type.String({ description: "Filter by session key" })),
            from: Type.Optional(
              Type.String({ description: "ISO-8601 start date for time range filter" }),
            ),
            to: Type.Optional(
              Type.String({ description: "ISO-8601 end date for time range filter" }),
            ),
            limit: Type.Optional(Type.Number({ description: "Max results (default: 50)" })),
          }),
          async execute(_toolCallId: string, params: unknown) {
            const {
              sessionKey,
              from,
              to,
              limit: rawLimit = 50,
            } = params as {
              sessionKey?: string;
              from?: string;
              to?: string;
              limit?: number;
            };
            // H9: Guard against NaN from non-numeric input
            const limit = Number.isFinite(rawLimit)
              ? Math.floor(Math.min(200, Math.max(1, rawLimit)))
              : 50;

            // M27: Validate ISO-8601 dates
            const validFrom = from && !Number.isNaN(Date.parse(from)) ? from : undefined;
            const validTo = to && !Number.isNaN(Date.parse(to)) ? to : undefined;

            const episodes = await withConnectionGuard(
              logger,
              metrics,
              "episode_recall",
              async () => {
                const session = await db.createSession();
                try {
                  return await queryEpisodes(session, agentId, {
                    sessionKey,
                    from: validFrom,
                    to: validTo,
                    limit,
                  });
                } finally {
                  await session.close();
                }
              },
              null,
            );
            if (episodes === null) {
              return {
                content: [{ type: "text", text: "Episode service temporarily unavailable." }],
                details: { count: 0, error: "neo4j_connection" },
              };
            }

            if (episodes.length === 0) {
              return {
                content: [{ type: "text", text: "No episodes found for the specified filters." }],
                details: { count: 0 },
              };
            }

            const text = episodes
              .map(
                (e, i) =>
                  `${i + 1}. [${e.role}] ${e.text.slice(0, 200)}${e.text.length > 200 ? "..." : ""} (${e.timestamp})`,
              )
              .join("\n");

            return {
              content: [{ type: "text", text: `Found ${episodes.length} episodes:\n\n${text}` }],
              details: {
                count: episodes.length,
                episodes: episodes.map((e) => ({
                  id: e.id,
                  role: e.role,
                  text: e.text,
                  timestamp: e.timestamp,
                })),
              },
            };
          },
        };
      },
      { name: "memory_episodes" },
    );
  }
}
