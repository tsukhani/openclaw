/**
 * Configuration schema for memory-neo4j plugin.
 *
 * Matches the JSON Schema in openclaw.plugin.json.
 * Provides runtime parsing with env var resolution and defaults.
 */

import type { MemoryCategory, RerankerConfig } from "./schema.js";
import { MEMORY_CATEGORIES } from "./schema.js";

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
  };
  autoCapture: boolean;
  autoCaptureAssistant: boolean;
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
   * Maximum relationship hops for graph search spreading activation.
   * Default: 2 (direct + 2-hop neighbors).
   * Setting to 3 enables deeper traversal but may slow queries.
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
  // Qwen3 embedding models (MRL: flexible dimensions)
  "qwen3-embedding:0.6b": 1024,
  "qwen3-embedding:4b": 2560,
  "qwen3-embedding": 1024, // default fallback
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
  // Qwen3 embedding
  "qwen3-embedding": 8192,
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
const ALLOWED_ENV_VAR_PATTERN = /^(NEO4J_|OPENAI_|ANTHROPIC_|OLLAMA_|MEMORY_|OPENCLAW_)/i;

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
export function resolveExtractionConfig(
  cfgExtraction?: MemoryNeo4jConfig["extraction"],
): ExtractionConfig {
  const model = cfgExtraction?.model ?? process.env.EXTRACTION_MODEL ?? "anthropic/claude-opus-4-6";

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
  const enabled = apiKey.length > 0 || cfgExtraction?.baseUrl != null;
  return {
    enabled,
    apiKey,
    model,
    baseUrl,
    temperature: 0.0,
    maxRetries: 2,
  };
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: string[], label: string) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`);
  }
}

/** Parse autoRecallMinScore: must be a number between 0 and 1, default 0.25. */
function parseAutoRecallMinScore(value: unknown): number {
  if (typeof value !== "number") return 0.25;
  if (value < 0 || value > 1) {
    throw new Error(`autoRecallMinScore must be between 0 and 1, got: ${value}`);
  }
  return value;
}

/**
 * Config schema with parse method for runtime validation & transformation.
 * JSON Schema validation is handled by openclaw.plugin.json; this handles
 * env var resolution and defaults.
 */
export const memoryNeo4jConfigSchema = {
  parse(value: unknown): MemoryNeo4jConfig {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("memory-neo4j config required");
    }
    const cfg = value as Record<string, unknown>;
    assertAllowedKeys(
      cfg,
      [
        "embedding",
        "neo4j",
        "autoCapture",
        "autoCaptureAssistant",
        "autoCaptureSkipPattern",
        "autoRecall",
        "autoRecallMinScore",
        "autoRecallSkipPattern",
        "coreMemory",
        "extraction",
        "graphSearchDepth",
        "graphSeedCap",
        "graphRelTypes",
        "decayCurves",
        "sleepCycle",
        "conflictDetection",
        "recencyWeight",
        "decomposition",
        "metrics",
        "reranker",
      ],
      "memory-neo4j config",
    );

    // Parse neo4j section
    const neo4jRaw = cfg.neo4j as Record<string, unknown> | undefined;
    if (!neo4jRaw || typeof neo4jRaw !== "object") {
      throw new Error("neo4j config section is required");
    }
    assertAllowedKeys(neo4jRaw, ["uri", "user", "username", "password"], "neo4j config");
    if (typeof neo4jRaw.uri !== "string" || !neo4jRaw.uri) {
      throw new Error("neo4j.uri is required");
    }
    const neo4jUri = resolveEnvVars(neo4jRaw.uri);
    // Validate URI scheme — must be a valid Neo4j connection protocol
    const VALID_NEO4J_SCHEMES = [
      "bolt://",
      "bolt+s://",
      "bolt+ssc://",
      "neo4j://",
      "neo4j+s://",
      "neo4j+ssc://",
    ];
    if (!VALID_NEO4J_SCHEMES.some((scheme) => neo4jUri.startsWith(scheme))) {
      throw new Error(
        `neo4j.uri must start with a valid scheme (${VALID_NEO4J_SCHEMES.join(", ")}), got: "${neo4jUri}"`,
      );
    }

    const neo4jPassword =
      typeof neo4jRaw.password === "string" ? resolveEnvVars(neo4jRaw.password) : "";
    // Support both 'user' and 'username' for neo4j config
    const neo4jUsername =
      typeof neo4jRaw.user === "string"
        ? resolveEnvVars(neo4jRaw.user)
        : typeof neo4jRaw.username === "string"
          ? resolveEnvVars(neo4jRaw.username)
          : "neo4j";

    // Parse embedding section (optional for ollama without apiKey)
    const embeddingRaw = cfg.embedding as Record<string, unknown> | undefined;
    assertAllowedKeys(
      embeddingRaw ?? {},
      ["provider", "apiKey", "model", "baseUrl"],
      "embedding config",
    );

    const provider: EmbeddingProvider = embeddingRaw?.provider === "ollama" ? "ollama" : "openai";

    // apiKey is required for openai, optional for ollama
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

    // Parse coreMemory section (optional with defaults)
    const coreMemoryRaw = cfg.coreMemory as Record<string, unknown> | undefined;
    assertAllowedKeys(
      coreMemoryRaw ?? {},
      ["enabled", "refreshAtContextPercent"],
      "coreMemory config",
    );
    const coreMemoryEnabled = coreMemoryRaw?.enabled !== false; // enabled by default
    // refreshAtContextPercent: number between 1-99 to be effective, or undefined to disable.
    // Values at 0 or below are ignored (disables refresh). Values above 100 are invalid.
    if (
      typeof coreMemoryRaw?.refreshAtContextPercent === "number" &&
      coreMemoryRaw.refreshAtContextPercent > 100
    ) {
      throw new Error(
        `coreMemory.refreshAtContextPercent must be between 1 and 100, got: ${coreMemoryRaw.refreshAtContextPercent}`,
      );
    }
    const refreshAtContextPercent =
      typeof coreMemoryRaw?.refreshAtContextPercent === "number" &&
      coreMemoryRaw.refreshAtContextPercent > 0 &&
      coreMemoryRaw.refreshAtContextPercent <= 100
        ? coreMemoryRaw.refreshAtContextPercent
        : undefined;

    // Parse extraction section (optional — falls back to env vars in resolveExtractionConfig)
    const extractionRaw = cfg.extraction as Record<string, unknown> | undefined;
    assertAllowedKeys(extractionRaw ?? {}, ["apiKey", "model", "baseUrl"], "extraction config");
    let extraction: MemoryNeo4jConfig["extraction"];
    if (extractionRaw) {
      const exApiKey =
        typeof extractionRaw.apiKey === "string" ? resolveEnvVars(extractionRaw.apiKey) : undefined;
      const exModel = typeof extractionRaw.model === "string" ? extractionRaw.model : undefined;
      const exBaseUrl =
        typeof extractionRaw.baseUrl === "string" ? extractionRaw.baseUrl : undefined;
      // Only include if at least one field was provided
      if (exApiKey || exModel || exBaseUrl) {
        extraction = {
          apiKey: exApiKey,
          model: exModel ?? (process.env.EXTRACTION_MODEL || "anthropic/claude-opus-4-6"),
          baseUrl: exBaseUrl ?? (process.env.EXTRACTION_BASE_URL || "https://openrouter.ai/api/v1"),
        };
      }
    }

    // Parse decayCurves: per-category decay curve overrides
    const decayCurvesRaw = cfg.decayCurves as Record<string, unknown> | undefined;
    const decayCurves: Record<string, { halfLifeDays: number }> = {};
    if (decayCurvesRaw && typeof decayCurvesRaw === "object") {
      for (const [cat, val] of Object.entries(decayCurvesRaw)) {
        if (val && typeof val === "object" && "halfLifeDays" in val) {
          const hl = (val as Record<string, unknown>).halfLifeDays;
          if (typeof hl === "number" && hl > 0) {
            decayCurves[cat] = { halfLifeDays: hl };
          } else {
            throw new Error(`decayCurves.${cat}.halfLifeDays must be a positive number`);
          }
        }
      }
    }

    // Parse graphSearchDepth: must be 1-3, default 2
    const rawDepth = cfg.graphSearchDepth;
    let graphSearchDepth = 2;
    if (typeof rawDepth === "number") {
      if (rawDepth < 1 || rawDepth > 3 || !Number.isInteger(rawDepth)) {
        throw new Error(`graphSearchDepth must be 1, 2, or 3, got: ${rawDepth}`);
      }
      graphSearchDepth = rawDepth;
    }

    // Parse graphSeedCap: positive integer, default undefined (function uses 5)
    const rawSeedCap = cfg.graphSeedCap;
    let graphSeedCap: number | undefined;
    if (typeof rawSeedCap === "number") {
      if (!Number.isInteger(rawSeedCap) || rawSeedCap < 1) {
        throw new Error(`graphSeedCap must be a positive integer, got: ${rawSeedCap}`);
      }
      graphSeedCap = rawSeedCap;
    }

    // Parse graphRelTypes: array of strings (relationship type names), default undefined (all types)
    const rawRelTypes = cfg.graphRelTypes;
    let graphRelTypes: string[] | null | undefined;
    if (Array.isArray(rawRelTypes)) {
      graphRelTypes = rawRelTypes.filter((t): t is string => typeof t === "string" && t.length > 0);
    } else if (rawRelTypes !== undefined && rawRelTypes !== null) {
      throw new Error("graphRelTypes must be an array of strings");
    }

    // Parse sleepCycle section (optional with defaults)
    const sleepCycleRaw = cfg.sleepCycle as Record<string, unknown> | undefined;
    assertAllowedKeys(
      sleepCycleRaw ?? {},
      ["auto", "autoIntervalMs", "schedule", "tz"],
      "sleepCycle config",
    );
    // Backward-compat: warn if deprecated auto/autoIntervalMs keys are present
    if (sleepCycleRaw?.auto !== undefined || sleepCycleRaw?.autoIntervalMs !== undefined) {
      // eslint-disable-next-line no-console
      console.warn(
        "memory-neo4j: sleepCycle.auto and sleepCycle.autoIntervalMs are deprecated and ignored. " +
          'Use sleepCycle.schedule (cron expression, e.g. "0 3 * * *") instead.',
      );
    }
    // schedule: cron expression string, or null/undefined to disable
    const rawSchedule = sleepCycleRaw?.schedule;
    const sleepCycleSchedule: string | null =
      typeof rawSchedule === "string" && rawSchedule.length > 0 ? rawSchedule : null;
    // tz: timezone string for the schedule, defaults to "local"
    const sleepCycleTz =
      typeof sleepCycleRaw?.tz === "string" && sleepCycleRaw.tz.length > 0
        ? sleepCycleRaw.tz
        : "local";

    // Parse conflictDetection section (optional with defaults)
    const cdRaw = cfg.conflictDetection as Record<string, unknown> | undefined;
    assertAllowedKeys(
      cdRaw ?? {},
      ["enabled", "model", "similarityThreshold", "maxCandidates", "sleepScanBatchSize"],
      "conflictDetection config",
    );
    const cdEnabled = cdRaw?.enabled !== false; // enabled by default
    const cdModel = typeof cdRaw?.model === "string" && cdRaw.model ? cdRaw.model : undefined;
    const cdThreshold =
      typeof cdRaw?.similarityThreshold === "number" ? cdRaw.similarityThreshold : 0.82;
    const cdMaxCandidates =
      typeof cdRaw?.maxCandidates === "number" ? Math.max(1, Math.floor(cdRaw.maxCandidates)) : 5;
    const cdBatchSize =
      typeof cdRaw?.sleepScanBatchSize === "number"
        ? Math.max(1, Math.floor(cdRaw.sleepScanBatchSize))
        : 50;

    // Parse recencyWeight: must be a number >= 0, default 0.1
    const rawRecencyWeight = cfg.recencyWeight;
    let recencyWeight = 0.1;
    if (typeof rawRecencyWeight === "number") {
      if (rawRecencyWeight < 0) {
        throw new Error(`recencyWeight must be >= 0, got: ${rawRecencyWeight}`);
      }
      recencyWeight = rawRecencyWeight;
    }

    // Parse decomposition section (optional with defaults)
    const decompositionRaw = cfg.decomposition as Record<string, unknown> | undefined;
    assertAllowedKeys(decompositionRaw ?? {}, ["enabled"], "decomposition config");
    const decompositionEnabled = decompositionRaw?.enabled === true; // disabled by default

    // Sec-3: ReDoS length guard — reject patterns > 200 chars before compilation
    const autoCaptureSkipPatternRaw =
      typeof cfg.autoCaptureSkipPattern === "string" && cfg.autoCaptureSkipPattern
        ? cfg.autoCaptureSkipPattern
        : undefined;
    if (autoCaptureSkipPatternRaw && autoCaptureSkipPatternRaw.length > 200) {
      throw new Error("memory-neo4j config: autoCaptureSkipPattern too long (max 200 chars)");
    }
    // Arc-7: Guard new RegExp() to prevent gateway crash on invalid pattern
    let autoCaptureSkipPatternCompiled: RegExp | undefined;
    try {
      autoCaptureSkipPatternCompiled = autoCaptureSkipPatternRaw
        ? new RegExp(autoCaptureSkipPatternRaw)
        : undefined;
    } catch (e) {
      throw new Error(`memory-neo4j config: invalid autoCaptureSkipPattern regex — ${String(e)}`);
    }

    const autoRecallSkipPatternRaw =
      typeof cfg.autoRecallSkipPattern === "string" && cfg.autoRecallSkipPattern
        ? cfg.autoRecallSkipPattern
        : undefined;
    if (autoRecallSkipPatternRaw && autoRecallSkipPatternRaw.length > 200) {
      throw new Error("memory-neo4j config: autoRecallSkipPattern too long (max 200 chars)");
    }
    let autoRecallSkipPatternCompiled: RegExp | undefined;
    try {
      autoRecallSkipPatternCompiled = autoRecallSkipPatternRaw
        ? new RegExp(autoRecallSkipPatternRaw)
        : undefined;
    } catch (e) {
      throw new Error(`memory-neo4j config: invalid autoRecallSkipPattern regex — ${String(e)}`);
    }

    // Parse metrics section (optional, disabled by default)
    const metricsRaw = cfg.metrics as Record<string, unknown> | undefined;
    assertAllowedKeys(metricsRaw ?? {}, ["enabled", "logIntervalMs"], "metrics config");
    let metrics: MemoryNeo4jConfig["metrics"];
    if (metricsRaw && metricsRaw.enabled === true) {
      const rawInterval = metricsRaw.logIntervalMs;
      metrics = {
        enabled: true,
        logIntervalMs: typeof rawInterval === "number" && rawInterval > 0 ? rawInterval : undefined,
      };
    }

    // Parse reranker section (optional, disabled by default)
    const rerankerRaw = cfg.reranker as Record<string, unknown> | undefined;
    assertAllowedKeys(
      rerankerRaw ?? {},
      ["enabled", "provider", "model", "topK", "topJ", "minScore", "abstentionThreshold"],
      "reranker config",
    );
    let reranker: RerankerConfig | undefined;
    if (rerankerRaw) {
      const rrEnabled = rerankerRaw.enabled !== false;
      const rrProviderRaw = rerankerRaw.provider;
      const rrProvider: RerankerConfig["provider"] =
        rrProviderRaw === "llm" ? "llm" : rrProviderRaw === "none" ? "none" : "local";
      const rrModel =
        typeof rerankerRaw.model === "string" && rerankerRaw.model ? rerankerRaw.model : undefined;
      const rrTopK =
        typeof rerankerRaw.topK === "number" && rerankerRaw.topK > 0
          ? Math.floor(rerankerRaw.topK)
          : undefined;
      const rrTopJ =
        typeof rerankerRaw.topJ === "number" && rerankerRaw.topJ > 0
          ? Math.floor(rerankerRaw.topJ)
          : undefined;
      const rrMinScore =
        typeof rerankerRaw.minScore === "number" && rerankerRaw.minScore >= 0
          ? rerankerRaw.minScore
          : undefined;
      const rrAbstentionThreshold =
        typeof rerankerRaw.abstentionThreshold === "number" && rerankerRaw.abstentionThreshold >= 0
          ? rerankerRaw.abstentionThreshold
          : undefined;
      reranker = {
        enabled: rrEnabled,
        provider: rrProvider,
        model: rrModel,
        topK: rrTopK,
        topJ: rrTopJ,
        minScore: rrMinScore,
        abstentionThreshold: rrAbstentionThreshold,
      };
    }

    return {
      neo4j: {
        uri: neo4jUri,
        username: neo4jUsername,
        password: neo4jPassword,
      },
      embedding: {
        provider,
        apiKey,
        model: embeddingModel,
        baseUrl,
      },
      extraction,
      autoCapture: cfg.autoCapture !== false,
      autoCaptureAssistant: cfg.autoCaptureAssistant === true, // off by default
      autoCaptureSkipPattern: autoCaptureSkipPatternCompiled,
      autoRecall: cfg.autoRecall !== false,
      autoRecallMinScore: parseAutoRecallMinScore(cfg.autoRecallMinScore),
      autoRecallSkipPattern: autoRecallSkipPatternCompiled,
      coreMemory: {
        enabled: coreMemoryEnabled,
        refreshAtContextPercent,
      },
      graphSearchDepth,
      graphSeedCap,
      graphRelTypes,
      decayCurves,
      sleepCycle: {
        schedule: sleepCycleSchedule,
        tz: sleepCycleTz,
      },
      conflictDetection: {
        enabled: cdEnabled,
        model: cdModel,
        similarityThreshold: cdThreshold,
        maxCandidates: cdMaxCandidates,
        sleepScanBatchSize: cdBatchSize,
      },
      recencyWeight,
      decomposition: {
        enabled: decompositionEnabled,
      },
      metrics,
      reranker,
    };
  },
};
