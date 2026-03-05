/**
 * LLM API client for memory-neo4j extraction.
 *
 * Supports two API formats:
 * - **Anthropic Messages API** (native): Used when baseUrl points to api.anthropic.com.
 * - **OpenAI-compatible** (OpenRouter, Ollama, etc.): Used for all other baseUrls.
 *
 * Provider detection is based on the resolved baseUrl from config, NOT the model name.
 * This ensures that Anthropic models routed through OpenRouter use the correct
 * OpenAI-compatible API format instead of Anthropic's native Messages API.
 */

import type { ExtractionConfig } from "./config.js";

// Timeout for LLM and embedding fetch calls to prevent hanging indefinitely
export const FETCH_TIMEOUT_MS = 30_000;

const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const ANTHROPIC_API_VERSION = "2023-06-01";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Sleep that rejects early if the abort signal fires. */
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("aborted"));
      },
      { once: true },
    );
  });
}

/**
 * Detect whether the config should use the Anthropic Messages API.
 * Decision is based solely on the resolved baseUrl — if it points to
 * api.anthropic.com, use native Anthropic format. Everything else
 * (OpenRouter, Ollama, custom endpoints) uses OpenAI-compatible format.
 *
 * Uses hostname matching (not substring) to avoid matching proxy URLs
 * that contain "anthropic.com" in the path.
 */
function isAnthropicNative(config: ExtractionConfig): boolean {
  try {
    const hostname = new URL(config.baseUrl).hostname;
    return (
      hostname === "anthropic.com" ||
      hostname === "api.anthropic.com" ||
      hostname.endsWith(".anthropic.com")
    );
  } catch {
    return false;
  }
}

/**
 * Detect whether the provider at baseUrl supports response_format: json_object.
 * Local providers (Ollama, LM Studio) often return HTTP 400 on this parameter.
 * Cloud providers are assumed to support it.
 */
function supportsJsonMode(baseUrl: string): boolean {
  try {
    const { hostname } = new URL(baseUrl);
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") return false;
    return true;
  } catch {
    return true;
  }
}

/**
 * Strip the "anthropic/" prefix from model names for the native API.
 * e.g. "anthropic/claude-sonnet-4-6" → "claude-sonnet-4-6"
 */
function stripAnthropicPrefix(model: string): string {
  return model.startsWith("anthropic/") ? model.slice("anthropic/".length) : model;
}

/**
 * Build a combined abort signal from the caller's signal and a per-request timeout.
 */
function buildSignal(abortSignal?: AbortSignal): AbortSignal {
  return abortSignal
    ? AbortSignal.any([abortSignal, AbortSignal.timeout(FETCH_TIMEOUT_MS)])
    : AbortSignal.timeout(FETCH_TIMEOUT_MS);
}

/**
 * Shared SSE stream reader. Buffers chunks, splits on newlines, strips the
 * `data: ` prefix, skips `[DONE]` sentinel lines, and invokes `onData` for
 * each remaining data payload.  Checks `abortSignal` before every read so
 * callers can cancel mid-stream.
 *
 * @returns `false` if the read was aborted, `true` when the stream is exhausted.
 */
async function readSSEStream(
  body: ReadableStream<Uint8Array>,
  abortSignal: AbortSignal | undefined,
  onData: (data: string) => void,
): Promise<boolean> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    if (abortSignal?.aborted) {
      reader.cancel().catch(() => {});
      return false;
    }

    const { done, value } = await reader.read();
    if (abortSignal?.aborted) {
      reader.cancel().catch(() => {});
      return false;
    }
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data: ")) continue;
      const data = trimmed.slice(6);
      if (data === "[DONE]") continue;
      onData(data);
    }
  }

  return true;
}

// ── Anthropic Messages API ──────────────────────────────────────────────────

/**
 * Call Anthropic's native Messages API (non-streaming).
 */
async function anthropicRequest(
  config: ExtractionConfig,
  messages: Array<{ role: string; content: string }>,
  abortSignal: AbortSignal | undefined,
): Promise<string | null> {
  // Separate system message from user/assistant messages
  const systemMessages = messages.filter((m) => m.role === "system");
  const chatMessages = messages.filter((m) => m.role !== "system");
  const systemText = systemMessages.map((m) => m.content).join("\n\n") || undefined;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      const signal = buildSignal(abortSignal);
      const model = stripAnthropicPrefix(config.model);

      // Use config.baseUrl so Anthropic-compatible proxies are honoured.
      // ANTHROPIC_BASE_URL is only the default value set in config.
      const response = await fetch(`${config.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "x-api-key": config.apiKey,
          "anthropic-version": ANTHROPIC_API_VERSION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: 4096,
          temperature: config.temperature,
          ...(systemText ? { system: systemText } : {}),
          messages: chatMessages.map((m) => ({
            role: m.role as "user" | "assistant",
            content: m.content,
          })),
        }),
        signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`Anthropic API error ${response.status}: ${body}`);
      }

      const data = (await response.json()) as {
        content?: Array<{ type: string; text?: string }>;
      };
      const textBlock = data.content?.find((b) => b.type === "text");
      return textBlock?.text ?? null;
    } catch (err) {
      if (attempt >= config.maxRetries) {
        throw err;
      }
      await abortableDelay(500 * 2 ** attempt * (0.75 + Math.random() * 0.5), abortSignal);
    }
  }
}

/**
 * Call Anthropic's native Messages API with streaming.
 */
async function anthropicStreamRequest(
  config: ExtractionConfig,
  messages: Array<{ role: string; content: string }>,
  abortSignal: AbortSignal | undefined,
): Promise<string | null> {
  const systemMessages = messages.filter((m) => m.role === "system");
  const chatMessages = messages.filter((m) => m.role !== "system");
  const systemText = systemMessages.map((m) => m.content).join("\n\n") || undefined;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      const signal = buildSignal(abortSignal);
      const model = stripAnthropicPrefix(config.model);

      // Use config.baseUrl so Anthropic-compatible proxies are honoured.
      const response = await fetch(`${config.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "x-api-key": config.apiKey,
          "anthropic-version": ANTHROPIC_API_VERSION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: 4096,
          temperature: config.temperature,
          stream: true,
          ...(systemText ? { system: systemText } : {}),
          messages: chatMessages.map((m) => ({
            role: m.role as "user" | "assistant",
            content: m.content,
          })),
        }),
        signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`Anthropic API error ${response.status}: ${body}`);
      }

      if (!response.body) {
        throw new Error("No response body for streaming request");
      }

      let accumulated = "";
      // Anthropic streaming: content_block_delta events carry the text delta
      const ok = await readSSEStream(response.body, abortSignal, (data) => {
        try {
          const parsed = JSON.parse(data) as {
            type?: string;
            delta?: { type?: string; text?: string };
          };
          if (parsed.type === "content_block_delta" && parsed.delta?.text) {
            accumulated += parsed.delta.text;
          }
        } catch {
          // Skip malformed SSE chunks
        }
      });
      if (!ok) return null;

      return accumulated || null;
    } catch (err) {
      if (attempt >= config.maxRetries) {
        throw err;
      }
      await abortableDelay(500 * 2 ** attempt * (0.75 + Math.random() * 0.5), abortSignal);
    }
  }
}

// ── OpenAI-compatible API ───────────────────────────────────────────────────

/**
 * Shared request/retry logic for OpenAI-compatible API calls.
 */
async function openAIRequest(
  config: ExtractionConfig,
  messages: Array<{ role: string; content: string }>,
  abortSignal: AbortSignal | undefined,
  stream: boolean,
  parseFn: (response: Response, abortSignal?: AbortSignal) => Promise<string | null>,
): Promise<string | null> {
  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      const signal = buildSignal(abortSignal);

      const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: config.model,
          messages,
          temperature: config.temperature,
          // Only send response_format for providers known to support it;
          // local providers (Ollama, LM Studio) return HTTP 400 on this param.
          ...(supportsJsonMode(config.baseUrl) ? { response_format: { type: "json_object" } } : {}),
          ...(stream ? { stream: true } : {}),
        }),
        signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`OpenAI-compatible API error ${response.status}: ${body}`);
      }

      return await parseFn(response, abortSignal);
    } catch (err) {
      if (attempt >= config.maxRetries) {
        throw err;
      }
      await abortableDelay(500 * 2 ** attempt * (0.75 + Math.random() * 0.5), abortSignal);
    }
  }
}

export async function parseNonStreaming(response: Response): Promise<string | null> {
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    // Non-JSON body (e.g., HTML 502 from proxy)
    return null;
  }
  const typed = data as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return typed.choices?.[0]?.message?.content ?? null;
}

async function parseStreaming(
  response: Response,
  abortSignal?: AbortSignal,
): Promise<string | null> {
  if (!response.body) {
    throw new Error("No response body for streaming request");
  }

  let accumulated = "";
  // OpenAI-compatible streaming: delta text lives in choices[0].delta.content
  const ok = await readSSEStream(response.body, abortSignal, (data) => {
    try {
      const parsed = JSON.parse(data) as {
        choices?: Array<{ delta?: { content?: string } }>;
      };
      const chunk = parsed.choices?.[0]?.delta?.content;
      if (chunk) {
        accumulated += chunk;
      }
    } catch {
      // Skip malformed SSE chunks
    }
  });
  if (!ok) return null;

  return accumulated || null;
}

// ── Public API (auto-detects provider) ──────────────────────────────────────

export async function callOpenRouter(
  config: ExtractionConfig,
  prompt: string | Array<{ role: string; content: string }>,
  abortSignal?: AbortSignal,
): Promise<string | null> {
  const messages = typeof prompt === "string" ? [{ role: "user", content: prompt }] : prompt;

  if (isAnthropicNative(config)) {
    return anthropicRequest(config, messages, abortSignal);
  }
  return openAIRequest(config, messages, abortSignal, false, parseNonStreaming);
}

/**
 * Streaming variant. Uses streaming to receive chunks incrementally,
 * allowing earlier cancellation via abort signal.
 *
 * Accumulates all chunks into a single response string since extraction
 * uses JSON mode (which requires the complete object to parse).
 */
export async function callOpenRouterStream(
  config: ExtractionConfig,
  prompt: string | Array<{ role: string; content: string }>,
  abortSignal?: AbortSignal,
): Promise<string | null> {
  const messages = typeof prompt === "string" ? [{ role: "user", content: prompt }] : prompt;

  if (isAnthropicNative(config)) {
    return anthropicStreamRequest(config, messages, abortSignal);
  }
  return openAIRequest(config, messages, abortSignal, true, parseStreaming);
}

/**
 * Check if an error is transient (network/timeout) vs permanent (JSON parse, etc.)
 */
export function isTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const msg = err.message.toLowerCase();
  return (
    err.name === "AbortError" ||
    err.name === "TimeoutError" ||
    msg.includes("timeout") ||
    msg.includes("econnrefused") ||
    msg.includes("econnreset") ||
    msg.includes("etimedout") ||
    msg.includes("enotfound") ||
    msg.includes("network") ||
    msg.includes("fetch failed") ||
    msg.includes("socket hang up") ||
    msg.includes("api error 429") ||
    msg.includes("api error 500") ||
    msg.includes("status 500") ||
    msg.includes("api error 502") ||
    msg.includes("api error 503") ||
    msg.includes("api error 504")
  );
}
