/**
 * Core entity extraction pipeline and shared utilities for memory-neo4j.
 *
 * Satellite modules (re-exported below for backward compat): extractor-dedup,
 * extractor-conflict, extractor-importance, extractor-capture, extractor-decompose.
 */

import { randomUUID } from "node:crypto";
import type { ExtractionConfig } from "./config.js";
import type { Embeddings } from "./embeddings.js";
import { extractLocal, mergeExtractionResults } from "./extractor-local.js";
import { callLlmStream, isTransientError } from "./llm-client.js";
import type { MetricsCollector } from "./metrics.js";
import { NO_OP_METRICS } from "./metrics.js";
import type { Neo4jMemoryClient } from "./neo4j-client.js";
import { retryWithBackoff } from "./retry.js";
import type { EntityType, ExtractionResult, Logger, MemoryCategory } from "./schema.js";
import { MEMORY_CATEGORIES, sanitizeRelationshipType } from "./schema.js";

/**
 * Strip markdown code fences from LLM output that wraps JSON in ```json ... ```.
 * Some providers (e.g. OpenRouter via Bedrock) ignore response_format: json_object
 * and return markdown-wrapped JSON, which breaks JSON.parse().
 */
export function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  // Match ```json ... ``` or ``` ... ``` (with optional language tag)
  const match = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
  return match ? match[1].trim() : trimmed;
}

// ============================================================================
// Extraction Prompt
// ============================================================================

// System instruction (no user data) — user message contains the memory text
const ENTITY_EXTRACTION_SYSTEM = `You are an entity extraction system for a personal memory store.
Extract entities and relationships from the memory text provided by the user, and classify the memory.

Return JSON:
{
  "category": "preference|fact|decision|entity|lesson|other",
  "entities": [
    {"name": "alice", "type": "person", "aliases": ["manager"], "description": "brief description", "properties": {"phone": "012-345-6789", "email": "alice@example.com"}}
  ],
  "relationships": [
    {"source": "alice", "target": "acme corp", "type": "WORKS_AT", "confidence": 0.95, "qualifier": "primary"}
  ],
  "tags": [
    {"name": "neo4j", "category": "technology"}
  ]
}

Rules:
- Normalize entity names to lowercase
- Entity types: use descriptive lowercase types (e.g. person, organization, location, event, concept, tool, software, product, service)
- Relationship types: use descriptive UPPER_SNAKE_CASE types that capture the specific relationship (e.g. WORKS_AT, LIVES_AT, KNOWS, MARRIED_TO, PARENT_OF, CHILD_OF, SIBLING_OF, PREFERS, USES, INTEGRATES_WITH, REPORTS_TO, PART_OF, OWNS, ATTENDED, CREATED, MANAGES, FOUNDED, STUDIED_AT, LOCATED_IN). Prefer specific types over generic RELATED_TO — only use RELATED_TO when no better type fits.
- Causal relationships: when the text describes causation, extract causal relationship types:
  - CAUSED_BY: direct causation ("X happened because of Y" → X -CAUSED_BY-> Y)
  - LED_TO: sequential causation ("X led to Y" → X -LED_TO-> Y)
  - RESULTED_IN: outcome ("X resulted in Y" → X -RESULTED_IN-> Y)
  - ENABLED_BY: prerequisite ("X was possible because of Y" → X -ENABLED_BY-> Y)
  - PREVENTED_BY: blocking ("X was prevented by Y" → X -PREVENTED_BY-> Y)
  - Direction: source is the cause/antecedent, target is the effect/consequence
  - For decisions with rationale: extract the decision entity, the reason, and a CAUSED_BY relationship
  - Only extract causal relationships when causation is explicitly stated or strongly implied — do not infer causation from mere co-occurrence
- Confidence: 0.0-1.0
- Qualifier (optional): describes the role or priority of the relationship when explicitly stated. Use ONLY one of: "primary", "default", "preferred", "secondary", "backup", "alternative", "former", "temporary". Omit when not applicable — most relationships have no qualifier. Only set when the text explicitly indicates priority/role (e.g. "primary bank", "backup platform", "preferred editor", "former employer").
- ALWAYS extract the SUBJECT of each statement as an entity. If the text says "Tarun's wife is Renu", BOTH "tarun" AND "renu" must be extracted as person entities. Never omit subjects just because they seem obvious or are possessive owners.
- Only extract SPECIFIC named entities: real people, companies, products, tools, places, events
- Do NOT extract generic technology terms (python, javascript, docker, linux, api, sql, html, css, json, etc.)
- Do NOT extract generic concepts (meeting, project, training, email, code, data, server, file, script, etc.)
- Do NOT extract programming abstractions (function, class, module, async, sync, process, etc.)
- Good entities: "Tarun", "Abundent Academy", "Tioman Island", "LiveKit", "Neo4j", "Fish Speech S1 Mini"
- Bad entities: "python", "ai", "automation", "email", "docker", "machine learning", "api"
- When in doubt, do NOT extract — fewer high-quality entities beat many generic ones
- When in doubt, do NOT extract — fewer high-quality entities beat many generic ones
- Keep entity descriptions brief (1 sentence max). Only describe what is EXPLICITLY stated in the memory text — do not infer, assume, or add any detail not present in the source text. If the text does not describe the entity in detail, use a minimal description or omit it entirely.
- Extract structured attributes into "properties" when present in the text (e.g. phone numbers, emails, birthdays, addresses, IC numbers, account IDs). Only include properties that are explicitly stated — do not infer or fabricate values. Omit the "properties" field if none found.
- Category: "preference" for opinions/preferences, "fact" for factual info, "decision" for choices made, "entity" for entity-focused, "lesson" for actionable lessons learned from failures ("X approach failed because Y, use Z instead"), "other" for miscellaneous
- Generate 2-5 tags per memory (never more than 10). Every memory has a topic — there are no exceptions.
- Tags describe the TOPIC or DOMAIN of the memory, not the entities themselves.
- Do NOT use entity names as tags (e.g., don't tag "tarun" if Tarun is already an entity).
- STRONGLY PREFER reusing existing tags from the vocabulary below over inventing new ones. Only create a new tag when no existing tag fits the memory's topic.
- Good tags: "travel planning", "family", "voice synthesis", "linkedin automation", "expense tracking", "cron scheduling", "api integration"
- Tag categories: "topic", "domain", "workflow", "technology", "personal", "business"
- When the text describes a change, transition, or supersession (moved, changed, switched, promoted, left, joined, etc.), extract BOTH the new relationship AND note the temporal aspect. For example, "Tarun moved to Capsquare" implies a new LIVES_IN relationship to capsquare that supersedes any previous LIVES_IN from tarun.
- Return empty entity/relationship arrays if nothing specific to extract, but NEVER return empty tags.`;

/**
 * Adapted system prompt when local extractors have already found entities.
 * Instructs the LLM to focus on relationships, tags, and category.
 */
const ENTITY_EXTRACTION_SYSTEM_WITH_CONTEXT =
  ENTITY_EXTRACTION_SYSTEM +
  `\n\nSome entities have already been pre-extracted and are listed in the user message. ` +
  `Focus on:\n1. Relationships between all entities (both pre-extracted and any you discover)\n` +
  `2. Tags and category classification\n` +
  `3. Any entities the pre-extraction missed (especially non-standard types like tools, software, events)\n` +
  `Include pre-extracted entities in your output if you agree they are correct, or correct their types if needed.`;

/** Build a "Previously extracted entities" context block for the LLM user message. */
function buildPreExtractedContext(local: ExtractionResult): string {
  if (local.entities.length === 0) {
    return "";
  }
  const entries = local.entities.map((e) => `${e.name} (${e.type})`).join(", ");
  return `Previously extracted entities (verified): ${entries}`;
}

/** Append existing tag vocabulary to a system prompt so the LLM prefers reuse. */
const MAX_TAG_VOCABULARY_SIZE = 50;
function appendTagVocabulary(systemPrompt: string, existingTags?: string[]): string {
  if (!existingTags || existingTags.length === 0) {
    return systemPrompt;
  }
  // M17: Cap vocabulary size to prevent prompt bloat
  // C3: Sanitize tag names to prevent prompt injection via malicious tags stored in DB.
  // Strip newlines/control chars and reject tags that don't match safe patterns.
  const tags = existingTags
    .slice(0, MAX_TAG_VOCABULARY_SIZE)
    .map((t) =>
      t
        .replace(/[\n\r\t]/g, " ")
        .trim()
        .slice(0, 50),
    )
    .filter((t) => t.length > 0 && /^[a-z0-9 _/&.+-]+$/i.test(t));
  if (tags.length === 0) {
    return systemPrompt;
  }
  return `${systemPrompt}\n\nExisting tag vocabulary (prefer these over creating new tags):\n${tags.join(", ")}`;
}

// ============================================================================
// Retroactive Tagging Prompt
// ============================================================================

/**
 * Lightweight prompt for retroactive tagging of memories that were extracted
 * without tags. Only asks for tags — no entities or relationships.
 */
const RETROACTIVE_TAGGING_SYSTEM = `You are a topic tagging system for a personal memory store.
Generate 2-5 topic tags that describe what this memory is about.

Return JSON:
{
  "tags": [
    {"name": "tag name", "category": "topic|domain|workflow|technology|personal|business"}
  ]
}

Rules:
- Tags describe the TOPIC or DOMAIN of the memory, not specific people or tools mentioned.
- STRONGLY PREFER reusing existing tags from the vocabulary below over inventing new ones. Only create a new tag when no existing tag fits.
- Good tags: "travel planning", "family", "voice synthesis", "linkedin automation", "expense tracking", "cron scheduling", "api integration", "system configuration", "memory management"
- Bad tags: names of people, companies, or specific tools (those are entities, not topics)
- Tag categories: "topic" (general subject), "domain" (field/area), "workflow" (process/procedure), "technology" (tech area), "personal" (personal life), "business" (work/business)
- ALWAYS return at least 2 tags, never more than 5. Every memory has a topic.
- Normalize tag names to lowercase with spaces (no hyphens or underscores).`;

// ============================================================================
// Input Sanitization
// ============================================================================

/**
 * Sanitize memory text before passing to the extraction LLM.
 *
 * Strips sequences that look like role injection attempts — lines beginning
 * with "System:", "Assistant:", "User:", "SYSTEM:", "HUMAN:", "AI:", etc.
 * These could hijack the extraction prompt and force arbitrary output
 * (e.g. `category: "core"` to evade decay). Truncates at MAX_EXTRACTION_TEXT_CHARS
 * to prevent prompt flooding.
 *
 * Exported for testing.
 */
export const MAX_EXTRACTION_TEXT_CHARS = 4000;

// Role-marker prefixes that could be used to inject fake turns into the prompt
const ROLE_INJECTION_PATTERN = /^(system|assistant|user|human|ai)\s*:/i;

export function sanitizeMemoryText(text: string): string {
  if (!text || typeof text !== "string") {
    return "";
  }
  const truncated =
    text.length > MAX_EXTRACTION_TEXT_CHARS ? text.slice(0, MAX_EXTRACTION_TEXT_CHARS) : text;
  return truncated
    .split("\n")
    .filter((line) => !ROLE_INJECTION_PATTERN.test(line.trimStart()))
    .join("\n")
    .trim();
}

// ============================================================================
// Entity Extraction
// ============================================================================

/**
 * Max retries for transient extraction failures before marking permanently failed.
 *
 * Retry budget accounting — two layers of retry:
 *   Layer 1: callLlm/callLlmStream internal retries (config.maxRetries, default 2 = 3 attempts)
 *   Layer 2: Sleep cycle retries (MAX_EXTRACTION_RETRIES = 3 sleep cycles)
 *   Total worst-case: 3 × 3 = 9 LLM attempts per memory
 */
const MAX_EXTRACTION_RETRIES = 3;
const MAX_TAGS_PER_MEMORY = 10;

/**
 * Extract entities and relationships from a memory text using LLM.
 *
 * Uses streaming for responsive abort signal handling and better latency.
 *
 * Returns { result, transientFailure }:
 * - result is the ExtractionResult or null if extraction returned nothing useful
 * - transientFailure is true if the failure was due to a network/timeout issue
 *   (caller should retry later) vs a permanent failure (bad JSON, etc.)
 */
export async function extractEntities(
  text: string,
  config: ExtractionConfig,
  abortSignal?: AbortSignal,
  existingTags?: string[],
  logger?: Logger,
): Promise<{ result: ExtractionResult | null; transientFailure: boolean }> {
  if (!config.enabled) {
    return { result: null, transientFailure: false };
  }

  // Sanitize before sending — strips role-injection markers and caps length
  // to prevent adversarial memory text from hijacking the extraction output
  // (e.g. forcing category:"core" to evade decay). See Sec-5.
  const sanitized = sanitizeMemoryText(text);

  // Stage 0+1: local extraction (regex + NER) — fast, free
  const localNerEnabled = config.localNerEnabled;
  const localResult = await extractLocal(sanitized, localNerEnabled, logger);
  const hasLocalEntities = localResult.entities.length > 0;

  // Stage 2: LLM extraction — adapt prompt when local entities exist
  const systemPrompt = hasLocalEntities
    ? appendTagVocabulary(ENTITY_EXTRACTION_SYSTEM_WITH_CONTEXT, existingTags)
    : appendTagVocabulary(ENTITY_EXTRACTION_SYSTEM, existingTags);

  const userContent = hasLocalEntities
    ? buildPreExtractedContext(localResult) + "\n\nMemory text:\n" + sanitized
    : sanitized;

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent },
  ];

  let content: string | null;
  try {
    content = await callLlmStream(config, messages, abortSignal);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      // Return local results even if LLM was aborted
      return {
        result: hasLocalEntities ? localResult : null,
        transientFailure: false,
      };
    }
    // On transient LLM failure, still return local results if available
    if (hasLocalEntities && isTransientError(err)) {
      return { result: localResult, transientFailure: true };
    }
    if (!isTransientError(err)) {
      logger?.warn?.(
        `memory-neo4j: LLM extraction error (non-transient): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return { result: null, transientFailure: isTransientError(err) };
  }

  if (!content || !content.trim()) {
    // LLM returned empty/whitespace — treat as transient failure so sleep cycle retries
    return { result: hasLocalEntities ? localResult : null, transientFailure: true };
  }

  try {
    const parsed = JSON.parse(stripCodeFences(content)) as Record<string, unknown>;
    const llmResult = validateExtractionResult(parsed, sanitized);
    // Merge local + LLM results
    const merged = mergeExtractionResults(hasLocalEntities ? localResult : null, llmResult);
    // Filter generic entities from local extraction that bypassed the LLM blocklist
    if (merged) {
      merged.entities = merged.entities.filter((e) => !GENERIC_ENTITY_BLOCKLIST.has(e.name));
    }
    return { result: merged, transientFailure: false };
  } catch {
    // JSON parse failure — still return local results if available
    return { result: hasLocalEntities ? localResult : null, transientFailure: false };
  }
}

/**
 * Extract only tags from a memory text using a lightweight LLM prompt.
 * Used for retroactive tagging of memories that were extracted without tags.
 *
 * Returns an array of tags, or null on failure.
 */
export async function extractTagsOnly(
  text: string,
  config: ExtractionConfig,
  abortSignal?: AbortSignal,
  existingTags?: string[],
): Promise<Array<{ name: string; category: string }> | null> {
  if (!config.enabled) {
    return null;
  }

  const messages = [
    { role: "system", content: appendTagVocabulary(RETROACTIVE_TAGGING_SYSTEM, existingTags) },
    { role: "user", content: sanitizeMemoryText(text) },
  ];

  let content: string | null;
  try {
    content = await callLlmStream(config, messages, abortSignal);
  } catch (err) {
    // M10: Propagate AbortError for proper cancellation
    if (err instanceof Error && err.name === "AbortError") {
      throw err;
    }
    return null;
  }

  if (!content) {
    return null;
  }

  try {
    const parsed = JSON.parse(stripCodeFences(content)) as { tags?: unknown };
    const rawTags = Array.isArray(parsed.tags) ? parsed.tags : [];
    return rawTags
      .filter(
        (t: unknown): t is Record<string, unknown> =>
          t !== null &&
          typeof t === "object" &&
          typeof (t as Record<string, unknown>).name === "string",
      )
      .map((t) => ({
        name: normalizeTagName(String(t.name)),
        category: typeof t.category === "string" ? t.category : "topic",
      }))
      .filter((t) => t.name.length > 0)
      .slice(0, MAX_TAGS_PER_MEMORY);
  } catch {
    return null;
  }
}

/**
 * Normalize a tag name: lowercase, collapse hyphens/underscores to spaces,
 * collapse multiple spaces, trim. Ensures "machine-learning", "machine_learning",
 * and "machine learning" all resolve to the same tag node.
 */
function normalizeTagName(name: string): string {
  return name.trim().toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Generic terms that should never be extracted as entities.
 * Post-filter is more reliable than prompt engineering alone.
 */
// prettier-ignore
const GENERIC_ENTITY_BLOCKLIST = new Set([
  // Programming languages & frameworks
  "python", "javascript", "typescript", "java", "go", "rust", "ruby", "php",
  "c", "c++", "c#", "swift", "kotlin", "bash", "shell", "html", "css", "sql",
  "nosql", "json", "xml", "yaml", "react", "vue", "angular", "svelte",
  "next.js", "express", "fastapi", "django", "flask",
  // Generic tech concepts
  "ai", "artificial intelligence", "machine learning", "deep learning",
  "neural network", "automation", "api", "rest api", "graphql", "webhook",
  "websocket", "database", "server", "client", "cloud", "microservice",
  "monolith", "frontend", "backend", "fullstack", "devops", "ci/cd", "deployment",
  // Generic tools/infra
  "docker", "kubernetes", "linux", "windows", "macos", "nginx", "apache",
  "git", "npm", "pnpm", "yarn", "pip", "node", "nodejs", "node.js",
  // Generic work concepts
  "meeting", "project", "training", "email", "calendar", "task", "ticket",
  "code", "data", "file", "folder", "directory", "script", "module", "debug",
  "deploy", "build", "release", "update", "upgrade", "user", "admin", "system",
  "service", "process", "job", "worker",
  // Programming abstractions
  "function", "class", "method", "variable", "object", "array", "string",
  "async", "sync", "promise", "callback", "event", "hook", "middleware",
  "component", "plugin", "extension", "library", "package", "dependency",
  // Generic descriptors
  "app", "application", "web", "mobile", "desktop", "browser", "config",
  "configuration", "settings", "environment", "production", "staging",
  "error", "bug", "issue", "fix", "patch", "feature", "improvement",
]);

/**
 * Infrastructure/location terms high-risk for LLM hallucination in entity descriptions.
 * If the description contains any of these but the source text does not, the description
 * is stripped as ungrounded.
 */
// M11: Set for O(1) lookup instead of Array.includes() O(n)
// prettier-ignore
const HALLUCINATION_BLOCKLIST = new Set([
  "aws", "azure", "gcp", "google cloud", "digitalocean", "cloudflare", "heroku",
  "vercel", "alibaba cloud", "ap-southeast", "ap-northeast", "us-east", "us-west",
  "eu-west", "amazonaws",
]);

/**
 * Check an entity description against the source memory text to strip
 * hallucinated infrastructure/location claims not present in the source.
 */
export function groundEntityDescription(
  description: string | undefined,
  sourceText: string,
  logger?: { warn: (msg: string) => void },
  entityName?: string,
): string | undefined {
  if (!description) {
    return undefined;
  }

  const descLower = description.toLowerCase();
  const sourceLower = sourceText.toLowerCase();

  for (const term of HALLUCINATION_BLOCKLIST.values()) {
    if (descLower.includes(term) && !sourceLower.includes(term)) {
      logger?.warn(
        `[extractor] grounding check: stripped hallucinated description for entity "${entityName ?? "unknown"}": "${description}"`,
      );
      return undefined;
    }
  }

  return description;
}

/**
 * Validate and sanitize LLM extraction output.
 */
function validateExtractionResult(
  raw: Record<string, unknown>,
  sourceText: string,
  logger?: { warn: (msg: string) => void },
): ExtractionResult {
  const entities = Array.isArray(raw.entities) ? raw.entities : [];
  const relationships = Array.isArray(raw.relationships) ? raw.relationships : [];
  const tags = Array.isArray(raw.tags) ? raw.tags : [];

  const validCategories = new Set<string>(MEMORY_CATEGORIES);
  const rawCategory = typeof raw.category === "string" ? raw.category : undefined;
  const category =
    rawCategory && validCategories.has(rawCategory) ? (rawCategory as MemoryCategory) : undefined;

  return {
    category,
    entities: entities
      .filter(
        (e: unknown): e is Record<string, unknown> =>
          e !== null &&
          typeof e === "object" &&
          typeof (e as Record<string, unknown>).name === "string" &&
          typeof (e as Record<string, unknown>).type === "string",
      )
      .map((e) => ({
        name: String(e.name).trim().toLowerCase(),
        // Accept any entity type string — entity-type agnostic.
        // Normalize to lowercase for consistency.
        type: String(e.type).trim().toLowerCase() as EntityType,
        aliases: Array.isArray(e.aliases)
          ? (e.aliases as unknown[])
              .filter((a): a is string => typeof a === "string")
              .map((a) => a.trim().toLowerCase())
          : undefined,
        description: groundEntityDescription(
          typeof e.description === "string" ? e.description : undefined,
          sourceText,
          logger,
          String(e.name).trim().toLowerCase(),
        ),
        properties: (() => {
          const raw = e.properties;
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
            return undefined;
          }
          const props: Record<string, string> = {};
          for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
            if (typeof k === "string" && typeof v === "string" && v.trim().length > 0) {
              props[k.trim().toLowerCase()] = v.trim();
            }
          }
          return Object.keys(props).length > 0 ? props : undefined;
        })(),
      }))
      .filter((e) => e.name.length > 0 && !GENERIC_ENTITY_BLOCKLIST.has(e.name)),

    relationships: relationships
      .filter(
        (r: unknown): r is Record<string, unknown> =>
          r !== null &&
          typeof r === "object" &&
          typeof (r as Record<string, unknown>).source === "string" &&
          typeof (r as Record<string, unknown>).target === "string" &&
          typeof (r as Record<string, unknown>).type === "string" &&
          sanitizeRelationshipType(String((r as Record<string, unknown>).type)) !== null,
      )
      .map((r) => ({
        source: String(r.source).trim().toLowerCase(),
        target: String(r.target).trim().toLowerCase(),
        // Sanitize to UPPER_SNAKE_CASE for safe Cypher interpolation
        type: sanitizeRelationshipType(String(r.type))!,
        confidence: typeof r.confidence === "number" ? Math.min(1, Math.max(0, r.confidence)) : 0.7,
        qualifier: (() => {
          const q =
            typeof r.qualifier === "string" ? String(r.qualifier).trim().toLowerCase() : undefined;
          const ALLOWED_QUALIFIERS = new Set([
            "primary",
            "default",
            "preferred",
            "secondary",
            "backup",
            "alternative",
            "former",
            "temporary",
            // Family ordinal qualifiers — needed for possessive-chain graph traversal
            // to distinguish "older son" from "younger son", etc.
            "older",
            "younger",
            "eldest",
            "youngest",
            "first",
            "second",
            "third",
          ]);
          return q && ALLOWED_QUALIFIERS.has(q) ? q : undefined;
        })(),
      }))
      // Filter out relationships referencing blocklisted entities to prevent dangling refs
      .filter(
        (r) => !GENERIC_ENTITY_BLOCKLIST.has(r.source) && !GENERIC_ENTITY_BLOCKLIST.has(r.target),
      )
      // H5: Filter out relationships whose source/target don't exist in the extracted entities.
      // Set is computed once via IIFE (was previously rebuilt per relationship — O(N×E)).
      .filter(
        (
          (names) => (r: { source: string; target: string }) =>
            names.has(r.source) && names.has(r.target)
        )(
          new Set(
            entities
              .filter(
                (e: unknown): e is Record<string, unknown> => e !== null && typeof e === "object",
              )
              .map((e) =>
                String(e.name ?? "")
                  .trim()
                  .toLowerCase(),
              )
              .filter((n) => n.length > 0 && !GENERIC_ENTITY_BLOCKLIST.has(n)),
          ),
        ),
      ),

    // Cap at 10 tags per memory to prevent hub-node distortion in graph search
    tags: tags
      .filter(
        (t: unknown): t is Record<string, unknown> =>
          t !== null &&
          typeof t === "object" &&
          typeof (t as Record<string, unknown>).name === "string",
      )
      .map((t) => ({
        name: normalizeTagName(String(t.name)),
        category: typeof t.category === "string" ? t.category : "topic",
      }))
      .filter((t) => t.name.length > 0)
      .slice(0, MAX_TAGS_PER_MEMORY),
  };
}

// ============================================================================
// Retry Helper
// ============================================================================

/**
 * Retry a function on transient LLM failures (network errors, HTTP 429/502/503).
 *
 * - Non-transient errors (400, 401, content policy) are re-thrown immediately.
 * - Throws the last transient error when all attempts are exhausted.
 * - Delays follow exponential backoff with jitter: baseDelayMs × 3^attempt × (0.5–1.0)
 *   (e.g. ~500ms → ~1500ms → ~4500ms for 3 attempts).
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts: number,
  baseDelayMs: number,
  abortSignal?: AbortSignal,
): Promise<T | null> {
  return retryWithBackoff(fn, {
    maxAttempts,
    baseDelayMs,
    backoffExponent: 3,
    isRetryable: isTransientError,
    abortSignal,
  });
}

// ============================================================================
// Background Extraction Pipeline
// ============================================================================

/**
 * Run entity extraction in the background for a stored memory.
 * Fire-and-forget: errors are logged but never propagated.
 *
 * Flow:
 * 1. Call LLM to extract entities and relationships
 * 2. MERGE Entity nodes (idempotent, with agentId from source Memory)
 * 3. Create inter-Entity relationships (WORKS_AT, KNOWS, etc.)
 * 4. Tag the memory
 * 5. Update extractionStatus to "complete", "pending" (transient retry), or "failed"
 *
 * Transient failures (network/timeout) leave status as "pending" with an incremented
 * retry counter. After MAX_EXTRACTION_RETRIES transient failures, the memory is
 * permanently marked "failed". Permanent failures (malformed JSON) are immediately "failed".
 */
export async function runBackgroundExtraction(
  memoryId: string,
  text: string,
  db: Neo4jMemoryClient,
  embeddings: Embeddings,
  config: ExtractionConfig,
  logger: Logger,
  currentRetries: number = 0,
  abortSignal?: AbortSignal,
  metrics: MetricsCollector = NO_OP_METRICS,
  existingTags?: string[],
): Promise<{ success: boolean; memoryId: string }> {
  if (!config.enabled) {
    await db.updateExtractionStatus(memoryId, "skipped").catch((err) => {
      logger?.debug?.(
        `memory-neo4j: updateExtractionStatus failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    metrics.increment("extraction.skipped");
    return { success: true, memoryId };
  }

  const t0Extract = performance.now();
  try {
    const { result, transientFailure } = await extractEntities(
      text,
      config,
      abortSignal,
      existingTags,
    );

    if (!result) {
      // M21-ext: if the abort signal fired, don't update status — leave as
      // pending for the next cycle (consistent with the catch-block AbortError
      // handling below). extractEntities swallows AbortError and returns
      // { result: null, transientFailure: false } which would otherwise hit
      // the permanent-failure path and poison the memory.
      if (abortSignal?.aborted) {
        return { success: false, memoryId };
      }

      if (transientFailure) {
        // Transient failure (network/timeout) — leave as pending for retry
        const retries = currentRetries + 1;
        if (retries >= MAX_EXTRACTION_RETRIES) {
          logger.warn(
            `memory-neo4j: extraction permanently failed for ${memoryId.slice(0, 8)} after ${retries} transient retries`,
          );
          await db.updateExtractionStatus(memoryId, "failed", { incrementRetries: true });
          metrics.increment("extraction.failed");
        } else {
          logger.info(
            `memory-neo4j: extraction transient failure for ${memoryId.slice(0, 8)}, will retry (${retries}/${MAX_EXTRACTION_RETRIES})`,
          );
          // Keep status as "pending" but increment retry counter
          await db.updateExtractionStatus(memoryId, "pending", { incrementRetries: true });
        }
      } else {
        // Permanent failure (JSON parse, empty response, etc.)
        logger.warn(
          `memory-neo4j: extraction permanently failed for ${memoryId.slice(0, 8)} (non-transient: empty response or JSON parse error)`,
        );
        await db.updateExtractionStatus(memoryId, "failed");
        metrics.increment("extraction.failed");
      }
      return { success: false, memoryId };
    }

    // Empty extraction is valid — not all memories have extractable entities
    if (
      result.entities.length === 0 &&
      result.relationships.length === 0 &&
      result.tags.length === 0
    ) {
      await db.updateExtractionStatus(memoryId, "complete");
      return { success: true, memoryId };
    }

    // Batch all entity operations into a single transaction:
    // entity merges, relationships, tags, category, and extraction status
    await db.batchEntityOperations(
      memoryId,
      result.entities.map((e) => ({
        id: randomUUID(),
        name: e.name,
        type: e.type,
        aliases: e.aliases,
        description: e.description,
        properties: e.properties,
      })),
      result.relationships,
      result.tags,
      result.category,
    );

    metrics.histogram("extraction.latency_ms", performance.now() - t0Extract);
    metrics.increment("extraction.success");
    logger.info(
      `memory-neo4j: extraction complete for ${memoryId.slice(0, 8)} — ` +
        `${result.entities.length} entities, ${result.relationships.length} rels, ${result.tags.length} tags` +
        (result.category ? `, category=${result.category}` : "") +
        (result.relationships.some((r) => r.qualifier)
          ? `, qualifiers=[${result.relationships
              .filter((r) => r.qualifier)
              .map((r) => `${r.source}->${r.target}:${r.qualifier}`)
              .join(", ")}]`
          : ""),
    );

    return { success: true, memoryId };
  } catch (err) {
    // M21: AbortError = deliberate cancellation — don't update status, just return
    if (err instanceof Error && err.name === "AbortError") {
      return { success: false, memoryId };
    }
    // Unexpected error during graph operations — treat as transient if retry budget remains
    const isTransient = isTransientError(err);
    if (isTransient && currentRetries + 1 < MAX_EXTRACTION_RETRIES) {
      logger.warn(
        `memory-neo4j: extraction transient error for ${memoryId.slice(0, 8)}, will retry: ${String(err)}`,
      );
      await db
        .updateExtractionStatus(memoryId, "pending", { incrementRetries: true })
        .catch((e) => {
          logger?.debug?.(
            `memory-neo4j: updateExtractionStatus failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        });
    } else {
      logger.warn(`memory-neo4j: extraction failed for ${memoryId.slice(0, 8)}: ${String(err)}`);
      await db.updateExtractionStatus(memoryId, "failed", { incrementRetries: true }).catch((e) => {
        logger?.debug?.(
          `memory-neo4j: updateExtractionStatus failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      });
      metrics.increment("extraction.failed");
    }
    return { success: false, memoryId };
  }
}

// ============================================================================
// Re-exports for backward compatibility (consumers import from extractor.js)
// ============================================================================

export {
  isContradiction,
  isSemanticDuplicate,
  SEMANTIC_DEDUP_VECTOR_THRESHOLD,
} from "./extractor-dedup.js";
export { resolveConflict } from "./extractor-conflict.js";
export { rateImportance, classifyTemporalStaleness } from "./extractor-importance.js";
export { shouldCapture, NOISE_PATTERNS } from "./extractor-capture.js";
export { decomposeIntoAtomicFacts } from "./extractor-decompose.js";
