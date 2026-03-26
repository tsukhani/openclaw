/**
 * LLM API client for memory-neo4j extraction.
 *
 * Supports two call paths:
 * - **Native (gateway mode)**: `api.runtime.llm.callModel()` via OpenClaw's model routing layer.
 *   Provides fallbacks, cost tracking, and access to all configured providers.
 * - **Direct HTTP (CLI/standalone mode)**: direct API calls via the extraction config.
 *
 * For the direct HTTP path, two API formats are supported:
 * - **Anthropic Messages API** (native): Used when baseUrl points to api.anthropic.com.
 * - **OpenAI-compatible** (OpenRouter, Ollama, etc.): Used for all other baseUrls.
 *
 * Provider detection is based on the resolved baseUrl from config, NOT the model name.
 * This ensures that Anthropic models routed through OpenRouter use the correct
 * OpenAI-compatible API format instead of Anthropic's native Messages API.
 */

import type { PluginRuntimeLlm } from "openclaw/plugin-sdk/memory-neo4j";
import type { ExtractionConfig } from "./config.js";
import { abortableDelay as sharedAbortableDelay } from "./retry.js";

// ── Native (gateway) LLM injection ───────────────────────────────────────────

// L21: Module-level singleton — set once during plugin registration, used by all callLlm paths.
// C6: SAFETY: setPluginLlm must only be called during single-threaded initialization
// (plugin start), never while callLlm/callLlmStream are in-flight. Node.js's single-threaded
// event loop ensures the assignment is atomic w.r.t. synchronous access, but async callers
// capture the reference in a local variable (see callLlm/callLlmStream) to avoid mid-call swaps.
let _pluginLlm: PluginRuntimeLlm | null = null;

/**
 * Called once during plugin registration to inject the runtime LLM API.
 * When set, callLlm / callLlmStream prefer this over direct HTTP calls.
 *
 * IMPORTANT: Must only be called during plugin start() — not during hot-reload
 * or while LLM calls are in-flight. The local-capture pattern in callLlm/callLlmStream
 * (const llm = _pluginLlm) provides read-side safety but cannot prevent split-brain
 * if setPluginLlm races with an in-flight native routing decision.
 */
export function setPluginLlm(llm: PluginRuntimeLlm): void {
  _pluginLlm = llm;
}

// ── Dual-path wrappers ────────────────────────────────────────────────────────

type LlmMessage = { role: string; content: string };

/**
 * Check whether the extraction config should use the gateway's native
 * `callModel()` routing.  Skip native routing when the config specifies a
 * custom baseUrl (Ollama Cloud, self-hosted endpoints, etc.) — those models
 * are not registered in the gateway's provider list and would produce noisy
 * "model not found" warnings on every call before falling through to HTTP.
 */
function useNativeRouting(config: ExtractionConfig): boolean {
  if (!_pluginLlm) return false;
  if (!config.baseUrl) return true;
  try {
    const hostname = new URL(config.baseUrl).hostname;
    return (
      hostname === "api.anthropic.com" ||
      hostname.endsWith(".anthropic.com") ||
      hostname === "api.openai.com" ||
      hostname === "openrouter.ai" ||
      hostname.endsWith(".openrouter.ai")
    );
  } catch {
    return true;
  }
}

/**
 * Make an LLM call — prefers OpenClaw native routing when running in-gateway
 * with a gateway-routable model, otherwise uses direct HTTP.
 */
export async function callLlm(
  config: ExtractionConfig,
  prompt: string | LlmMessage[],
  abortSignal?: AbortSignal,
): Promise<string | null> {
  const messages = typeof prompt === "string" ? [{ role: "user", content: prompt }] : prompt;

  // H3: Capture in local variable to avoid non-null assertion after separate guard function
  const llm = _pluginLlm;
  if (llm && useNativeRouting(config)) {
    try {
      const nativeResult = await llm.callModel(
        config.model,
        messages as Array<{ role: "user" | "assistant" | "system"; content: string }>,
        { abortSignal },
      );
      // Non-null result means the call succeeded — return it.
      // Null means the call failed silently (model not found, auth error, etc.) —
      // fall through to HTTP so the direct-API path gets a chance.
      if (nativeResult !== null) return nativeResult;
      if (typeof globalThis.console?.debug === "function") {
        globalThis.console.debug(
          "memory-neo4j: native LLM call returned null, falling back to HTTP",
        );
      }
    } catch (err) {
      // H3: Re-throw AbortError — deliberate cancellation should not fall through to HTTP
      if (err instanceof Error && err.name === "AbortError") throw err;
      // Log and fall through to direct HTTP as fallback
      const msg = err instanceof Error ? err.message : String(err);
      if (typeof globalThis.console?.debug === "function") {
        globalThis.console.debug(
          `memory-neo4j: native LLM call failed, falling back to HTTP: ${msg}`,
        );
      }
    }
  }

  return callOpenRouter(config, prompt, abortSignal);
}

/**
 * Streaming variant — prefers OpenClaw native routing when gateway-routable,
 * otherwise uses direct HTTP.
 */
export async function callLlmStream(
  config: ExtractionConfig,
  prompt: string | LlmMessage[],
  abortSignal?: AbortSignal,
): Promise<string | null> {
  const messages = typeof prompt === "string" ? [{ role: "user", content: prompt }] : prompt;

  // H3: Capture in local variable to avoid non-null assertion after separate guard function
  const llm = _pluginLlm;
  if (llm && useNativeRouting(config)) {
    try {
      const nativeResult = await llm.callModel(
        config.model,
        messages as Array<{ role: "user" | "assistant" | "system"; content: string }>,
        { abortSignal },
      );
      if (nativeResult !== null) return nativeResult;
      if (typeof globalThis.console?.debug === "function") {
        globalThis.console.debug(
          "memory-neo4j: native LLM call returned null, falling back to HTTP",
        );
      }
    } catch (err) {
      // H3: Re-throw AbortError — deliberate cancellation should not fall through to HTTP
      if (err instanceof Error && err.name === "AbortError") throw err;
      // Log and fall through to direct HTTP as fallback
      const msg = err instanceof Error ? err.message : String(err);
      if (typeof globalThis.console?.debug === "function") {
        globalThis.console.debug(
          `memory-neo4j: native LLM call failed, falling back to HTTP: ${msg}`,
        );
      }
    }
  }

  return callOpenRouterStream(config, prompt, abortSignal);
}

// Default timeout for embedding fetch calls (extraction uses config.timeout)
export const FETCH_TIMEOUT_MS = 30_000;

const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const ANTHROPIC_API_VERSION = "2023-06-01";

// C3: Max accumulated SSE response size to prevent OOM from buggy/malicious servers
const MAX_SSE_ACCUMULATED_BYTES = 256 * 1024; // 256 KB — generous for JSON extraction responses

// ── JSON response extraction (type-safe, no `as` casts) ─────────────────────

/** Safely extract text from an Anthropic Messages API response. */
function extractAnthropicText(data: unknown): string | null {
  if (typeof data !== "object" || data === null || !("content" in data)) return null;
  if (!Array.isArray(data.content)) return null;
  for (const block of data.content) {
    if (typeof block !== "object" || block === null) continue;
    if (
      "type" in block &&
      block.type === "text" &&
      "text" in block &&
      typeof block.text === "string"
    ) {
      return block.text;
    }
  }
  return null;
}

/** Safely extract delta text from an Anthropic SSE content_block_delta event. */
function extractAnthropicDelta(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  if (!("type" in data) || data.type !== "content_block_delta") return null;
  if (!("delta" in data) || typeof data.delta !== "object" || data.delta === null) return null;
  if (!("text" in data.delta) || typeof data.delta.text !== "string") return null;
  return data.delta.text;
}

/** Safely extract content from an OpenAI-compatible chat completion response. */
function extractOpenAIContent(data: unknown): string | null {
  if (typeof data !== "object" || data === null || !("choices" in data)) return null;
  if (!Array.isArray(data.choices) || data.choices.length === 0) return null;
  const first: unknown = data.choices[0];
  if (typeof first !== "object" || first === null || !("message" in first)) return null;
  const msg: unknown = first.message;
  if (typeof msg !== "object" || msg === null || !("content" in msg)) return null;
  return typeof msg.content === "string" ? msg.content : null;
}

/** Safely extract delta content from an OpenAI-compatible streaming chunk. */
function extractOpenAIDelta(data: unknown): string | null {
  if (typeof data !== "object" || data === null || !("choices" in data)) return null;
  if (!Array.isArray(data.choices) || data.choices.length === 0) return null;
  const first: unknown = data.choices[0];
  if (typeof first !== "object" || first === null || !("delta" in first)) return null;
  const delta: unknown = first.delta;
  if (typeof delta !== "object" || delta === null || !("content" in delta)) return null;
  return typeof delta.content === "string" ? delta.content : null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Sleep that rejects early if the abort signal fires. Re-exported from retry.ts. */
export const abortableDelay = sharedAbortableDelay;

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
    // M13: Only match API subdomains, not bare "anthropic.com" (the website)
    return hostname === "api.anthropic.com" || hostname.endsWith(".anthropic.com");
  } catch {
    return false;
  }
}

// ── HTTPS enforcement ─────────────────────────────────────────────────────────

const _httpsWarned = new Set<string>();

/**
 * Log a one-time warning when an API key will be sent over plain HTTP
 * to a non-loopback host.
 */
function warnIfInsecureTransport(baseUrl: string): void {
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:") return;
    const host = url.hostname;
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") return;
    if (_httpsWarned.has(baseUrl)) return;
    _httpsWarned.add(baseUrl);
    if (typeof globalThis.console?.warn === "function") {
      globalThis.console.warn(
        `memory-neo4j: LLM baseUrl "${baseUrl}" uses plain HTTP — API key will be sent unencrypted. Use HTTPS for non-localhost endpoints.`,
      );
    }
  } catch {
    // Malformed URL — other code will handle this
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
    // Ollama Cloud endpoints also don't reliably support response_format
    if (hostname === "ollama.com" || hostname.endsWith(".ollama.com")) return false;
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
function buildSignal(abortSignal?: AbortSignal, timeoutMs: number = FETCH_TIMEOUT_MS): AbortSignal {
  return abortSignal
    ? AbortSignal.any([abortSignal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
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

  // H8: Wrap in try/finally to always release the reader lock — prevents resource
  // leaks on normal completion, abort, or exceptions thrown by onData callbacks.
  try {
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
  } finally {
    reader.releaseLock();
  }
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
      const signal = buildSignal(abortSignal, config.timeout);
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
          max_tokens: config.maxTokens,
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

      const data: unknown = await response.json();
      return extractAnthropicText(data);
    } catch (err) {
      if (attempt >= config.maxRetries || !isTransientError(err)) {
        throw err;
      }
      await abortableDelay(500 * 2 ** attempt * (0.75 + Math.random() * 0.5), abortSignal);
    }
  }
  return null;
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
      const signal = buildSignal(abortSignal, config.timeout);
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
          max_tokens: config.maxTokens,
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
          const delta = extractAnthropicDelta(JSON.parse(data) as unknown);
          // C3: Cap accumulated size to prevent OOM from unbounded streaming
          if (delta && accumulated.length + delta.length <= MAX_SSE_ACCUMULATED_BYTES) {
            accumulated += delta;
          }
        } catch {
          // Skip malformed SSE chunks
        }
      });
      if (!ok) return null;

      return accumulated || null;
    } catch (err) {
      if (attempt >= config.maxRetries || !isTransientError(err)) {
        throw err;
      }
      await abortableDelay(500 * 2 ** attempt * (0.75 + Math.random() * 0.5), abortSignal);
    }
  }
  return null;
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
  jsonMode: boolean = true,
): Promise<string | null> {
  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      const signal = buildSignal(abortSignal, config.timeout);

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
          // H6: Explicit max_tokens to prevent unbounded generation on OpenAI-compatible providers
          max_tokens: config.maxTokens,
          // Only send response_format for providers known to support it;
          // local providers (Ollama, LM Studio) return HTTP 400 on this param.
          ...(jsonMode && supportsJsonMode(config.baseUrl)
            ? { response_format: { type: "json_object" } }
            : {}),
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
      if (attempt >= config.maxRetries || !isTransientError(err)) {
        throw err;
      }
      await abortableDelay(500 * 2 ** attempt * (0.75 + Math.random() * 0.5), abortSignal);
    }
  }
  return null;
}

export async function parseNonStreaming(response: Response): Promise<string | null> {
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    // Non-JSON body (e.g., HTML 502 from proxy)
    return null;
  }
  return extractOpenAIContent(data);
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
      const chunk = extractOpenAIDelta(JSON.parse(data) as unknown);
      // C3: Cap accumulated size to prevent OOM from unbounded streaming
      if (chunk && accumulated.length + chunk.length <= MAX_SSE_ACCUMULATED_BYTES) {
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
  options?: { jsonMode?: boolean },
): Promise<string | null> {
  // H4: Reject empty API key early to avoid silent 401 retries
  if (!config.apiKey) {
    return null;
  }
  warnIfInsecureTransport(config.baseUrl);
  const messages = typeof prompt === "string" ? [{ role: "user", content: prompt }] : prompt;
  const jsonMode = options?.jsonMode !== false; // default true for backward compat

  if (isAnthropicNative(config)) {
    return anthropicRequest(config, messages, abortSignal);
  }
  return openAIRequest(config, messages, abortSignal, false, parseNonStreaming, jsonMode);
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
  // H4: Reject empty API key early to avoid silent 401 retries
  if (!config.apiKey) {
    return null;
  }
  warnIfInsecureTransport(config.baseUrl);
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
  // Duck-type: DOMException may not pass `instanceof Error` in forked
  // vitest workers or cross-realm contexts, so accept any object with
  // a `name` and `message` string.
  if (typeof err !== "object" || err === null) return false;
  if (!("name" in err) || typeof err.name !== "string") return false;
  if (!("message" in err) || typeof err.message !== "string") return false;

  const name = err.name;
  const msg = err.message.toLowerCase();
  // AbortError = deliberate cancellation by the caller, NOT transient — do not retry
  if (name === "AbortError") return false;
  return (
    name === "TimeoutError" ||
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
    msg.includes("api error 504") ||
    msg.includes("api error 529")
  );
}
