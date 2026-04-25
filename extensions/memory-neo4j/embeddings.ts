/**
 * Embedding generation for memory-neo4j.
 *
 * Supports both OpenAI and Ollama providers.
 * Includes an LRU cache to avoid redundant API calls within a session.
 */

import OpenAI from "openai";
import xxhashInit from "xxhash-wasm";
import type { EmbeddingProvider } from "./config.js";
import { contextLengthForModel, vectorDimsForModel } from "./config.js";
import type { MetricsCollector } from "./metrics.js";
import { NO_OP_METRICS } from "./metrics.js";
import { retryWithBackoff } from "./retry.js";
import type { Logger } from "./schema.js";

let h64ToString: ((input: string) => string) | null = null;
let h64InitPromise: Promise<void> | null = null;
async function ensureH64Init(): Promise<void> {
  if (h64ToString) {
    return;
  }
  if (!h64InitPromise) {
    h64InitPromise = xxhashInit().then((xxhash) => {
      h64ToString = xxhash.h64ToString;
    });
  }
  return h64InitPromise;
}
function getH64ToStringSync(): (input: string) => string {
  // L5: More descriptive error for debugging async initialization issues
  if (!h64ToString) {
    throw new Error(
      "memory-neo4j: xxhash not initialized — ensureH64Init() must be awaited before calling sync hash functions",
    );
  }
  return h64ToString;
}

/**
 * Simple LRU cache for embedding vectors.
 * Keyed by xxhash64 of the input text to avoid storing large strings.
 *
 * L1: xxhash64 is non-cryptographic with ~1/2^64 collision probability.
 * Acceptable for a session-scoped LRU cache where a collision would return
 * a wrong embedding for one query — not a security or data-integrity risk.
 */
class EmbeddingCache {
  private readonly map = new Map<string, number[]>();
  private readonly maxSize: number;

  constructor(maxSize: number = 500) {
    this.maxSize = maxSize;
  }

  /** Hash text synchronously. Caller must ensure ensureH64Init() has completed. */
  private static hashText(text: string): string {
    return getH64ToStringSync()(text);
  }

  get(text: string): number[] | undefined {
    const key = EmbeddingCache.hashText(text);
    const value = this.map.get(key);
    if (value !== undefined) {
      // Move to end (most recently used) by re-inserting
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  set(text: string, embedding: number[]): void {
    const key = EmbeddingCache.hashText(text);
    // If key exists, delete first to refresh position
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxSize) {
      // Evict oldest (first) entry — map guaranteed non-empty by size check
      this.map.delete(this.map.keys().next().value!);
    }
    this.map.set(key, embedding);
  }

  get size(): number {
    return this.map.size;
  }
}

/** Concurrency for Ollama embedding requests (configurable via OLLAMA_NUM_PARALLEL) */
const OLLAMA_EMBED_CONCURRENCY = (() => {
  const envVal = process.env.OLLAMA_NUM_PARALLEL;
  if (envVal === undefined) {
    return 4;
  }
  const parsed = Number.parseInt(envVal, 10);
  if (Number.isNaN(parsed)) {
    return 4;
  }
  return Math.max(1, Math.min(32, parsed));
})();

export class Embeddings {
  private client: OpenAI | null = null;
  private readonly provider: EmbeddingProvider;
  private readonly baseUrl: string;
  private readonly logger: Logger | undefined;
  private readonly contextLength: number;
  private readonly expectedDimensions: number;
  private readonly cache: EmbeddingCache;
  private readonly metrics: MetricsCollector;
  /** H5: In-flight request dedup — prevents duplicate API calls for the same text under concurrency. */
  private readonly inflight = new Map<string, Promise<number[]>>();

  constructor(
    private readonly apiKey: string | undefined,
    private readonly model: string = "text-embedding-3-small",
    provider: EmbeddingProvider = "openai",
    baseUrl?: string,
    logger?: Logger,
    metrics: MetricsCollector = NO_OP_METRICS,
    cacheSize?: number,
  ) {
    this.cache = new EmbeddingCache(cacheSize ?? 500);
    this.metrics = metrics;
    this.provider = provider;
    this.baseUrl = (baseUrl ?? (provider === "ollama" ? "http://localhost:11434" : "")).replace(
      /\/+$/,
      "",
    );
    this.logger = logger;
    this.contextLength = contextLengthForModel(model);
    this.expectedDimensions = vectorDimsForModel(model);

    if (provider === "openai") {
      if (!apiKey) {
        throw new Error("API key required for OpenAI embeddings");
      }
      this.client = new OpenAI({
        apiKey,
        ...(this.baseUrl ? { baseURL: this.baseUrl } : {}),
      });
    }
  }

  /**
   * Truncate text to fit within the model's context length.
   * Uses a conservative ~3 chars/token estimate to leave headroom —
   * code, URLs, and punctuation-heavy text tokenize at 1–2 chars/token,
   * so the classic ~4 estimate is too generous for mixed content.
   * Truncates at a word boundary when possible.
   */
  private truncateToContext(text: string): string {
    const maxChars = this.contextLength * 3;
    if (text.length <= maxChars) {
      return text;
    }

    // Try to truncate at a word boundary
    let truncated = text.slice(0, maxChars);
    const lastSpace = truncated.lastIndexOf(" ");
    if (lastSpace > maxChars * 0.8) {
      truncated = truncated.slice(0, lastSpace);
    }

    this.logger?.debug?.(
      `memory-neo4j: truncated embedding input from ${text.length} to ${truncated.length} chars (model context: ${this.contextLength} tokens)`,
    );
    return truncated;
  }

  /**
   * Validate that an embedding has the expected dimensions for the configured model.
   * Throws if the dimension count doesn't match, preventing silent index corruption.
   */
  private validateDimensions(embedding: number[], context?: string): void {
    if (embedding.length !== this.expectedDimensions) {
      const msg =
        `memory-neo4j: embedding dimension mismatch — got ${embedding.length}, ` +
        `expected ${this.expectedDimensions} for model ${this.model}` +
        (context ? ` (${context})` : "");
      this.logger?.error?.(msg);
      throw new Error(msg);
    }
  }

  /**
   * Generate an embedding vector for a single text.
   * Results are cached to avoid redundant API calls.
   */
  async embed(text: string): Promise<number[]> {
    await ensureH64Init();
    const input = this.truncateToContext(text);

    // Check cache first (sync after init)
    const cached = this.cache.get(input);
    if (cached) {
      this.logger?.debug?.("memory-neo4j: embedding cache hit");
      this.metrics.increment("embeddings.cache_hit");
      return cached;
    }

    // H5: Dedup concurrent API calls for the same text — second caller awaits the first's promise
    const existing = this.inflight.get(input);
    if (existing) {
      return existing;
    }

    const promise = this.doEmbed(input);
    this.inflight.set(input, promise);
    try {
      return await promise;
    } finally {
      this.inflight.delete(input);
    }
  }

  private async doEmbed(input: string): Promise<number[]> {
    this.metrics.increment("embeddings.cache_miss");
    const t0 = performance.now();
    const embedding =
      this.provider === "ollama" ? await this.embedOllama(input) : await this.embedOpenAI(input);
    this.metrics.histogram("embedding.latency_ms", performance.now() - t0);

    this.validateDimensions(embedding);
    this.cache.set(input, embedding);

    return embedding;
  }

  /**
   * Generate embeddings for multiple texts.
   * Returns array of embeddings in the same order as input.
   *
   * For Ollama: processes in chunks of OLLAMA_EMBED_CONCURRENCY to avoid
   * overwhelming the local server. Individual failures don't break the
   * entire batch — failed embeddings are replaced with empty arrays.
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    await ensureH64Init();
    const truncated = texts.map((t) => this.truncateToContext(t));

    // Check cache for each text (sync after init); only compute uncached ones
    const results: (number[] | null)[] = truncated.map((t) => this.cache.get(t) ?? null);
    const uncachedIndices: number[] = [];
    const uncachedTexts: string[] = [];
    for (let i = 0; i < results.length; i++) {
      if (results[i] === null) {
        uncachedIndices.push(i);
        uncachedTexts.push(truncated[i]);
      }
    }

    if (uncachedTexts.length === 0) {
      this.logger?.debug?.(`memory-neo4j: embedBatch fully cached (${texts.length} texts)`);
      return results as number[][];
    }

    let computed: number[][];

    if (this.provider === "ollama") {
      computed = await this.embedBatchOllama(uncachedTexts);
    } else {
      computed = await this.embedBatchOpenAI(uncachedTexts);
    }

    // Merge computed results back, validate dimensions, and populate L1 cache
    let failCount = 0;
    for (let i = 0; i < uncachedIndices.length; i++) {
      const embedding = computed[i];
      if (embedding.length === 0) {
        failCount++;
        this.logger?.warn?.(
          `memory-neo4j: embedBatch: empty embedding at index ${uncachedIndices[i]}`,
        );
        // Leave results[i] as null — callers must handle missing embeddings
        continue;
      }
      this.validateDimensions(embedding, `batch index ${uncachedIndices[i]}`);
      this.cache.set(uncachedTexts[i], embedding);
      results[uncachedIndices[i]] = embedding;
    }

    if (failCount > 0) {
      if (failCount > uncachedTexts.length / 2) {
        throw new Error(
          `memory-neo4j: embedBatch: ${failCount}/${uncachedTexts.length} embeddings failed (exceeded 50% threshold)`,
        );
      }
      this.logger?.warn?.(
        `memory-neo4j: embedBatch: ${failCount}/${uncachedTexts.length} embeddings failed`,
      );
    }

    // H5: Replace any remaining null entries with empty arrays so the return type is honest.
    // Callers must check for empty arrays (length === 0) to detect failed embeddings.
    return results.map((r) => r ?? []);
  }

  /**
   * H10: Ollama batch embedding using native multi-input support.
   * The /api/embed endpoint accepts an array of inputs directly, avoiding
   * N individual HTTP requests per batch. Falls back to individual requests
   * if the batch call fails (older Ollama versions).
   */
  private async embedBatchOllama(texts: string[]): Promise<number[][]> {
    // Try native batch first (Ollama >= 0.4.0 supports multi-input)
    for (let i = 0; i < texts.length; i += OLLAMA_EMBED_CONCURRENCY) {
      const chunk = texts.slice(i, i + OLLAMA_EMBED_CONCURRENCY);
      try {
        const batchResult = await this.fetchOllamaBatchEmbedding(chunk);
        if (batchResult.length === chunk.length) {
          // Native batch worked — process remaining chunks the same way
          const embeddings: number[][] = [...batchResult];
          for (
            let j = i + OLLAMA_EMBED_CONCURRENCY;
            j < texts.length;
            j += OLLAMA_EMBED_CONCURRENCY
          ) {
            const nextChunk = texts.slice(j, j + OLLAMA_EMBED_CONCURRENCY);
            try {
              const nextResult = await this.fetchOllamaBatchEmbedding(nextChunk);
              embeddings.push(...nextResult);
            } catch {
              // Chunk failed — fill with empty arrays
              for (let k = 0; k < nextChunk.length; k++) {
                embeddings.push([]);
              }
            }
          }
          return embeddings;
        }
      } catch {
        // Native batch not supported — fall back to individual requests
        this.logger?.debug?.(
          "memory-neo4j: Ollama batch embed not supported, falling back to individual requests",
        );
      }
      break; // Only try batch detection on first chunk
    }

    // Fallback: individual requests with concurrency
    const embeddings: number[][] = [];
    let failures = 0;

    for (let i = 0; i < texts.length; i += OLLAMA_EMBED_CONCURRENCY) {
      const chunk = texts.slice(i, i + OLLAMA_EMBED_CONCURRENCY);
      const chunkResults = await Promise.allSettled(chunk.map((t) => this.embedOllama(t)));

      for (let j = 0; j < chunkResults.length; j++) {
        const result = chunkResults[j];
        if (result.status === "fulfilled") {
          embeddings.push(result.value);
        } else {
          failures++;
          this.logger?.warn?.(
            `memory-neo4j: Ollama embedding failed for text ${i + j}: ${String(result.reason)}`,
          );
          embeddings.push([]);
        }
      }
    }

    if (failures > 0) {
      this.logger?.warn?.(
        `memory-neo4j: ${failures}/${texts.length} Ollama embeddings failed in batch`,
      );
    }

    return embeddings;
  }

  /** H10: Native batch embedding — sends multiple texts in a single HTTP request. */
  private async fetchOllamaBatchEmbedding(texts: string[]): Promise<number[][]> {
    const url = `${this.baseUrl}/api/embed`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        input: texts,
        keep_alive: -1,
      }),
      signal: AbortSignal.timeout(Embeddings.EMBED_TIMEOUT_MS),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Ollama batch embedding failed: ${response.status} ${error}`);
    }

    const data = (await response.json()) as { embeddings?: number[][] };
    if (!data.embeddings || data.embeddings.length !== texts.length) {
      throw new Error(
        `Ollama batch embedding count mismatch — sent ${texts.length}, got ${data.embeddings?.length ?? 0}`,
      );
    }
    return data.embeddings;
  }

  private async embedOpenAI(text: string): Promise<number[]> {
    if (!this.client) {
      throw new Error("OpenAI client not initialized");
    }
    // The `dimensions` param (Matryoshka representation) is only supported by
    // text-embedding-3-* models. Sending it to ada-002 or compatible servers
    // that don't implement it causes 400/422 errors.
    const supportsCustomDimensions = this.model.startsWith("text-embedding-3");
    const response = await retryWithBackoff(
      () =>
        this.client!.embeddings.create({
          model: this.model,
          input: text,
          ...(supportsCustomDimensions ? { dimensions: this.expectedDimensions } : {}),
        }),
      { maxAttempts: 3, baseDelayMs: 300, backoffExponent: 2 },
    );
    const item = response.data[0];
    if (!item) {
      throw new Error(
        `memory-neo4j: OpenAI returned empty embedding response for model ${this.model}`,
      );
    }
    return item.embedding;
  }

  private async embedBatchOpenAI(texts: string[]): Promise<number[][]> {
    if (!this.client) {
      throw new Error("OpenAI client not initialized");
    }
    // Same guard as embedOpenAI — only text-embedding-3-* supports `dimensions`.
    const supportsCustomDimensions = this.model.startsWith("text-embedding-3");
    const response = await retryWithBackoff(
      () =>
        this.client!.embeddings.create({
          model: this.model,
          input: texts,
          ...(supportsCustomDimensions ? { dimensions: this.expectedDimensions } : {}),
        }),
      { maxAttempts: 3, baseDelayMs: 300, backoffExponent: 2 },
    );
    // H6: Validate response count matches input count
    if (response.data.length === 0) {
      throw new Error(
        `memory-neo4j: OpenAI returned empty batch embedding response for model ${this.model}`,
      );
    }
    if (response.data.length !== texts.length) {
      throw new Error(
        `memory-neo4j: OpenAI batch embedding count mismatch — sent ${texts.length} texts, got ${response.data.length} embeddings for model ${this.model}`,
      );
    }
    // Sort by index to ensure correct order
    return [...response.data].toSorted((a, b) => a.index - b.index).map((d) => d.embedding);
  }

  // Timeout for Ollama embedding fetch calls to prevent hanging indefinitely
  private static readonly EMBED_TIMEOUT_MS = 30_000;
  // Retry configuration for transient Ollama errors (model loading, GPU pressure)
  private static readonly OLLAMA_MAX_RETRIES = 2;
  private static readonly OLLAMA_RETRY_BASE_DELAY_MS = 1000;

  private async embedOllama(text: string): Promise<number[]> {
    return retryWithBackoff(() => this.fetchOllamaEmbedding(text), {
      maxAttempts: Embeddings.OLLAMA_MAX_RETRIES + 1,
      baseDelayMs: Embeddings.OLLAMA_RETRY_BASE_DELAY_MS,
      backoffExponent: 2,
      onRetry: (err, attempt) => {
        this.logger?.warn?.(
          `memory-neo4j: Ollama embedding failed (attempt ${attempt + 1}/${Embeddings.OLLAMA_MAX_RETRIES + 1}), retrying: ${String(err)}`,
        );
      },
    });
  }

  private async fetchOllamaEmbedding(text: string): Promise<number[]> {
    const url = `${this.baseUrl}/api/embed`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        input: text,
        keep_alive: -1,
      }),
      signal: AbortSignal.timeout(Embeddings.EMBED_TIMEOUT_MS),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Ollama embedding failed: ${response.status} ${error}`);
    }

    const data = (await response.json()) as { embeddings?: number[][] };
    if (!data.embeddings?.[0]) {
      throw new Error("No embedding returned from Ollama");
    }
    return data.embeddings[0];
  }
}

/**
 * Compute cosine similarity between two embedding vectors.
 * Returns a value between -1 and 1 (1 = identical, 0 = orthogonal).
 * Returns 0 if either vector is empty or they differ in length.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) {
    return 0;
  }
  const sim = dot / denom;
  return Number.isFinite(sim) ? sim : 0;
}
