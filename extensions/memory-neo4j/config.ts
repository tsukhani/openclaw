/**
 * Configuration schema for memory-neo4j plugin.
 *
 * Uses TypeBox for structural validation & defaults, with a thin
 * post-processing layer for env var resolution, regex compilation,
 * URI/timezone validation, and relationship type sanitization.
 */

import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { MemoryCategory, RerankerConfig } from "./schema.js";
import { MEMORY_CATEGORIES, sanitizeRelationshipType } from "./schema.js";

export type { RerankerConfig };

export type { MemoryCategory };
export { MEMORY_CATEGORIES };

export type EmbeddingProvider = "openai" | "ollama";

export type MemoryNeo4jConfig = {
  neo4j: {
    uri: string;
    username: string;
    password: string;
  };
  embedding: {
    provider: EmbeddingProvider;
    apiKey?: string;
    model: string;
    baseUrl?: string;
  };
  extraction?: {
    apiKey?: string;
    model: string;
    baseUrl: string;
    /** Per-request timeout in ms for LLM fetch calls. Default: 30000. */
    timeout?: number;
    /** Parallel LLM calls during sleep cycle phases. Default: 8. */
    concurrency?: number;
    /** Enable local NER extraction (regex + transformer) before LLM fallback. Default: true. */
    localNerEnabled?: boolean;
    /** Max tokens for LLM completion. Default: 4096. Reasoning models need higher (e.g. 16384). */
    maxTokens?: number;
  };
  autoCapture: boolean;
  autoCaptureSkipPattern?: RegExp;
  autoRecall: boolean;
  autoRecallMinScore: number;
  /**
   * RegExp pattern to skip auto-recall for matching session keys.
   * Useful for voice/realtime sessions where latency is critical.
   * Example: /voice|realtime/ skips sessions containing "voice" or "realtime".
   */
  autoRecallSkipPattern?: RegExp;
  coreMemory: {
    enabled: boolean;
    /**
     * Re-inject core memories when context usage reaches this percentage (0-100).
     * Helps counter "lost in the middle" phenomenon by refreshing core memories
     * closer to the end of context for recency bias.
     * Set to null/undefined to disable (default).
     */
    refreshAtContextPercent?: number;
  };
  /**
   * Upper bound for relationship hops during graph search traversal.
   * Default: 6. Effective depth is controlled by the hop decay threshold
   * (0.7 per hop) — results below the threshold are filtered out, so
   * traversal self-limits based on confidence rather than a hard cap.
   */
  graphSearchDepth: number;
  /**
   * Maximum number of seed entities to look up in the fulltext index per graph search.
   * Default: 5. Lower values reduce query latency; higher values increase recall.
   */
  graphSeedCap?: number;
  /**
   * Relationship types to traverse during graph search spreading activation.
   * Default: null (traverse all allowed relationship types).
   * Example: ["WORKS_AT", "KNOWS"] to focus graph traversal.
   */
  graphRelTypes?: string[] | null;
  /**
   * Relationship types to traverse during causal chain search (why/because queries).
   * Default: ["CAUSED_BY", "LED_TO", "RESULTED_IN", "ENABLED_BY", "PREVENTED_BY"].
   * Must be UPPER_SNAKE_CASE. Validated via sanitizeRelationshipType().
   */
  graphCausalRelTypes?: string[];
  /**
   * Canonical name of the user's entity in the graph for possessive pronoun resolution.
   * Resolved from USER.md at runtime if not set.
   */
  selfEntityName?: string;
  /**
   * Per-category decay curve parameters. Each category can have its own
   * half-life (days) controlling how fast memories in that category decay.
   * Categories not listed use the sleep cycle's default (30 days).
   */
  decayCurves: Record<string, { halfLifeDays: number }>;
  sleepCycle: {
    /**
     * Cron expression controlling when the sleep cycle runs automatically.
     * Example: "0 3 * * *" runs at 03:00 every night.
     * Set to null (default) to disable automatic scheduling — opt-in.
     * @deprecated `auto`/`autoIntervalMs` fields are no longer supported; use `schedule` instead.
     */
    schedule: string | null;
    /** Timezone for the cron schedule. Defaults to "local". Example: "America/New_York". */
    tz: string;
  };
  conflictDetection: {
    /** Enable LLM-based conflict detection on new memory store */
    enabled: boolean;
    /** Model to use for conflict classification (defaults to extraction model) */
    model?: string;
    /** Vector similarity threshold to identify conflict candidates (default: 0.82) */
    similarityThreshold: number;
    /** Maximum candidates to check per store operation (default: 5) */
    maxCandidates: number;
    /** Batch size for Phase 3c retroactive conflict scan (default: 50) */
    sleepScanBatchSize: number;
  };
  /**
   * Multiplicative weight for the recency boost applied after RRF fusion (OP-121).
   * Formula: rrfScore * (1 + recencyWeight * exp(-daysSince / 365))
   * Default: 0.1. Set to 0 to disable recency boost.
   */
  recencyWeight: number;
  decomposition: {
    /**
     * Enable atomic fact decomposition (Phase 2c).
     * Splits multi-fact memories (3+ entities) into independent atomic facts
     * linked back to the source via DERIVED_FROM relationships.
     * Default: false (opt-in until validated).
     */
    enabled: boolean;
  };
  metrics?: {
    /** Enable structured metrics emission to logger (default: false) */
    enabled: boolean;
    /** Interval in ms between metric summary flushes (default: 60000) */
    logIntervalMs?: number;
  };
  /** Cross-encoder reranker configuration (OP-130). Default: disabled. */
  reranker?: RerankerConfig;
  /** Query result cache configuration. Default: disabled. */
  cache?: {
    enabled: boolean;
    /** TTL in milliseconds for cached search results. Default: 300000 (5 min). */
    ttlMs?: number;
    /** Max number of cached search results. Default: 200. */
    maxSize?: number;
  };
  /** Memory source trust scoring configuration. Default: enabled with safe defaults. */
  trustScoring?: {
    enabled: boolean;
    /** Default trust scores per MemorySource type. Unlisted sources default to 1.0. */
    sourceDefaults?: Record<string, number>;
  };
  /** Community detection and summarization. Default: disabled. */
  communityDetection?: {
    enabled: boolean;
    /** Minimum entities per community. Default: 3. */
    minCommunitySize?: number;
    /** Max label propagation iterations. Default: 10. */
    maxIterations?: number;
    /** Weight of community signal in RRF fusion. Default: 0.15. */
    signalWeight?: number;
  };
  /** Episodic memory (non-lossy conversation preservation). Default: disabled. */
  episodicMemory?: {
    enabled: boolean;
    /** Also capture assistant messages. Default: false. */
    captureAssistant?: boolean;
    /** Days to retain episodes before cleanup. Default: 30. */
    retentionDays?: number;
  };
  /** Instruction-pattern detection on writes. Default: enabled (heuristic only). */
  instructionDetection?: {
    enabled: boolean;
    /** Enable LLM fallback for ambiguous cases. Default: false. */
    llmFallback?: boolean;
  };
  /**
   * CARA disposition parameters that shape how the agent reasons during reflection (OP-188).
   * Each parameter is an integer 1–5 (default 3).
   */
  disposition?: {
    /** How much evidence is needed before forming beliefs. 1 = credulous, 5 = highly skeptical. */
    skepticism: number;
    /** How literally to interpret evidence. 1 = very figurative, 5 = very literal. */
    literalism: number;
    /** How much to weight emotional/preference signals. 1 = low empathy, 5 = high empathy. */
    empathy: number;
  };
};

/**
 * Extraction configuration resolved from environment variables.
 * Entity extraction auto-enables when OPENROUTER_API_KEY is set.
 */
export type ExtractionConfig = {
  enabled: boolean;
  apiKey: string;
  model: string;
  baseUrl: string;
  temperature: number;
  maxRetries: number;
  /** Per-request timeout in ms for LLM fetch calls. Default: 30000 (30s). */
  timeout: number;
  /** Parallel LLM calls during sleep cycle phases. Default: 8 (local Ollama). */
  concurrency: number;
  /** Enable local NER extraction (regex + transformer) before LLM fallback. Default: true. */
  localNerEnabled: boolean;
  /** Max tokens for LLM completion. Default: 4096. Reasoning models need higher (e.g. 16384). */
  maxTokens: number;
  /**
   * CARA disposition parameters that shape reflection reasoning (OP-188).
   * Each parameter is an integer 1–5 (default 3).
   */
  disposition?: { skepticism: number; literalism: number; empathy: number };
};

export const EMBEDDING_DIMENSIONS: Record<string, number> = {
  // OpenAI models
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  // Ollama models (common ones)
  "mxbai-embed-large": 1024,
  "mxbai-embed-large-2k:latest": 1024,
  "nomic-embed-text": 768,
  "all-minilm": 384,
  // Qwen3 embedding models (MRL-capable: supports truncation via dimensions param)
  "qwen3-embedding:0.6b": 1024, // native 1024
  "qwen3-embedding:4b": 2560, // native 2560
  "qwen3-embedding:8b": 4096, // native 4096
  "qwen3-embedding": 4096, // latest = 8B
};

// Default dimension for unknown models (Ollama models vary)
export const DEFAULT_EMBEDDING_DIMS = 1024;

/**
 * Lookup a value by exact key or longest matching prefix.
 * Returns undefined if no match found.
 */
function lookupByPrefix<T>(table: Record<string, T>, key: string): T | undefined {
  if (table[key] !== undefined) {
    return table[key];
  }
  let best: { value: T; keyLen: number } | undefined;
  for (const [known, value] of Object.entries(table)) {
    if (key.startsWith(known) && (!best || known.length > best.keyLen)) {
      best = { value, keyLen: known.length };
    }
  }
  return best?.value;
}

export function vectorDimsForModel(model: string): number {
  // Return default for unknown models — callers should warn when this path is taken,
  // as the default 1024 dimensions may not match the actual model's output.
  return lookupByPrefix(EMBEDDING_DIMENSIONS, model) ?? DEFAULT_EMBEDDING_DIMS;
}

/** Max input token lengths for known embedding models. */
export const EMBEDDING_CONTEXT_LENGTHS: Record<string, number> = {
  // OpenAI models
  "text-embedding-3-small": 8191,
  "text-embedding-3-large": 8191,
  // Ollama models
  "mxbai-embed-large": 512,
  "mxbai-embed-large-2k": 2048,
  "mxbai-embed-large-8k": 8192,
  "nomic-embed-text": 8192,
  "all-minilm": 256,
  // Qwen3 embedding (0.6b: 32k, 4b/8b: 40k)
  "qwen3-embedding:0.6b": 32000,
  "qwen3-embedding": 40000,
};

/** Conservative default for unknown models. */
export const DEFAULT_EMBEDDING_CONTEXT_LENGTH = 512;

export function contextLengthForModel(model: string): number {
  return lookupByPrefix(EMBEDDING_CONTEXT_LENGTHS, model) ?? DEFAULT_EMBEDDING_CONTEXT_LENGTH;
}

/**
 * Resolve ${ENV_VAR} references in string values.
 * Only env vars with allowed prefixes are resolved (security guardrail).
 */
// M9/M10: Added OPENROUTER_ and EXTRACTION_ prefixes used by resolveExtractionConfig
const ALLOWED_ENV_VAR_PATTERN =
  /^(NEO4J_|OPENAI_|ANTHROPIC_|OLLAMA_|MEMORY_|OPENCLAW_|OPENROUTER_|EXTRACTION_)/i;

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, varName) => {
    if (!ALLOWED_ENV_VAR_PATTERN.test(varName)) {
      throw new Error(
        `memory-neo4j config: resolveEnvVars blocked non-allowlisted env var: ${varName}`,
      );
    }
    const envValue = process.env[varName];
    if (!envValue) {
      throw new Error(`Environment variable ${varName} is not set`);
    }
    return envValue;
  });
}

/**
 * Resolve extraction config from plugin config with env var fallback.
 * Enabled when an API key is available (cloud) or a baseUrl is explicitly
 * configured (Ollama / local LLMs that don't need a key).
 */
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
const DEFAULT_LLM_CONCURRENCY = 4;

export function resolveExtractionConfig(
  cfgExtraction?: MemoryNeo4jConfig["extraction"],
  cfgDisposition?: MemoryNeo4jConfig["disposition"],
): ExtractionConfig {
  // Default extraction model: Sonnet balances quality and cost for structured JSON
  // extraction (entity/relationship/tag extraction, importance rating, dedup
  // classification, conflict detection, temporal staleness).
  // Override via extraction.model in plugin config or EXTRACTION_MODEL env var.
  const model =
    cfgExtraction?.model ?? process.env.EXTRACTION_MODEL ?? "anthropic/claude-sonnet-4-6";

  // Determine the provider from explicit config, then fall back to model-name heuristics.
  //
  // Resolution priority for baseUrl:
  //   1. Explicit plugin config baseUrl (always wins)
  //   2. EXTRACTION_BASE_URL env var
  //   3. Auto-detect from model name: Anthropic models → api.anthropic.com, others → OpenRouter
  //      Exception: if only OPENROUTER_API_KEY is available (no ANTHROPIC_API_KEY), route
  //      Anthropic models through OpenRouter instead of native API.
  //
  // Resolution priority for apiKey:
  //   1. Explicit plugin config apiKey
  //   2. For Anthropic native baseUrl: ANTHROPIC_API_KEY env → OPENROUTER_API_KEY fallback
  //   3. For everything else: OPENROUTER_API_KEY env

  const isAnthropicModel =
    model.toLowerCase().startsWith("anthropic/") || model.toLowerCase().startsWith("claude-");

  let apiKey: string;
  let baseUrl: string;

  if (cfgExtraction?.baseUrl) {
    // Explicit baseUrl in plugin config — respect it regardless of model name.
    // This handles OpenRouter routing Anthropic models via OpenAI-compatible API.
    baseUrl = cfgExtraction.baseUrl;
    apiKey = cfgExtraction?.apiKey ?? process.env.OPENROUTER_API_KEY ?? "";
  } else if (process.env.EXTRACTION_BASE_URL) {
    // Explicit env var baseUrl — also takes priority over model-name detection.
    baseUrl = process.env.EXTRACTION_BASE_URL;
    apiKey = cfgExtraction?.apiKey ?? process.env.OPENROUTER_API_KEY ?? "";
  } else if (isAnthropicModel) {
    // No explicit baseUrl + Anthropic model → try native Anthropic API.
    const anthropicKey = cfgExtraction?.apiKey ?? process.env.ANTHROPIC_API_KEY ?? "";
    if (anthropicKey) {
      // Have an Anthropic-compatible key → use native API
      apiKey = anthropicKey;
      baseUrl = "https://api.anthropic.com";
    } else {
      // No Anthropic key → fall back to OpenRouter (OpenAI-compatible format)
      apiKey = process.env.OPENROUTER_API_KEY ?? "";
      baseUrl = "https://openrouter.ai/api/v1";
    }
  } else {
    // Non-Anthropic model → OpenAI-compatible (OpenRouter, Ollama, etc.)
    apiKey = cfgExtraction?.apiKey ?? process.env.OPENROUTER_API_KEY ?? "";
    baseUrl = "https://openrouter.ai/api/v1";
  }

  // Enabled when an API key is set (cloud provider) or baseUrl was explicitly
  // configured in the plugin config (Ollama / local — no key needed).
  // M2: Check for non-empty baseUrl to avoid enabling on empty string ""
  const enabled =
    apiKey.length > 0 || (cfgExtraction?.baseUrl != null && cfgExtraction.baseUrl.length > 0);
  return {
    enabled,
    apiKey,
    model,
    baseUrl,
    temperature: 0.0,
    maxRetries: 2,
    timeout: cfgExtraction?.timeout ?? DEFAULT_FETCH_TIMEOUT_MS,
    concurrency: cfgExtraction?.concurrency ?? DEFAULT_LLM_CONCURRENCY,
    localNerEnabled: cfgExtraction?.localNerEnabled !== false,
    maxTokens: cfgExtraction?.maxTokens ?? 4096,
    disposition: cfgDisposition ?? { skepticism: 3, literalism: 3, empathy: 3 },
  };
}

// ---------------------------------------------------------------------------
// TypeBox sub-section schemas — additionalProperties: false for key rejection
// ---------------------------------------------------------------------------

/** Build a TypeBox object schema that accepts only the listed keys (all optional). */
function allowedKeys(...keys: string[]) {
  const props: Record<string, ReturnType<typeof Type.Optional>> = {};
  for (const k of keys) props[k] = Type.Optional(Type.Unknown());
  return Type.Object(props, { additionalProperties: false });
}

const SUB_SCHEMAS: Record<string, ReturnType<typeof allowedKeys>> = {
  neo4j: allowedKeys("uri", "user", "username", "password"),
  embedding: allowedKeys("provider", "apiKey", "model", "baseUrl"),
  extraction: allowedKeys(
    "apiKey",
    "model",
    "baseUrl",
    "timeout",
    "concurrency",
    "localNerEnabled",
    "maxTokens",
  ),
  coreMemory: allowedKeys("enabled", "refreshAtContextPercent"),
  sleepCycle: allowedKeys("auto", "autoIntervalMs", "schedule", "tz"),
  conflictDetection: allowedKeys(
    "enabled",
    "model",
    "similarityThreshold",
    "maxCandidates",
    "sleepScanBatchSize",
  ),
  decomposition: allowedKeys("enabled"),
  metrics: allowedKeys("enabled", "logIntervalMs"),
  reranker: allowedKeys(
    "enabled",
    "provider",
    "model",
    "topK",
    "topJ",
    "minScore",
    "extractionMode",
    "rrfWeight",
  ),
  cache: allowedKeys("enabled", "ttlMs", "maxSize"),
  trustScoring: allowedKeys("enabled", "sourceDefaults"),
  communityDetection: allowedKeys("enabled", "minCommunitySize", "maxIterations", "signalWeight"),
  episodicMemory: allowedKeys("enabled", "captureAssistant", "retentionDays"),
  instructionDetection: allowedKeys("enabled", "llmFallback"),
  disposition: allowedKeys("skepticism", "literalism", "empathy"),
};

const TOP_LEVEL_KEYS = [
  "embedding",
  "neo4j",
  "autoCapture",
  "autoCaptureSkipPattern",
  "autoRecall",
  "autoRecallMinScore",
  "autoRecallSkipPattern",
  "coreMemory",
  "extraction",
  "graphSearchDepth",
  "graphSeedCap",
  "graphRelTypes",
  "graphCausalRelTypes",
  "selfEntityName",
  "decayCurves",
  "sleepCycle",
  "conflictDetection",
  "recencyWeight",
  "decomposition",
  "metrics",
  "reranker",
  "cache",
  "trustScoring",
  "communityDetection",
  "episodicMemory",
  "instructionDetection",
  "disposition",
];

const RawConfigSchema = allowedKeys(...TOP_LEVEL_KEYS);

// ---------------------------------------------------------------------------
// Sub-section validation helper
// ---------------------------------------------------------------------------

/** Validate a sub-section object against its allowed-keys schema. */
function checkSubSection(raw: unknown, name: string) {
  const schema = SUB_SCHEMAS[name];
  if (!schema) return;
  const obj = (raw ?? {}) as Record<string, unknown>;
  if (!Value.Check(schema, obj)) {
    const allowed = new Set(Object.keys(schema.properties));
    const unknown = Object.keys(obj).filter((k) => !allowed.has(k));
    throw new Error(`${name} config has unknown keys: ${unknown.join(", ")}`);
  }
}

const VALID_NEO4J_SCHEMES = [
  "bolt://",
  "bolt+s://",
  "bolt+ssc://",
  "neo4j://",
  "neo4j+s://",
  "neo4j+ssc://",
];

/** Compile a regex pattern string with length guard and error wrapping. */
function compileRegex(pattern: string | undefined, fieldName: string): RegExp | undefined {
  if (!pattern) return undefined;
  if (pattern.length > 200) {
    throw new Error(`memory-neo4j config: ${fieldName} too long (max 200 chars)`);
  }
  try {
    return new RegExp(pattern);
  } catch (e) {
    throw new Error(`memory-neo4j config: invalid ${fieldName} regex — ${String(e)}`);
  }
}

/** Validate relationship type array entries via sanitizeRelationshipType(). */
function validateRelTypes(types: string[], fieldName: string): void {
  const invalid = types.filter((t) => sanitizeRelationshipType(t) === null);
  if (invalid.length > 0) {
    const example =
      fieldName === "graphCausalRelTypes" ? "CAUSED_BY, LED_TO" : "WORKS_AT, PARENT_OF";
    throw new Error(
      `memory-neo4j config: ${fieldName} contains invalid relationship type(s): ${invalid.join(", ")}. ` +
        `Types must be UPPER_SNAKE_CASE (e.g. ${example}).`,
    );
  }
}

/** Parse a string-typed relationship array from raw config, validating entries. */
function parseRelTypeArray(
  raw: unknown,
  fieldName: string,
  rejectNonArray: boolean,
): string[] | undefined {
  if (Array.isArray(raw)) {
    const filtered = raw.filter((t): t is string => typeof t === "string" && t.length > 0);
    if (filtered.length > 0) validateRelTypes(filtered, fieldName);
    return filtered;
  }
  if (raw !== undefined && (rejectNonArray || raw !== null)) {
    throw new Error(`${fieldName} must be an array of strings`);
  }
  return undefined;
}

/** Parse a positive integer from raw config with a default. */
function parsePositiveInt(
  raw: unknown,
  fieldName: string,
  defaultVal?: number,
): number | undefined {
  if (typeof raw !== "number") return defaultVal;
  if (raw < 1 || !Number.isInteger(raw)) {
    throw new Error(`${fieldName} must be a positive integer, got: ${raw}`);
  }
  return raw;
}

/** Read a sub-section as Record, with TypeBox unknown-key rejection. */
function section(cfg: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const raw = cfg[key] as Record<string, unknown> | undefined;
  checkSubSection(raw, key);
  return raw;
}

// ---------------------------------------------------------------------------
// Public parse interface
// ---------------------------------------------------------------------------

/**
 * Config schema with parse method for runtime validation & transformation.
 * Uses TypeBox for structural validation (unknown key rejection),
 * then applies env var resolution, regex compilation, and domain validation.
 */
export const memoryNeo4jConfigSchema = {
  parse(value: unknown): MemoryNeo4jConfig {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("memory-neo4j config required");
    }
    // Top-level unknown key rejection via TypeBox additionalProperties: false
    if (!Value.Check(RawConfigSchema, value)) {
      const allowed = new Set(Object.keys(RawConfigSchema.properties));
      const unknown = Object.keys(value as Record<string, unknown>).filter((k) => !allowed.has(k));
      throw new Error(`memory-neo4j config has unknown keys: ${unknown.join(", ")}`);
    }
    const cfg = value as Record<string, unknown>;

    // -- neo4j --
    const neo4jRaw = cfg.neo4j as Record<string, unknown> | undefined;
    if (!neo4jRaw || typeof neo4jRaw !== "object")
      throw new Error("neo4j config section is required");
    checkSubSection(neo4jRaw, "neo4j");
    if (typeof neo4jRaw.uri !== "string" || !neo4jRaw.uri) throw new Error("neo4j.uri is required");
    const neo4jUri = resolveEnvVars(neo4jRaw.uri);
    if (!VALID_NEO4J_SCHEMES.some((s) => neo4jUri.startsWith(s))) {
      throw new Error(
        `neo4j.uri must start with a valid scheme (${VALID_NEO4J_SCHEMES.join(", ")}), got: "${neo4jUri}"`,
      );
    }
    const neo4jPassword =
      typeof neo4jRaw.password === "string" ? resolveEnvVars(neo4jRaw.password) : "";
    const neo4jUsername =
      typeof neo4jRaw.user === "string"
        ? resolveEnvVars(neo4jRaw.user)
        : typeof neo4jRaw.username === "string"
          ? resolveEnvVars(neo4jRaw.username)
          : "neo4j";

    // -- embedding --
    const embeddingRaw = section(cfg, "embedding");
    // M7: Reject unknown provider values instead of silently defaulting to "openai"
    const rawProvider = embeddingRaw?.provider;
    if (rawProvider != null && rawProvider !== "openai" && rawProvider !== "ollama") {
      throw new Error(
        `embedding.provider must be "openai" or "ollama", got "${String(rawProvider)}"`,
      );
    }
    const provider: EmbeddingProvider = rawProvider === "ollama" ? "ollama" : "openai";
    let apiKey: string | undefined;
    if (typeof embeddingRaw?.apiKey === "string" && embeddingRaw.apiKey) {
      apiKey = resolveEnvVars(embeddingRaw.apiKey);
    } else if (provider === "openai") {
      throw new Error("embedding.apiKey is required for OpenAI provider");
    }
    const embeddingModel =
      typeof embeddingRaw?.model === "string"
        ? embeddingRaw.model
        : provider === "ollama"
          ? "mxbai-embed-large"
          : "text-embedding-3-small";
    const baseUrl = typeof embeddingRaw?.baseUrl === "string" ? embeddingRaw.baseUrl : undefined;

    // -- coreMemory --
    const coreMemoryRaw = section(cfg, "coreMemory");
    const coreMemoryEnabled = coreMemoryRaw?.enabled !== false;
    const rawPercent = coreMemoryRaw?.refreshAtContextPercent;
    // M15: Reject values > 100 (error). Values <= 0 are silently treated as disabled (undefined).
    if (typeof rawPercent === "number" && rawPercent > 100) {
      throw new Error(
        `coreMemory.refreshAtContextPercent must be between 1 and 100, got: ${rawPercent}`,
      );
    }
    const refreshAtContextPercent =
      typeof rawPercent === "number" && rawPercent > 0 && rawPercent <= 100
        ? rawPercent
        : undefined;

    // -- extraction --
    const extractionRaw = section(cfg, "extraction");
    let extraction: MemoryNeo4jConfig["extraction"];
    if (extractionRaw) {
      const exApiKey =
        typeof extractionRaw.apiKey === "string" ? resolveEnvVars(extractionRaw.apiKey) : undefined;
      const exModel = typeof extractionRaw.model === "string" ? extractionRaw.model : undefined;
      const exBaseUrl =
        typeof extractionRaw.baseUrl === "string" ? extractionRaw.baseUrl : undefined;
      const exTimeout =
        typeof extractionRaw.timeout === "number" && extractionRaw.timeout > 0
          ? extractionRaw.timeout
          : undefined;
      const exConcurrency =
        typeof extractionRaw.concurrency === "number" && extractionRaw.concurrency > 0
          ? Math.floor(extractionRaw.concurrency as number)
          : undefined;
      const exLocalNer =
        typeof extractionRaw.localNerEnabled === "boolean"
          ? extractionRaw.localNerEnabled
          : undefined;
      const exMaxTokens =
        typeof extractionRaw.maxTokens === "number" && extractionRaw.maxTokens > 0
          ? Math.floor(extractionRaw.maxTokens as number)
          : undefined;
      if (exApiKey || exModel || exBaseUrl) {
        extraction = {
          apiKey: exApiKey,
          model: exModel ?? (process.env.EXTRACTION_MODEL || "anthropic/claude-sonnet-4-6"),
          baseUrl: exBaseUrl ?? (process.env.EXTRACTION_BASE_URL || "https://openrouter.ai/api/v1"),
          timeout: exTimeout,
          concurrency: exConcurrency,
          localNerEnabled: exLocalNer,
          maxTokens: exMaxTokens,
        };
      }
    }

    // -- decayCurves --
    const decayCurvesRaw = cfg.decayCurves as Record<string, unknown> | undefined;
    const decayCurves: Record<string, { halfLifeDays: number }> = {};
    if (decayCurvesRaw && typeof decayCurvesRaw === "object") {
      const validCategories = new Set<string>(MEMORY_CATEGORIES);
      for (const [cat, val] of Object.entries(decayCurvesRaw)) {
        // M18: Validate category name against known memory categories
        if (!validCategories.has(cat)) {
          throw new Error(
            `decayCurves.${cat} is not a valid memory category. Valid categories: ${MEMORY_CATEGORIES.join(", ")}`,
          );
        }
        if (val && typeof val === "object" && "halfLifeDays" in val) {
          const hl = (val as Record<string, unknown>).halfLifeDays;
          if (typeof hl === "number" && hl > 0) decayCurves[cat] = { halfLifeDays: hl };
          else throw new Error(`decayCurves.${cat}.halfLifeDays must be a positive number`);
        }
      }
    }

    // -- graph config --
    // M25: Default reduced from 6→2, max from 20→3. Depth 4+ causes combinatorial
    // explosion on hub nodes (1.6M paths, 9M db hits at depth 4 vs 1K paths at depth 2).
    const graphSearchDepth = parsePositiveInt(cfg.graphSearchDepth, "graphSearchDepth", 2)!;
    if (graphSearchDepth > 3) {
      throw new Error(`graphSearchDepth must be <= 3, got: ${graphSearchDepth}`);
    }
    const graphSeedCap = parsePositiveInt(cfg.graphSeedCap, "graphSeedCap");
    const graphRelTypes = parseRelTypeArray(cfg.graphRelTypes, "graphRelTypes", false) as
      | string[]
      | null
      | undefined;
    const graphCausalRelTypes = parseRelTypeArray(
      cfg.graphCausalRelTypes,
      "graphCausalRelTypes",
      true,
    );

    // -- sleepCycle --
    const sleepCycleRaw = section(cfg, "sleepCycle");
    if (sleepCycleRaw?.auto !== undefined || sleepCycleRaw?.autoIntervalMs !== undefined) {
      // eslint-disable-next-line no-console
      console.warn(
        "memory-neo4j: sleepCycle.auto and sleepCycle.autoIntervalMs are deprecated and ignored. " +
          'Use sleepCycle.schedule (cron expression, e.g. "0 3 * * *") instead.',
      );
    }
    const sleepCycleSchedule: string | null =
      typeof sleepCycleRaw?.schedule === "string" && sleepCycleRaw.schedule.length > 0
        ? sleepCycleRaw.schedule
        : null;
    const sleepCycleTz =
      typeof sleepCycleRaw?.tz === "string" && sleepCycleRaw.tz.length > 0
        ? sleepCycleRaw.tz
        : "local";
    if (sleepCycleTz !== "local") {
      if (!Intl.supportedValuesOf("timeZone").includes(sleepCycleTz)) {
        throw new Error(
          `memory-neo4j config: invalid sleepCycle.tz — "${sleepCycleTz}" is not a recognized IANA timezone`,
        );
      }
    }

    // -- conflictDetection --
    const cdRaw = section(cfg, "conflictDetection");
    const cdMaxCandidates =
      typeof cdRaw?.maxCandidates === "number"
        ? Math.max(1, Math.min(50, Math.floor(cdRaw.maxCandidates)))
        : 5;
    const cdBatchSize =
      typeof cdRaw?.sleepScanBatchSize === "number"
        ? Math.max(1, Math.floor(cdRaw.sleepScanBatchSize))
        : 50;

    // -- recencyWeight --
    let recencyWeight = 0.1;
    if (typeof cfg.recencyWeight === "number") {
      if (cfg.recencyWeight < 0)
        throw new Error(`recencyWeight must be >= 0, got: ${cfg.recencyWeight}`);
      recencyWeight = cfg.recencyWeight;
    }

    // -- decomposition --
    const decompositionRaw = section(cfg, "decomposition");

    // -- autoRecallMinScore --
    let autoRecallMinScore = 0.25;
    if (typeof cfg.autoRecallMinScore === "number") {
      if (cfg.autoRecallMinScore < 0 || cfg.autoRecallMinScore > 1) {
        throw new Error(
          `autoRecallMinScore must be between 0 and 1, got: ${cfg.autoRecallMinScore}`,
        );
      }
      autoRecallMinScore = cfg.autoRecallMinScore;
    }

    // -- regex patterns (string in config -> RegExp in output) --
    const captureSkipRaw =
      typeof cfg.autoCaptureSkipPattern === "string" && cfg.autoCaptureSkipPattern
        ? cfg.autoCaptureSkipPattern
        : undefined;
    const recallSkipRaw =
      typeof cfg.autoRecallSkipPattern === "string" && cfg.autoRecallSkipPattern
        ? cfg.autoRecallSkipPattern
        : undefined;

    // -- metrics --
    const metricsRaw = section(cfg, "metrics");
    let metrics: MemoryNeo4jConfig["metrics"];
    if (metricsRaw?.enabled === true) {
      const ri = metricsRaw.logIntervalMs;
      metrics = { enabled: true, logIntervalMs: typeof ri === "number" && ri > 0 ? ri : undefined };
    }

    // -- reranker --
    const rerankerRaw = section(cfg, "reranker");
    let reranker: RerankerConfig | undefined;
    if (rerankerRaw) {
      const prov = rerankerRaw.provider;
      const rrProvider: RerankerConfig["provider"] =
        prov === "llm" ? "llm" : prov === "none" ? "none" : "local";
      const em = rerankerRaw.extractionMode;
      reranker = {
        enabled: rerankerRaw.enabled !== false,
        provider: rrProvider,
        model:
          typeof rerankerRaw.model === "string" && rerankerRaw.model
            ? rerankerRaw.model
            : undefined,
        topK:
          typeof rerankerRaw.topK === "number" && rerankerRaw.topK > 0
            ? Math.floor(rerankerRaw.topK)
            : undefined,
        topJ:
          typeof rerankerRaw.topJ === "number" && rerankerRaw.topJ > 0
            ? Math.floor(rerankerRaw.topJ)
            : undefined,
        minScore:
          typeof rerankerRaw.minScore === "number" && rerankerRaw.minScore >= 0
            ? rerankerRaw.minScore
            : undefined,
        extractionMode: em === "llm-temporal" ? "llm-temporal" : em === "auto" ? "auto" : "local",
        rrfWeight:
          typeof rerankerRaw.rrfWeight === "number" &&
          rerankerRaw.rrfWeight >= 0 &&
          rerankerRaw.rrfWeight <= 1
            ? rerankerRaw.rrfWeight
            : undefined,
      };
    }

    // -- cache --
    const cacheRaw = section(cfg, "cache") as Record<string, unknown> | undefined;
    const cache: MemoryNeo4jConfig["cache"] =
      cacheRaw?.enabled === true
        ? {
            enabled: true,
            ttlMs:
              typeof cacheRaw.ttlMs === "number" && cacheRaw.ttlMs > 0 ? cacheRaw.ttlMs : 300_000,
            maxSize:
              typeof cacheRaw.maxSize === "number" && cacheRaw.maxSize > 0
                ? Math.floor(cacheRaw.maxSize)
                : 200,
          }
        : undefined;

    // -- trustScoring --
    const trustRaw = section(cfg, "trustScoring") as Record<string, unknown> | undefined;
    const trustScoring: MemoryNeo4jConfig["trustScoring"] = {
      enabled: trustRaw?.enabled !== false,
      // H10: Validate that sourceDefaults values are numbers in [0, 1]
      sourceDefaults: (() => {
        if (!trustRaw?.sourceDefaults || typeof trustRaw.sourceDefaults !== "object")
          return undefined;
        const raw = trustRaw.sourceDefaults as Record<string, unknown>;
        const validated: Record<string, number> = {};
        for (const [key, val] of Object.entries(raw)) {
          if (typeof val === "number" && Number.isFinite(val)) {
            validated[key] = Math.min(1, Math.max(0, val));
          }
        }
        return Object.keys(validated).length > 0 ? validated : undefined;
      })(),
    };

    // -- communityDetection --
    const communityRaw = section(cfg, "communityDetection") as Record<string, unknown> | undefined;
    const communityDetection: MemoryNeo4jConfig["communityDetection"] =
      communityRaw?.enabled === true
        ? {
            enabled: true,
            // M5: Validate lower bounds — 0/negative values are nonsensical
            minCommunitySize:
              typeof communityRaw.minCommunitySize === "number"
                ? Math.max(2, Math.floor(communityRaw.minCommunitySize))
                : 3,
            maxIterations:
              typeof communityRaw.maxIterations === "number"
                ? Math.max(1, Math.floor(communityRaw.maxIterations))
                : 10,
            // H10: Clamp signalWeight to [0, 1] to prevent RRF weight distortion
            signalWeight:
              typeof communityRaw.signalWeight === "number"
                ? Math.min(1, Math.max(0, communityRaw.signalWeight))
                : 0.15,
          }
        : undefined;

    // -- episodicMemory --
    const episodicRaw = section(cfg, "episodicMemory") as Record<string, unknown> | undefined;
    const episodicMemory: MemoryNeo4jConfig["episodicMemory"] =
      episodicRaw?.enabled === true
        ? {
            enabled: true,
            captureAssistant: episodicRaw.captureAssistant === true,
            // M5: Validate lower bound — retentionDays must be at least 1
            retentionDays:
              typeof episodicRaw.retentionDays === "number"
                ? Math.max(1, Math.floor(episodicRaw.retentionDays))
                : 30,
          }
        : undefined;

    // -- instructionDetection --
    const instrRaw = section(cfg, "instructionDetection") as Record<string, unknown> | undefined;

    // -- disposition (OP-188) --
    const dispositionRaw = section(cfg, "disposition") as Record<string, unknown> | undefined;
    const parseDispositionParam = (raw: unknown, name: string): number => {
      if (raw === undefined || raw === null) return 3;
      if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > 5) {
        throw new Error(`disposition.${name} must be an integer 1–5, got: ${String(raw)}`);
      }
      return raw;
    };
    const disposition = dispositionRaw
      ? {
          skepticism: parseDispositionParam(dispositionRaw.skepticism, "skepticism"),
          literalism: parseDispositionParam(dispositionRaw.literalism, "literalism"),
          empathy: parseDispositionParam(dispositionRaw.empathy, "empathy"),
        }
      : undefined;

    return {
      neo4j: { uri: neo4jUri, username: neo4jUsername, password: neo4jPassword },
      embedding: { provider, apiKey, model: embeddingModel, baseUrl },
      extraction,
      autoCapture: cfg.autoCapture !== false,
      autoCaptureSkipPattern: compileRegex(captureSkipRaw, "autoCaptureSkipPattern"),
      autoRecall: cfg.autoRecall !== false,
      autoRecallMinScore,
      autoRecallSkipPattern: compileRegex(recallSkipRaw, "autoRecallSkipPattern"),
      coreMemory: { enabled: coreMemoryEnabled, refreshAtContextPercent },
      graphSearchDepth,
      graphSeedCap,
      graphRelTypes,
      graphCausalRelTypes,
      // C6: Wire selfEntityName config to search options (overrides USER.md runtime resolution)
      selfEntityName:
        typeof cfg.selfEntityName === "string" && cfg.selfEntityName.trim().length > 0
          ? cfg.selfEntityName.trim()
          : undefined,
      decayCurves,
      sleepCycle: { schedule: sleepCycleSchedule, tz: sleepCycleTz },
      conflictDetection: {
        enabled: cdRaw?.enabled !== false,
        model: typeof cdRaw?.model === "string" && cdRaw.model ? cdRaw.model : undefined,
        // M16: Range-validate similarityThreshold to 0-1
        similarityThreshold:
          typeof cdRaw?.similarityThreshold === "number"
            ? Math.max(0, Math.min(1, cdRaw.similarityThreshold))
            : 0.82,
        maxCandidates: cdMaxCandidates,
        sleepScanBatchSize: cdBatchSize,
      },
      recencyWeight,
      decomposition: { enabled: decompositionRaw?.enabled === true },
      metrics,
      reranker,
      cache,
      trustScoring,
      communityDetection,
      episodicMemory,
      instructionDetection: {
        enabled: instrRaw?.enabled !== false,
        llmFallback: instrRaw?.llmFallback === true,
      },
      disposition,
    };
  },
};
