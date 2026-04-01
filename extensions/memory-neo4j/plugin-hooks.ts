/**
 * Event hook registrations for the memory-neo4j plugin.
 *
 * Registers: after_compaction, session_end, before_prompt_build (×1, merged), agent_bootstrap, agent_end
 */

import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/memory-neo4j";
import { runAutoCapture } from "./auto-capture.js";
import type { ExtractionConfig, MemoryNeo4jConfig } from "./config.js";
import type { Embeddings } from "./embeddings.js";
import { isNeo4jConnectionError } from "./errors.js";
import { extractUserMessages, extractAssistantMessages } from "./message-utils.js";
import type { MetricsCollector } from "./metrics.js";
import { NO_OP_METRICS } from "./metrics.js";
import { mergeEpisode } from "./neo4j-client-episode.js";
import type { Neo4jMemoryClient } from "./neo4j-client.js";
import type { Logger } from "./schema.js";
import { buildSearchOptions, hybridSearch } from "./search.js";

/**
 * Detect system-generated prompts that should skip auto-recall.
 * These are injected by OpenClaw for session startup (/new, /reset) and heartbeat polls.
 * They are not user queries and will never match useful memories.
 * Matched via `includes()` rather than `startsWith()` because system events or
 * post-compaction recovery content may be prepended before these markers.
 */
const SYSTEM_PROMPT_MARKERS = [
  "A new session was started",
  "Read HEARTBEAT.md",
  "Heartbeat prompt:",
  "Run your Session Startup",
];

function isSystemPrompt(prompt: string): boolean {
  // Use includes() rather than startsWith() because the prompt may have
  // system events or post-compaction recovery content prepended to it
  // before it reaches the hook, which would break prefix-based detection
  // and cause the full auto-recall pipeline (~1.5-3.5s) to run unnecessarily.
  // L9: Only check short prompts (< 2000 chars) — longer user messages are unlikely
  // to be system prompts and checking them increases false-positive risk from
  // user text accidentally containing marker strings.
  if (prompt.length > 2000) return false;
  return SYSTEM_PROMPT_MARKERS.some((marker) => prompt.includes(marker));
}

// Cache of workspaceDir → resolved user entity name from USER.md.
// Invalidated by fs.watch when the file changes, with TTL fallback (5 min).
// Capped at 100 entries to prevent unbounded growth across workspaces.
const selfEntityCache = new Map<string, { name: string | null; expiresAt: number }>();
const SELF_ENTITY_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const SELF_ENTITY_CACHE_MAX_SIZE = 100;
// Track active fs.watch instances to avoid duplicate watchers per workspace.
const selfEntityWatchers = new Map<string, fsSync.FSWatcher>();
// Track debounce timers so cleanup can cancel pending invalidations.
const selfEntityDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const WATCH_DEBOUNCE_MS = 100;

/**
 * Close all active fs.watch instances and clear the cache.
 * Called during plugin stop to prevent file descriptor leaks.
 */
export function cleanupSelfEntityWatchers(): void {
  for (const timer of selfEntityDebounceTimers.values()) {
    clearTimeout(timer);
  }
  selfEntityDebounceTimers.clear();
  for (const watcher of selfEntityWatchers.values()) {
    watcher.close();
  }
  selfEntityWatchers.clear();
  selfEntityCache.clear();
}

/**
 * Set up a file watcher on USER.md to invalidate the cache on change.
 * Debounces to 100ms to handle platform quirks (double-fire on Linux).
 * Falls back gracefully if watch fails (TTL still provides invalidation).
 */
function watchUserMd(workspaceDir: string): void {
  if (selfEntityWatchers.has(workspaceDir)) return;
  const userMdPath = path.join(workspaceDir, "USER.md");
  try {
    const watcher = fsSync.watch(userMdPath, () => {
      const existing = selfEntityDebounceTimers.get(workspaceDir);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        selfEntityDebounceTimers.delete(workspaceDir);
        selfEntityCache.delete(workspaceDir);
      }, WATCH_DEBOUNCE_MS);
      selfEntityDebounceTimers.set(workspaceDir, timer);
    });
    watcher.on("error", () => {
      // File deleted or watch failed — clean up, TTL fallback handles it
      selfEntityWatchers.delete(workspaceDir);
      watcher.close();
    });
    selfEntityWatchers.set(workspaceDir, watcher);
  } catch {
    // fs.watch not available or file doesn't exist yet — TTL fallback handles it
  }
}

/**
 * Resolve the user's entity name from USER.md in the agent's workspace.
 * Parses the `**Name:**` field and normalizes to lowercase for graph lookup.
 * Returns null if USER.md doesn't exist or has no Name field.
 * Results are cached with fs.watch invalidation + TTL fallback (5 min).
 */
export async function resolveSelfEntityName(workspaceDir: string): Promise<string | null> {
  const cached = selfEntityCache.get(workspaceDir);
  if (cached && Date.now() < cached.expiresAt) {
    // L9: Refresh expiresAt on read so frequently-accessed entries aren't evicted as "oldest"
    cached.expiresAt = Date.now() + SELF_ENTITY_CACHE_TTL_MS;
    return cached.name;
  }
  let name: string | null = null;
  try {
    const userMdPath = path.join(workspaceDir, "USER.md");
    const content = await fs.readFile(userMdPath, "utf-8");
    // Match "**Name:** value" or "- **Name:** value" patterns
    const match = content.match(/\*\*Name:\*\*\s*(.+)/i);
    if (match) {
      const raw = match[1].trim();
      // Skip template placeholders
      if (raw && !raw.startsWith("{{")) {
        name = raw.toLowerCase();
      }
    }
    // Set up watcher for instant invalidation on file change
    watchUserMd(workspaceDir);
  } catch {
    // USER.md doesn't exist or is unreadable
  }
  // L9: Evict by earliest expiresAt (approximate LRU) instead of FIFO insertion order.
  // Entries refreshed on read have later expiresAt, so the earliest is least-recently-used.
  if (selfEntityCache.size >= SELF_ENTITY_CACHE_MAX_SIZE) {
    let oldestKey: string | undefined;
    let oldestExpiry = Infinity;
    for (const [key, entry] of selfEntityCache) {
      if (entry.expiresAt < oldestExpiry) {
        oldestExpiry = entry.expiresAt;
        oldestKey = key;
      }
    }
    if (oldestKey !== undefined) selfEntityCache.delete(oldestKey);
  }
  selfEntityCache.set(workspaceDir, { name, expiresAt: Date.now() + SELF_ENTITY_CACHE_TTL_MS });
  return name;
}

/**
 * Pure decision function for mid-session core memory refresh.
 * Exported for unit testing so tests exercise the real logic path.
 */
export function _shouldRefreshForTest(params: {
  contextWindowTokens: number | undefined;
  estimatedUsedTokens: number | undefined;
  refreshThreshold: number;
  lastRefreshTokens: number;
  minTokensSinceRefresh: number;
}): boolean {
  const {
    contextWindowTokens,
    estimatedUsedTokens,
    refreshThreshold,
    lastRefreshTokens,
    minTokensSinceRefresh,
  } = params;
  if (!contextWindowTokens || !estimatedUsedTokens) {
    return false;
  }
  const usagePercent = (estimatedUsedTokens / contextWindowTokens) * 100;
  if (usagePercent < refreshThreshold) {
    return false;
  }
  const tokensSinceRefresh = estimatedUsedTokens - lastRefreshTokens;
  if (tokensSinceRefresh < minTokensSinceRefresh) {
    return false;
  }
  return true;
}

export function registerMemoryHooks(
  api: OpenClawPluginApi,
  db: Neo4jMemoryClient,
  embeddings: Embeddings,
  cfg: MemoryNeo4jConfig,
  extractionConfig: ExtractionConfig,
  abortRef: { controller: AbortController },
  logger: Logger,
  metrics: MetricsCollector = NO_OP_METRICS,
): {
  outstandingCaptures: Set<Promise<void>>;
  sessionCleanupInterval: ReturnType<typeof setInterval>;
} {
  // Track sessions where core memories have already been loaded (skip on subsequent turns).
  // NOTE: This is in-memory and will be cleared on gateway restart. The agent_bootstrap
  // hook below also checks for existing conversation history to avoid re-injecting core
  // memories after restarts.
  const bootstrappedSessions = new Set<string>();

  // OP-135: Track in-flight auto-capture promises so stop() can drain them
  // before closing the database connection.
  const outstandingCaptures = new Set<Promise<void>>();

  // Track mid-session refresh: maps sessionKey → tokens at last refresh
  // Used to avoid refreshing too frequently (only refresh after significant context growth)
  const midSessionRefreshAt = new Map<string, number>();
  const MIN_TOKENS_SINCE_REFRESH = 10_000; // Only refresh if context grew by 10k+ tokens

  // Track session timestamps for TTL-based cleanup. Without this, bootstrappedSessions
  // and midSessionRefreshAt leak entries for sessions that ended without an explicit
  // after_compaction event (e.g., normal session end on long-running gateways).
  const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
  const sessionLastSeen = new Map<string, number>();

  /** Evict stale entries from session tracking maps older than SESSION_TTL_MS. */
  function pruneStaleSessionEntries(): void {
    const now = Date.now();
    const cutoff = now - SESSION_TTL_MS;
    for (const [key, ts] of sessionLastSeen) {
      if (ts < cutoff) {
        bootstrappedSessions.delete(key);
        midSessionRefreshAt.delete(key);
        sessionLastSeen.delete(key);
      }
    }
  }

  // L6: Throttle pruneStaleSessionEntries to avoid O(n) scan on every hook fire
  let lastPruneAt = 0;
  const PRUNE_THROTTLE_MS = 60_000; // At most once per minute

  /** Mark a session as recently active for TTL tracking. */
  function touchSession(sessionKey: string): void {
    sessionLastSeen.set(sessionKey, Date.now());
    const now = Date.now();
    if (now - lastPruneAt >= PRUNE_THROTTLE_MS) {
      lastPruneAt = now;
      pruneStaleSessionEntries();
    }
  }

  // OP-136: Proactive session cleanup interval to prevent unbounded growth
  // of session tracking maps on high-volume gateways. Without this, stale
  // entries are only evicted on touchSession() calls, which may not happen
  // frequently enough for sessions that ended without explicit cleanup events.
  const SESSION_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
  const sessionCleanupInterval = setInterval(() => {
    pruneStaleSessionEntries();
  }, SESSION_CLEANUP_INTERVAL_MS);
  // Allow the process to exit even if the interval is still scheduled
  if (typeof sessionCleanupInterval === "object" && "unref" in sessionCleanupInterval) {
    sessionCleanupInterval.unref();
  }

  // After compaction: clear bootstrap flag and mid-session refresh tracking
  if (cfg.coreMemory.enabled) {
    api.on("after_compaction", async (_event, ctx) => {
      if (ctx.sessionKey) {
        bootstrappedSessions.delete(ctx.sessionKey);
        midSessionRefreshAt.delete(ctx.sessionKey);
        sessionLastSeen.delete(ctx.sessionKey);
        logger.info?.(
          `memory-neo4j: cleared bootstrap/refresh flags for session ${ctx.sessionKey} after compaction`,
        );
      }
    });
  }

  // Session end: clear bootstrap flag so core memories are re-injected on the next turn.
  // Fired by /new and /reset commands. Uses sessionKey (which is how bootstrappedSessions
  // is keyed), with sessionId as fallback for implementations that only provide sessionId.
  api.on("session_end", async (_event, ctx) => {
    const key = ctx.sessionKey ?? ctx.sessionId;
    if (key) {
      bootstrappedSessions.delete(key);
      midSessionRefreshAt.delete(key);
      sessionLastSeen.delete(key);
      logger.info?.(
        `memory-neo4j: cleared bootstrap/refresh flags for session=${key} (session_end)`,
      );
    }
  });

  // Merged before_agent_start: mid-session core-memory refresh + auto-recall.
  //
  // Both concerns are combined into a single handler to avoid the "last writer wins"
  // SDK risk where two separate handlers each return prependContext and only the
  // second one takes effect. Both blocks run independently (guarded by their own
  // config flags) and their context strings are concatenated into one prependContext.
  const refreshThreshold = cfg.coreMemory.refreshAtContextPercent;
  const wantCoreRefresh = cfg.coreMemory.enabled && !!refreshThreshold;
  const wantAutoRecall = cfg.autoRecall;

  logger.debug?.(`memory-neo4j: autoRecall=${cfg.autoRecall}`);

  if (wantCoreRefresh) {
    logger.debug?.(
      `memory-neo4j: registering before_prompt_build hook for mid-session core refresh at ${refreshThreshold}%`,
    );
  }
  if (wantAutoRecall) {
    logger.debug?.("memory-neo4j: registering before_prompt_build hook for auto-recall");
  }

  if (wantCoreRefresh || wantAutoRecall) {
    api.on("before_prompt_build", async (event, ctx) => {
      const parts: string[] = [];

      // --- Branch 1: Mid-session core-memory refresh ---
      // Re-inject core memories when context grows past threshold to counter "lost in the middle".
      if (wantCoreRefresh && event.contextWindowTokens && event.estimatedUsedTokens) {
        const sessionKey = ctx.sessionKey ?? "";
        const agentId = ctx.agentId || "default";
        const usagePercent = (event.estimatedUsedTokens / event.contextWindowTokens) * 100;

        if (usagePercent >= refreshThreshold!) {
          const lastRefreshTokens = midSessionRefreshAt.get(sessionKey) ?? 0;
          const tokensSinceRefresh = event.estimatedUsedTokens - lastRefreshTokens;
          if (tokensSinceRefresh < MIN_TOKENS_SINCE_REFRESH) {
            logger.debug?.(
              `memory-neo4j: skipping mid-session refresh (only ${tokensSinceRefresh} tokens since last refresh)`,
            );
          } else {
            try {
              const t0 = performance.now();
              const coreMemories = await db.listCoreForInjection(agentId);

              if (coreMemories.length > 0) {
                midSessionRefreshAt.set(sessionKey, event.estimatedUsedTokens);
                touchSession(sessionKey);

                const content = coreMemories.map((m) => `- ${m.text}`).join("\n");
                const totalMs = performance.now() - t0;
                logger.info?.(
                  `memory-neo4j: [bench] core-refresh ${totalMs.toFixed(0)}ms at ${usagePercent.toFixed(1)}% context (${coreMemories.length} memories)`,
                );

                parts.push(
                  `<core-memory-refresh>\nReminder of persistent context (you may have seen this earlier, re-stating for recency):\n${content}\n</core-memory-refresh>`,
                );
              }
            } catch (err) {
              logger.warn(`memory-neo4j: mid-session core refresh failed: ${String(err)}`);
            }
          }
        }
      }

      // --- Branch 2: Auto-recall ---
      // Inject semantically relevant memories before the agent starts.
      if (wantAutoRecall) {
        if (!event.prompt || event.prompt.length < 5) {
          // No usable prompt — skip recall but don't block branch 1 result
        } else if (isSystemPrompt(event.prompt)) {
          // Skip auto-recall for system-generated prompts (session startup, heartbeat).
          // These prompts are not user queries and will never match useful memories,
          // but the full pipeline (embed → 3-signal search → reranker) adds 1.5-3.5s
          // of latency on every /new command before the LLM even starts generating.
          logger.debug?.(
            "memory-neo4j: skipping auto-recall for system prompt (session startup/heartbeat)",
          );
        } else {
          // Skip auto-recall for voice/realtime sessions where latency is critical.
          // These sessions use short conversational turns that don't benefit from
          // memory injection, and the ~100-300ms embedding+search overhead matters.
          const sessionKey = ctx.sessionKey ?? "";
          if (cfg.autoRecallSkipPattern && cfg.autoRecallSkipPattern.test(sessionKey)) {
            logger.debug?.(
              `memory-neo4j: skipping auto-recall for session ${sessionKey} (matches skipPattern)`,
            );
          } else {
            const agentId = ctx.agentId || "default";

            // L10: ~500 chars for CJK safety (1 CJK char ≈ 1 token; 500 chars stays
            // safely within 512-token embedding contexts like mxbai-embed-large).
            // For ASCII-heavy text this is conservative but embedding quality plateaus
            // well before this limit regardless.
            const MAX_QUERY_CHARS = 500;
            const query =
              event.prompt.length > MAX_QUERY_CHARS
                ? event.prompt.slice(0, MAX_QUERY_CHARS)
                : event.prompt;

            try {
              const t0 = performance.now();
              // C6: Config selfEntityName takes priority; fall back to USER.md resolution
              const selfEntityName =
                cfg.selfEntityName ??
                (ctx.workspaceDir ? await resolveSelfEntityName(ctx.workspaceDir) : undefined);

              let results = await hybridSearch(
                db,
                embeddings,
                query,
                3,
                agentId,
                extractionConfig.enabled,
                buildSearchOptions({ cfg, extractionConfig, db, logger, selfEntityName }),
              );
              const tSearch = performance.now();

              // Feature 1: Filter out low-relevance results below min RRF score
              results = results.filter((r) => r.score >= cfg.autoRecallMinScore);

              // Feature 2: (Removed) Core memory dedup was filtering relevant core memories
              // from auto-recall results because they were "already in context" from bootstrap.
              // Problem: by mid-session, bootstrap core memories are buried deep in context
              // ("lost in the middle"), so the model forgets them. Filtering them from auto-recall
              // prevented re-surfacing at the point of relevance. Duplicate injection is harmless —
              // same content appears in both core bootstrap and relevant-memories sections,
              // reinforcing important context with recency.

              const totalMs = performance.now() - t0;
              metrics.histogram("auto_recall.latency_ms", totalMs);
              logger.info?.(
                `memory-neo4j: [bench] auto-recall ${totalMs.toFixed(0)}ms total (search=${(tSearch - t0).toFixed(0)}ms), ${results.length} results`,
              );
              metrics.increment("memories.recalled", results.length);

              if (results.length > 0) {
                const memoryContext = results.map((r) => `- [${r.category}] ${r.text}`).join("\n");

                logger.debug?.(
                  `memory-neo4j: auto-recall memories: ${JSON.stringify(results.map((r) => ({ id: r.id, text: r.text.slice(0, 80), score: r.score, vec: r.signals?.vector.rank || "-", bm25: r.signals?.bm25.rank || "-", graph: r.signals?.graph.rank || "-" })))}`,
                );

                parts.push(
                  `<relevant-memories>\nThe following memories may be relevant to this conversation:\n${memoryContext}\n</relevant-memories>`,
                );
              }
            } catch (err) {
              const isConnection = isNeo4jConnectionError(err);
              logger.warn(
                `memory-neo4j: auto-recall failed (${isConnection ? "Neo4j connection error" : "non-connection error"}): ${String(err)}`,
              );
            }
          }
        }
      }

      if (parts.length === 0) {
        return {};
      }

      return { prependContext: parts.join("\n\n") };
    });
  }

  // Core memories: inject as virtual MEMORY.md at bootstrap time (scoped by agentId).
  // Only runs on new sessions and after compaction (not every turn).
  logger.debug?.(`memory-neo4j: coreMemory.enabled=${cfg.coreMemory.enabled}`);
  if (cfg.coreMemory.enabled) {
    logger.debug?.("memory-neo4j: registering agent_bootstrap hook for core memories");
    api.on("agent_bootstrap", async (event, ctx) => {
      const sessionKey = ctx.sessionKey;

      // Skip if this session was already bootstrapped (avoid re-loading every turn).
      // The after_compaction hook clears the flag so we re-inject after compaction.
      if (sessionKey && bootstrappedSessions.has(sessionKey)) {
        logger.debug?.(
          `memory-neo4j: skipping core memory injection for already-bootstrapped session=${sessionKey}`,
        );
        return;
      }

      // Log when we're about to inject core memories for a session that wasn't tracked
      // This helps diagnose cases where context might be lost after gateway restarts
      if (sessionKey) {
        logger.debug?.(
          `memory-neo4j: session=${sessionKey} not in bootstrappedSessions (size=${bootstrappedSessions.size}), will check for core memories`,
        );
      }

      // OP-134: Optimistically claim the session BEFORE the first await to close
      // the TOCTOU window where two concurrent requests could both pass the has()
      // check and trigger duplicate core-memory injection.
      if (sessionKey) {
        bootstrappedSessions.add(sessionKey);
        touchSession(sessionKey);
      }

      try {
        const t0 = performance.now();
        const agentId = ctx.agentId || "default";
        logger.debug?.(
          `memory-neo4j: loading core memories for agent=${agentId} session=${sessionKey ?? "unknown"}`,
        );
        const coreMemories = await db.listCoreForInjection(agentId);
        const tQuery = performance.now();

        if (coreMemories.length === 0) {
          logger.info?.(
            `memory-neo4j: [bench] core-inject ${(tQuery - t0).toFixed(0)}ms (0 memories, skipped)`,
          );
          return;
        }

        // Format core memories into a MEMORY.md-style document
        let content = "# Core Memory\n\n";
        content += "*Persistent context loaded from long-term memory*\n\n";
        for (const mem of coreMemories) {
          content += `- ${mem.text}\n`;
        }

        // Find and replace MEMORY.md in the files list, or add it
        const files = [...event.files];
        const memoryIndex = files.findIndex(
          (f) => f.name === "MEMORY.md" || f.name === "memory.md",
        );

        const virtualFile = {
          name: "MEMORY.md" as const,
          path: "memory://neo4j/core-memory",
          content,
          missing: false,
        };

        const action = memoryIndex >= 0 ? "replaced" : "added";
        if (memoryIndex >= 0) {
          files[memoryIndex] = virtualFile;
        } else {
          files.push(virtualFile);
        }

        const totalMs = performance.now() - t0;
        logger.info?.(
          `memory-neo4j: [bench] core-inject ${totalMs.toFixed(0)}ms (query=${(tQuery - t0).toFixed(0)}ms), ${action} MEMORY.md with ${coreMemories.length} memories`,
        );

        return { files };
      } catch (err) {
        // OP-134: Clear the optimistic flag on failure so the next turn retries
        if (sessionKey) {
          bootstrappedSessions.delete(sessionKey);
        }
        logger.warn(`memory-neo4j: core memory injection failed: ${String(err)}`);
      }
    });
  }

  // Auto-capture: attention-gated memory pipeline modeled on human memory.
  //
  // Phase 1 — Attention gating (real-time):
  //   Lightweight heuristic filter rejects obvious noise (greetings, short
  //   acks, system markup, code dumps) without any LLM call.
  //
  // Phase 2 — Short-term retention:
  //   Everything that passes the gate is embedded, deduped, and stored as
  //   regular memory with extractionStatus "pending".
  //
  // Phase 3 — Sleep consolidation (deferred to `openclaw memory neo4j sleep`):
  //   The sleep cycle handles entity extraction, categorization, and
  //   decay — mirroring hippocampal replay.
  logger.debug?.(
    `memory-neo4j: autoCapture=${cfg.autoCapture}, extraction.enabled=${extractionConfig.enabled}`,
  );
  if (cfg.autoCapture) {
    logger.debug?.("memory-neo4j: registering agent_end hook for auto-capture");

    // Circuit breaker with half-open recovery: after CIRCUIT_BREAKER_THRESHOLD
    // consecutive failures, suspend auto-capture. After CIRCUIT_RECOVERY_MS,
    // allow one probe attempt (half-open). If it succeeds, close the circuit;
    // if it fails, re-open and restart the timer. Without half-open state,
    // the circuit latches permanently open once tripped.
    const CIRCUIT_BREAKER_THRESHOLD = 5;
    const CIRCUIT_RECOVERY_MS = 60_000; // 1 minute before half-open probe
    let consecutiveFailures = 0;
    let circuitOpen = false;
    let circuitOpenedAt = 0;

    api.on("agent_end", (event, ctx) => {
      logger.debug?.(
        `memory-neo4j: agent_end fired (success=${event.success}, messages=${event.messages?.length ?? 0})`,
      );
      if (!event.success || !event.messages || event.messages.length === 0) {
        logger.debug?.("memory-neo4j: skipping - no success or empty messages");
        metrics.increment("auto_capture.skipped");
        return;
      }

      // Skip auto-capture for sessions matching the skip pattern (e.g. voice sessions)
      const sessionKey = ctx.sessionKey;
      if (cfg.autoCaptureSkipPattern && sessionKey && cfg.autoCaptureSkipPattern.test(sessionKey)) {
        logger.debug?.(
          `memory-neo4j: skipping auto-capture for session ${sessionKey} (matches skipPattern)`,
        );
        metrics.increment("auto_capture.skipped");
        return;
      }

      // Circuit breaker: skip when open, but allow a single probe after recovery period (half-open)
      if (circuitOpen) {
        const elapsed = Date.now() - circuitOpenedAt;
        if (elapsed < CIRCUIT_RECOVERY_MS) {
          logger.debug?.("memory-neo4j: auto-capture circuit open, skipping");
          return;
        }
        // Half-open: allow this one attempt as a recovery probe
        logger.info?.("memory-neo4j: auto-capture circuit half-open, attempting recovery probe");
      }

      metrics.increment("auto_capture.fired");
      const agentId = ctx.agentId || "default";
      const t0Capture = performance.now();

      // Episodic memory: capture raw messages as Episode nodes (opt-in).
      // Tracked in outstandingCaptures so stop() can drain before closing DB.
      if (cfg.episodicMemory?.enabled) {
        const episodeMessages = [
          ...extractUserMessages(event.messages).map((text) => ({ text, role: "user" as const })),
          ...(cfg.episodicMemory.captureAssistant
            ? extractAssistantMessages(event.messages).map((text) => ({
                text,
                role: "assistant" as const,
              }))
            : []),
        ];
        // H3: Use a single session for all episode messages instead of one per message
        const episodicPromise: Promise<void> = (async () => {
          const session = await db.createSession();
          try {
            for (const msg of episodeMessages) {
              try {
                await mergeEpisode(session, {
                  id: crypto.randomUUID(),
                  text: msg.text,
                  role: msg.role,
                  timestamp: new Date().toISOString(),
                  sessionKey: sessionKey ?? "unknown",
                  agentId,
                });
              } catch (err) {
                logger.debug?.(`memory-neo4j: episode capture failed: ${String(err)}`);
              }
            }
          } finally {
            await session.close();
          }
        })().finally(() => {
          outstandingCaptures.delete(episodicPromise);
        });
        outstandingCaptures.add(episodicPromise);
      }

      // Fire-and-forget: run auto-capture asynchronously so it doesn't
      // block the agent_end hook (which otherwise adds 2-10s per turn).
      // OP-135: Track the promise so stop() can drain in-flight captures.
      // Pre-filter (shouldCapture) now runs inside runAutoCapture after
      // wrapper stripping, so raw messages are passed directly.
      const capturePromise: Promise<void> = runAutoCapture(
        event.messages,
        agentId,
        sessionKey,
        db,
        embeddings,
        extractionConfig,
        logger,
        abortRef.controller.signal,
        cfg.decomposition.enabled,
      )
        .then(() => {
          // Success: reset circuit breaker so transient errors don't permanently suspend capture.
          consecutiveFailures = 0;
          circuitOpen = false;
          metrics.histogram("auto_capture.latency_ms", performance.now() - t0Capture);
        })
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          consecutiveFailures++;
          if (consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
            circuitOpen = true;
            circuitOpenedAt = Date.now();
            logger.error?.(
              `memory-neo4j: auto-capture CIRCUIT OPEN — ${consecutiveFailures} consecutive failures. Memory capture suspended (recovery probe in ${CIRCUIT_RECOVERY_MS / 1000}s). Last error: ${msg}`,
            );
          } else {
            logger.warn?.(
              `memory-neo4j: auto-capture failed (${consecutiveFailures}/${CIRCUIT_BREAKER_THRESHOLD}): ${msg}`,
            );
          }
        })
        .finally(() => {
          outstandingCaptures.delete(capturePromise);
        });
      outstandingCaptures.add(capturePromise);
    });
  }

  return { outstandingCaptures, sessionCleanupInterval };
}
