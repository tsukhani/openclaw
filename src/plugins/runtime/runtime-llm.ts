/**
 * Plugin LLM runtime — routes plugin LLM calls through OpenClaw's model stack.
 *
 * Uses `completeSimple` from @mariozechner/pi-ai so calls go through the same
 * provider layer as agent runs (auth profiles, custom providers, etc.).
 */

import type { Context, TextContent } from "@mariozechner/pi-ai";
import { completeSimple } from "@mariozechner/pi-ai";
import { DEFAULT_PROVIDER } from "../../agents/defaults.js";
import { getApiKeyForModel } from "../../agents/model-auth.js";
import { parseModelRef } from "../../agents/model-selection.js";
import { resolveModel } from "../../agents/pi-embedded-runner/model.js";
import type { OpenClawConfig } from "../../config/config.js";
import { loadConfig } from "../../config/config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { PluginRuntimeLlm } from "./types-core.js";

const log = createSubsystemLogger("plugin-llm");

type LlmMessage = { role: "user" | "assistant" | "system"; content: string };

/** Convert simple role/content messages into the pi-ai Context format. */
function buildContext(messages: LlmMessage[]): Context {
  const systemMessages = messages.filter((m) => m.role === "system");
  const chatMessages = messages.filter((m) => m.role !== "system");

  const systemPrompt =
    systemMessages.length > 0 ? systemMessages.map((m) => m.content).join("\n\n") : undefined;

  const piMessages: Context["messages"] = chatMessages.map((m) => {
    if (m.role === "assistant") {
      return {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: m.content }],
        api: "anthropic-messages" as const,
        provider: "anthropic",
        model: "",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop" as const,
        timestamp: Date.now(),
      };
    }
    return {
      role: "user" as const,
      content: m.content,
      timestamp: Date.now(),
    };
  });

  return { systemPrompt, messages: piMessages };
}

export function createPluginLlmRuntime(cfg?: OpenClawConfig): PluginRuntimeLlm {
  return {
    callModel: async (modelStr, messages, options) => {
      try {
        // Lazily load config if not provided — supports non-gateway CLI paths
        const resolvedCfg = cfg ?? loadConfig();

        const parsed = parseModelRef(modelStr, DEFAULT_PROVIDER);
        if (!parsed) {
          log.warn(`[plugin-llm] could not parse model ref: "${modelStr}"`);
          return null;
        }
        const { provider, model: modelId } = parsed;

        const resolved = resolveModel(provider, modelId, undefined, resolvedCfg);
        if (!resolved.model) {
          log.warn(
            `[plugin-llm] model not found: ${provider}/${modelId} — ${resolved.error ?? "unknown"}`,
          );
          return null;
        }

        const auth = await getApiKeyForModel({
          model: resolved.model,
          cfg: resolvedCfg,
        });

        const context = buildContext(messages);
        const result = await completeSimple(resolved.model, context, {
          apiKey: auth.apiKey ?? undefined,
          ...(options?.maxTokens != null && { maxTokens: options.maxTokens }),
          ...(options?.abortSignal != null && { signal: options.abortSignal }),
        });

        // Extract text blocks from the response
        const text = result.content
          .filter((block): block is TextContent => block.type === "text")
          .map((block) => block.text)
          .join("");

        return text || null;
      } catch (err) {
        log.warn(`[plugin-llm] callModel failed: ${String(err)}`);
        return null;
      }
    },
  };
}
