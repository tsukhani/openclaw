/**
 * Session memory hook handler
 *
 * Saves session context when /new or /reset command is triggered.
 * Default target: writes SESSION_CONTEXT.md in the workspace root (overwrite).
 * Memory target: stores via the active memory plugin through the Gateway API.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  resolveAgentIdByWorkspacePath,
  resolveAgentWorkspaceDir,
} from "../../../agents/agent-scope.js";
import { resolveStateDir } from "../../../config/paths.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { localDateStr, localTimeStr, tzOffsetLabel } from "../../../logging/timestamp.js";
import {
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
  toAgentStoreSessionKey,
} from "../../../routing/session-key.js";
import { resolveHookConfig } from "../../config.js";
import type { HookHandler } from "../../hooks.js";
import { generateSlugViaLLM } from "../../llm-slug-generator.js";
import { findPreviousSessionFile, getRecentSessionContentWithResetFallback } from "./transcript.js";

const log = createSubsystemLogger("hooks/session-memory");

function resolveDisplaySessionKey(params: {
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  sessionKey: string;
}): string {
  if (!params.cfg || !params.workspaceDir) {
    return params.sessionKey;
  }
  const workspaceAgentId = resolveAgentIdByWorkspacePath(params.cfg, params.workspaceDir);
  const parsed = parseAgentSessionKey(params.sessionKey);
  if (!workspaceAgentId || !parsed || workspaceAgentId === parsed.agentId) {
    return params.sessionKey;
  }
  return toAgentStoreSessionKey({
    agentId: workspaceAgentId,
    requestKey: parsed.rest,
  });
}

/**
 * Save session context to the memory plugin via the Gateway tools API.
 * The actual storage backend depends on which memory plugin is active
 * (e.g. memory-neo4j, memory-lancedb).
 */
async function saveToMemory(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  slug: string;
  sessionContent: string;
  timestamp: Date;
}): Promise<void> {
  const { cfg, sessionKey, slug, sessionContent, timestamp } = params;

  // Get gateway config
  const gatewayPort = cfg.gateway?.port || 18789;
  const gatewayToken = cfg.gateway?.auth?.token;

  if (!gatewayToken || typeof gatewayToken !== "string") {
    throw new Error("Gateway auth token not found in config");
  }

  // Format memory text with metadata and truncated content
  const dateStr = localDateStr(timestamp);
  const timeStr = localTimeStr(timestamp);
  const tz = tzOffsetLabel(timestamp);
  const truncatedContent = sessionContent.slice(0, 2000);
  const wasTruncated = sessionContent.length > 2000;

  const memoryText = [
    `Session: ${slug}`,
    `Date: ${dateStr} ${timeStr} ${tz}`,
    `Session Key: ${sessionKey}`,
    "",
    truncatedContent,
    wasTruncated ? "\n[...truncated to 2000 chars]" : "",
  ].join("\n");

  // Call Gateway API to invoke memory_store
  const apiUrl = `http://localhost:${gatewayPort}/tools/invoke`;
  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${gatewayToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      tool: "memory_store",
      args: {
        text: memoryText,
        importance: 0.7,
        category: "fact",
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gateway API call failed: ${response.status} ${errorText}`);
  }

  log.debug("Successfully stored session context via Gateway memory tool");
}

/**
 * Save session context to memory when /new or /reset command is triggered
 */
const saveSessionToMemory: HookHandler = async (event) => {
  // Only trigger on reset/new commands
  const isResetCommand = event.action === "new" || event.action === "reset";
  if (event.type !== "command" || !isResetCommand) {
    return;
  }

  try {
    log.debug("Hook triggered for reset/new command", { action: event.action });

    const context = event.context || {};
    const cfg = context.cfg as OpenClawConfig | undefined;
    const contextWorkspaceDir =
      typeof context.workspaceDir === "string" && context.workspaceDir.trim().length > 0
        ? context.workspaceDir
        : undefined;
    const agentId = resolveAgentIdFromSessionKey(event.sessionKey);
    const workspaceDir =
      contextWorkspaceDir ||
      (cfg
        ? resolveAgentWorkspaceDir(cfg, agentId)
        : path.join(resolveStateDir(process.env, os.homedir), "workspace"));
    const displaySessionKey = resolveDisplaySessionKey({
      cfg,
      workspaceDir: contextWorkspaceDir,
      sessionKey: event.sessionKey,
    });

    // Use the user's local timezone for memory artifact names and headings.
    const now = new Date(event.timestamp);
    const dateStr = localDateStr(now);

    // Generate descriptive slug from session using LLM
    // Prefer previousSessionEntry (old session before /new) over current (which may be empty)
    const sessionEntry = (context.previousSessionEntry || context.sessionEntry || {}) as Record<
      string,
      unknown
    >;
    const currentSessionId = sessionEntry.sessionId as string;
    let currentSessionFile = (sessionEntry.sessionFile as string) || undefined;

    // If sessionFile is empty or looks like a new/reset file, try to find the previous session file.
    if (!currentSessionFile || currentSessionFile.includes(".reset.")) {
      const sessionsDirs = new Set<string>();
      if (currentSessionFile) {
        sessionsDirs.add(path.dirname(currentSessionFile));
      }
      sessionsDirs.add(path.join(workspaceDir, "sessions"));

      for (const sessionsDir of sessionsDirs) {
        const recoveredSessionFile = await findPreviousSessionFile({
          sessionsDir,
          currentSessionFile,
          sessionId: currentSessionId,
        });
        if (!recoveredSessionFile) {
          continue;
        }
        currentSessionFile = recoveredSessionFile;
        log.debug("Found previous session file", { file: currentSessionFile });
        break;
      }
    }

    log.debug("Session context resolved", {
      sessionId: currentSessionId,
      sessionFile: currentSessionFile,
      hasCfg: Boolean(cfg),
    });

    const sessionFile = currentSessionFile || undefined;

    // Read hook config (default: 15 messages, file target)
    const hookConfig = resolveHookConfig(cfg, "session-memory");
    const messageCount =
      typeof hookConfig?.messages === "number" && hookConfig.messages > 0
        ? hookConfig.messages
        : 15;
    // Accept "memory" (preferred) or "lancedb" (legacy alias) as the memory-plugin target.
    const rawTarget = hookConfig?.target;
    const target = rawTarget === "memory" || rawTarget === "lancedb" ? "memory" : "file";

    log.debug("Storage target resolved", { target });

    let slug: string | null = null;
    let sessionContent: string | null = null;

    if (sessionFile) {
      // Get recent conversation content, with fallback to rotated reset transcript.
      sessionContent = await getRecentSessionContentWithResetFallback(sessionFile, messageCount);
      log.debug("Session content loaded", {
        length: sessionContent?.length ?? 0,
        messageCount,
      });

      // Avoid calling the model provider in unit tests; keep hooks fast and deterministic.
      const isTestEnv =
        process.env.OPENCLAW_TEST_FAST === "1" ||
        process.env.VITEST === "true" ||
        process.env.VITEST === "1" ||
        process.env.NODE_ENV === "test";
      const allowLlmSlug = !isTestEnv && hookConfig?.llmSlug !== false;

      if (sessionContent && cfg && allowLlmSlug) {
        log.debug("Calling generateSlugViaLLM...");
        // Use LLM to generate a descriptive slug
        slug = await generateSlugViaLLM({ sessionContent, cfg });
        log.debug("Generated slug", { slug });
      }
    }

    // If no slug, use timestamp
    if (!slug) {
      const timeSlug = localTimeStr(now).replace(/:/g, "");
      slug = timeSlug.slice(0, 4); // HHMM
      log.debug("Using fallback timestamp slug", { slug });
    }

    // Route to appropriate storage target
    if (target === "memory") {
      // Store via the active memory plugin (e.g. memory-neo4j) through the Gateway API.
      if (!cfg) {
        throw new Error("Config not available for memory storage");
      }
      if (!sessionContent) {
        log.debug("No session content available, skipping memory storage");
        return;
      }

      await saveToMemory({
        cfg,
        sessionKey: event.sessionKey,
        slug,
        sessionContent,
        timestamp: now,
      });
      log.info(`Session context stored in memory: ${slug}`);
    } else {
      // Write session context to SESSION_CONTEXT.md (overwrite, not append).
      // This file is read by the session-context hook at bootstrap to provide
      // continuity across sessions. It is separate from MEMORY.md (core memories).
      const sessionContextPath = path.join(workspaceDir, "SESSION_CONTEXT.md");

      const timeStr = localTimeStr(now);
      const tz = tzOffsetLabel(now);
      const sessionId = (sessionEntry.sessionId as string) || "unknown";
      const source = (context.commandSource as string) || "unknown";

      // Build Markdown entry
      const entryParts = [
        `# Session Context — ${dateStr} ${timeStr} ${tz}`,
        "",
        `- **Session Key**: ${displaySessionKey}`,
        `- **Session ID**: ${sessionId}`,
        `- **Source**: ${source}`,
        "",
      ];

      // Include conversation content if available
      if (sessionContent) {
        entryParts.push("## Recent Conversation", "", sessionContent, "");
      }

      const entry = entryParts.join("\n");

      // Overwrite SESSION_CONTEXT.md
      await fs.writeFile(sessionContextPath, entry, "utf-8");
      log.debug("SESSION_CONTEXT.md written successfully");

      const relPath = sessionContextPath.replace(os.homedir(), "~");
      log.info(`Session context saved to ${relPath}`);
    }
  } catch (err) {
    if (err instanceof Error) {
      log.error("Failed to save session memory", {
        errorName: err.name,
        errorMessage: err.message,
        stack: err.stack,
      });
    } else {
      log.error("Failed to save session memory", { error: String(err) });
    }
  }
};

export default saveSessionToMemory;
