/**
 * Possessive-chain query decomposition for directed graph traversal.
 *
 * Two-tier approach:
 *   1. LLM-based decomposition (primary) — handles paraphrases, implicit
 *      relationships, qualifiers, and non-possessive chain formulations.
 *   2. Rule-based parser (fallback) — zero-latency, works offline when
 *      extraction config is unavailable or LLM call fails.
 */

import type { ExtractionConfig } from "./config.js";
import { stripCodeFences } from "./extractor.js";
import { callLlm } from "./llm-client.js";
import type { Neo4jMemoryClient } from "./neo4j-client.js";
import { WELL_KNOWN_RELATIONSHIP_TYPES, sanitizeRelationshipType } from "./schema.js";

// ── Types ──────────────────────────────────────────────────────────────────

export type ChainStep = {
  /** Neo4j relationship types to traverse for this step. Empty = fallback to entity name match. */
  relTypes: string[];
  /** Qualifying adjectives for filtering (e.g. ["older"] in "older son"). */
  qualifiers: string[];
  /** Human-readable description for provenance (e.g. "wife", "son"). */
  description?: string;
};

export type PossessiveChain = {
  isChain: true;
  /** Seed entity name (resolved from "my" + selfEntityName or explicit name). */
  seedEntity: string;
  /** Intermediate traversal steps. */
  steps: ChainStep[];
  /** Final target — either an entity property key or an entity name to match. */
  target: string;
  /** When target maps to a known entity property, the normalized property key. */
  targetPropertyKey: string | null;
};

export type PossessiveChainResult = PossessiveChain | { isChain: false; reason: string };

// ── Graph schema snapshot ──────────────────────────────────────────────────

export type GraphSchemaSnapshot = {
  entities: Array<{ name: string; type: string }>;
  relationships: Array<{ source: string; relType: string; target: string }>;
};

/**
 * Fetch a lightweight schema snapshot for the agent's graph.
 * Returns entity names/types and a sample of relationships to ground
 * the LLM decomposition in actual graph data.
 */
export async function fetchGraphSchema(
  db: Neo4jMemoryClient,
  agentId: string,
): Promise<GraphSchemaSnapshot> {
  try {
    const [entities, relationships] = await Promise.all([
      db.runQuery<{ name: string; type: string }>(
        `MATCH (e:Entity)
         WHERE e.agentId = $agentId
         RETURN e.name AS name, coalesce(e.type, 'entity') AS type
         ORDER BY e.relationshipCount DESC
         LIMIT 50`,
        { agentId },
      ),
      db.runQuery<{ source: string; relType: string; target: string }>(
        `MATCH (e1:Entity {agentId: $agentId})-[r]->(e2:Entity)
         WHERE e2.agentId = $agentId
         RETURN e1.name AS source, type(r) AS relType, e2.name AS target
         ORDER BY r.confidence DESC
         LIMIT 50`,
        { agentId },
      ),
    ]);
    return { entities, relationships };
  } catch {
    return { entities: [], relationships: [] };
  }
}

// ── LLM-based decomposition (primary) ─────────────────────────────────────

const CHAIN_DECOMPOSE_SYSTEM = `You are a query decomposition system for a personal knowledge graph.

Given a natural language query about relationships between people or entities, decompose it into a graph traversal plan.

The knowledge graph stores entities (people, organizations, locations) connected by typed, directed relationships.

Available relationship types (not exhaustive — use the most specific type):
${WELL_KNOWN_RELATIONSHIP_TYPES.join(", ")}

Common entity properties stored directly on nodes:
phone, email, birthday, address, name, company, title, website

Instructions:
- "seedEntity": the starting entity name (lowercase). If the query says "my" or "mine", use the provided self entity name.
- "steps": array of traversal hops from seed to target. Each step has:
  - "relTypes": 1-3 Neo4j relationship types (UPPER_SNAKE_CASE) to traverse at this hop. Include reverse relationships when direction is ambiguous (e.g. both PARENT_OF and CHILD_OF for "son").
  - "qualifiers": optional filtering terms (e.g. ["older"], ["former"], ["primary"])
  - "description": short human label for this hop (e.g. "wife", "son", "manager")
- "targetProperty": if the query asks for a specific attribute (phone, email, birthday, etc.), set this to the property key. Otherwise null.
- If the query is not a multi-hop relationship traversal, return {"isTraversable": false}.

Return ONLY valid JSON, no explanation.`;

function buildUserPrompt(
  query: string,
  selfEntityName?: string,
  schema?: GraphSchemaSnapshot,
): string {
  let prompt = `Query: "${query}"`;
  if (selfEntityName) {
    prompt += `\nSelf entity name: "${selfEntityName}"`;
  }
  if (schema && (schema.entities.length > 0 || schema.relationships.length > 0)) {
    prompt += "\n\nGraph context (actual entities and relationships in this user's graph):";
    if (schema.entities.length > 0) {
      prompt += "\nEntities:";
      for (const e of schema.entities) {
        prompt += `\n- ${e.name} (${e.type})`;
      }
    }
    if (schema.relationships.length > 0) {
      prompt += "\nRelationships:";
      for (const r of schema.relationships) {
        prompt += `\n- ${r.source} --${r.relType}--> ${r.target}`;
      }
    }
    prompt +=
      "\n\nUse these exact entity names and relationship types in your traversal plan when they match the query.";
  }
  return prompt;
}

/**
 * LLM-based chain query decomposition.
 *
 * Asks the LLM to decompose a natural language query into a structured
 * graph traversal plan. Handles paraphrases, implicit relationships,
 * compound terms (mother-in-law), and non-possessive formulations.
 *
 * When a graph schema snapshot is provided, the LLM can ground its plan
 * in actual entity names and relationship types from the graph.
 */
export async function decomposeChainQuery(
  query: string,
  extractionConfig: ExtractionConfig,
  selfEntityName?: string,
  abortSignal?: AbortSignal,
  schema?: GraphSchemaSnapshot,
): Promise<PossessiveChainResult> {
  try {
    const messages = [
      { role: "system" as const, content: CHAIN_DECOMPOSE_SYSTEM },
      { role: "user" as const, content: buildUserPrompt(query, selfEntityName, schema) },
    ];

    const response = await callLlm(extractionConfig, messages, abortSignal);
    if (!response) {
      return { isChain: false, reason: "LLM returned empty response" };
    }

    const parsed = JSON.parse(stripCodeFences(response));
    return validateLlmResponse(parsed);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { isChain: false, reason: `LLM decomposition failed: ${msg}` };
  }
}

/**
 * Validate and normalize the LLM response into a PossessiveChain.
 */
function validateLlmResponse(parsed: Record<string, unknown>): PossessiveChainResult {
  // LLM may signal non-traversable queries
  if (parsed.isTraversable === false) {
    return { isChain: false, reason: "LLM determined query is not a traversable chain" };
  }

  const seedEntity =
    typeof parsed.seedEntity === "string" ? parsed.seedEntity.toLowerCase().trim() : "";
  if (!seedEntity) {
    return { isChain: false, reason: "missing seedEntity in LLM response" };
  }

  const rawSteps = Array.isArray(parsed.steps) ? parsed.steps : [];
  if (rawSteps.length === 0) {
    return { isChain: false, reason: "no traversal steps in LLM response" };
  }

  const steps: ChainStep[] = rawSteps
    .map((s: Record<string, unknown>) => {
      const relTypes = (Array.isArray(s.relTypes) ? s.relTypes : [])
        .map((t: unknown) => (typeof t === "string" ? sanitizeRelationshipType(t) : null))
        .filter((t: string | null): t is string => t !== null);

      const qualifiers = (Array.isArray(s.qualifiers) ? s.qualifiers : []).filter(
        (q: unknown): q is string => typeof q === "string" && q.length > 0,
      );

      const description = typeof s.description === "string" ? s.description : undefined;

      return { relTypes, qualifiers, description };
    })
    .filter((s: ChainStep) => s.relTypes.length > 0);

  if (steps.length === 0) {
    return { isChain: false, reason: "no valid relationship types in LLM response steps" };
  }

  // Target property — normalize to lowercase property key
  const targetProperty =
    typeof parsed.targetProperty === "string" ? parsed.targetProperty.toLowerCase().trim() : null;

  // Build target description from the last step or targetProperty
  const target = targetProperty ?? steps[steps.length - 1]?.description ?? "";

  return {
    isChain: true,
    seedEntity,
    steps,
    target,
    targetPropertyKey: targetProperty,
  };
}

// ── Rule-based parser (fallback) ───────────────────────────────────────────

/**
 * Maps natural language possessive terms to Neo4j relationship types.
 * Used as zero-latency fallback when LLM is unavailable.
 */
const POSSESSIVE_TO_REL_TYPES: Record<string, string[]> = {
  // Spousal
  wife: ["MARRIED_TO"],
  husband: ["MARRIED_TO"],
  spouse: ["MARRIED_TO"],
  partner: ["MARRIED_TO"],

  // Parent-child (downward)
  son: ["PARENT_OF", "CHILD_OF"],
  daughter: ["PARENT_OF", "CHILD_OF"],
  child: ["PARENT_OF", "CHILD_OF"],
  kid: ["PARENT_OF", "CHILD_OF"],
  children: ["PARENT_OF", "CHILD_OF"],

  // Parent-child (upward)
  mother: ["CHILD_OF", "PARENT_OF"],
  father: ["CHILD_OF", "PARENT_OF"],
  parent: ["CHILD_OF", "PARENT_OF"],
  mom: ["CHILD_OF", "PARENT_OF"],
  dad: ["CHILD_OF", "PARENT_OF"],

  // Extended family
  grandfather: ["GRANDCHILD_OF", "GRANDPARENT_OF"],
  grandmother: ["GRANDCHILD_OF", "GRANDPARENT_OF"],
  grandparent: ["GRANDCHILD_OF", "GRANDPARENT_OF"],
  grandson: ["GRANDPARENT_OF", "GRANDCHILD_OF"],
  granddaughter: ["GRANDPARENT_OF", "GRANDCHILD_OF"],
  grandchild: ["GRANDPARENT_OF", "GRANDCHILD_OF"],

  // Siblings
  brother: ["SIBLING_OF"],
  sister: ["SIBLING_OF"],
  sibling: ["SIBLING_OF"],

  // Work relationships
  boss: ["REPORTS_TO"],
  manager: ["REPORTS_TO", "MANAGES"],
  supervisor: ["REPORTS_TO", "MANAGES"],
  employer: ["WORKS_AT", "EMPLOYS"],
  company: ["WORKS_AT"],
  employee: ["EMPLOYS", "WORKS_AT"],
  colleague: ["COLLABORATES_WITH"],
  coworker: ["COLLABORATES_WITH"],

  // Ownership / membership
  owner: ["OWNS"],
  creator: ["CREATED"],
  founder: ["FOUNDED"],

  // Friends
  friend: ["KNOWS"],
};

const TARGET_TO_PROPERTY: Record<string, string> = {
  "phone number": "phone",
  phone: "phone",
  telephone: "phone",
  number: "phone",
  cell: "phone",
  mobile: "phone",
  email: "email",
  "email address": "email",
  mail: "email",
  birthday: "birthday",
  "birth date": "birthday",
  "date of birth": "birthday",
  dob: "birthday",
  address: "address",
  location: "address",
  name: "name",
  "full name": "name",
};

const QUESTION_PREFIX_RE =
  /^(what|who|where|when|how|which|whose|whom)\s+(is|are|was|were|does|did|do|has|have|had|will|would|can|could|should)\s+/i;
const TRAILING_QUESTION_RE = /[?]+$/;

/**
 * Rule-based possessive-chain parser. Zero-latency fallback when LLM is unavailable.
 *
 * Splits on `'s` boundaries and maps terms to relationship types via static lookup.
 * Works for explicit English possessive chains but fails on paraphrases.
 */
export function parsePossessiveChain(
  query: string,
  selfEntityName?: string,
): PossessiveChainResult {
  let q = query.trim();
  q = q.replace(QUESTION_PREFIX_RE, "").replace(TRAILING_QUESTION_RE, "").trim();

  if (selfEntityName) {
    q = q.replace(/\bmy\b/gi, `${selfEntityName}'s`);
    q = q.replace(/\bmine\b/gi, selfEntityName);
  }

  const segments = q
    .split(/'s\b/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (segments.length < 3) {
    return { isChain: false, reason: `too few possessive segments (${segments.length})` };
  }

  const seedEntity = segments[0].toLowerCase();
  if (!seedEntity) {
    return { isChain: false, reason: "empty seed entity" };
  }

  const target = segments[segments.length - 1].toLowerCase().trim();
  const middleSegments = segments.slice(1, -1);

  const steps: ChainStep[] = middleSegments.map((seg) => parseStep(seg.toLowerCase()));
  const targetPropertyKey = TARGET_TO_PROPERTY[target] ?? null;

  return {
    isChain: true,
    seedEntity,
    steps,
    target,
    targetPropertyKey,
  };
}

function parseStep(segment: string): ChainStep {
  const words = segment.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) {
    return { relTypes: [], qualifiers: [], description: "" };
  }

  const relTypes =
    POSSESSIVE_TO_REL_TYPES[segment] ?? POSSESSIVE_TO_REL_TYPES[words[words.length - 1]] ?? [];
  const term = relTypes.length > 0 ? words[words.length - 1] : segment;
  const qualifiers = relTypes.length > 0 ? words.slice(0, -1) : [];

  return { relTypes, qualifiers, description: term };
}
