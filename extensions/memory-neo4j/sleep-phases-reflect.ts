/**
 * Sleep cycle phase: CARA-style reflection engine with opinion/belief tracking (OP-186).
 *
 * Runs after observation generation (Phase 11), before cleanup.
 * For each entity with observations AND 5+ connected memories,
 * synthesizes opinions/beliefs via LLM and tracks them as Opinion nodes
 * with confidence scores that evolve over time.
 *
 * Research basis:
 * - CARA (Cognitive Architecture for Reflective Agents) — opinion formation from evidence
 * - Bayesian confidence updating — supporting/contradicting evidence adjusts belief strength
 */

import type { Session } from "neo4j-driver";
import type { ExtractionConfig } from "./config.js";
import { callLlm } from "./llm-client.js";
import { getEntityMemoryTexts } from "./neo4j-client-observation.js";
import { upsertOpinion, getOpinionsForEntity } from "./neo4j-client-opinion.js";
import type { Logger } from "./schema.js";

/** Maximum entities to process per sleep run to avoid LLM cost explosion. */
const MAX_ENTITIES_PER_RUN = 15;

/** Maximum memories to collect per entity for the LLM prompt. */
const MAX_MEMORIES_PER_ENTITY = 30;

/** Minimum connected memories required for reflection. */
const MIN_MEMORIES_FOR_REFLECTION = 5;

/** Below this confidence, opinions are archived. */
const ARCHIVE_CONFIDENCE_THRESHOLD = 0.1;

export type ReflectionResult = {
  entitiesReflected: number;
  opinionsCreated: number;
  opinionsUpdated: number;
  opinionsArchived: number;
  /** Number of cross-entity generalized opinions created (OP-188). */
  opinionsGeneralized: number;
};

/** LLM output shape for a single opinion. */
type LlmOpinion = {
  topic: string;
  belief: string;
  confidence: number;
  supportingEvidence: string[];
  contradictingEvidence: string[];
};

/** Disposition labels for prompt injection. */
const SKEPTICISM_LABELS = [
  "very credulous",
  "credulous",
  "balanced",
  "skeptical",
  "highly skeptical",
];
const LITERALISM_LABELS = ["very figurative", "figurative", "balanced", "literal", "very literal"];
const EMPATHY_LABELS = [
  "low empathy",
  "moderate-low empathy",
  "balanced empathy",
  "empathetic",
  "highly empathetic",
];

/**
 * Build the LLM prompt for opinion/belief synthesis.
 */
function buildReflectionPrompt(
  entityName: string,
  observationSummary: string | null,
  memoryTexts: Array<{ id: string; text: string }>,
  existingOpinions: Array<{ topic: string; belief: string; confidence: number }>,
  disposition?: { skepticism: number; literalism: number; empathy: number },
): string {
  const memoriesBlock = memoryTexts.map((m, i) => `${i + 1}. [${m.id}] ${m.text}`).join("\n");

  const existingBlock =
    existingOpinions.length > 0
      ? `\nExisting opinions about "${entityName}":\n${existingOpinions
          .map((o) => `- Topic: "${o.topic}" | Belief: "${o.belief}" | Confidence: ${o.confidence}`)
          .join("\n")}\n`
      : "";

  const observationBlock = observationSummary
    ? `\nObservation summary: ${observationSummary}\n`
    : "";

  // Build disposition guidance block (OP-188)
  let dispositionBlock = "";
  if (disposition) {
    const sk = SKEPTICISM_LABELS[disposition.skepticism - 1] ?? "balanced";
    const li = LITERALISM_LABELS[disposition.literalism - 1] ?? "balanced";
    const em = EMPATHY_LABELS[disposition.empathy - 1] ?? "balanced empathy";
    dispositionBlock = `\nDisposition profile: ${sk} skepticism, ${li} interpretation, ${em}.
- Skepticism (${disposition.skepticism}/5): ${disposition.skepticism >= 4 ? "Require strong, multi-source evidence before forming beliefs. Assign lower confidence when evidence is sparse." : disposition.skepticism <= 2 ? "Accept patterns readily with fewer evidence points. Be open to forming beliefs from limited data." : "Use standard evidence thresholds."}
- Literalism (${disposition.literalism}/5): ${disposition.literalism >= 4 ? "Interpret evidence at face value. Focus on explicit statements rather than implied meanings." : disposition.literalism <= 2 ? "Read between the lines. Consider implied preferences and unstated patterns." : "Balance literal and inferred interpretations."}
- Empathy (${disposition.empathy}/5): ${disposition.empathy >= 4 ? "Give extra weight to emotional signals, personal preferences, and interpersonal dynamics." : disposition.empathy <= 2 ? "Focus on objective behavioral patterns rather than emotional indicators." : "Balance emotional and objective signals."}
`;
  }

  return `You are a reflective reasoning engine. Analyze the following memories about "${entityName}" and form opinions — beliefs, preferences, patterns, or judgments that go beyond simple facts.
${dispositionBlock}${observationBlock}${existingBlock}
Memories:
${memoriesBlock}

Instructions:
- Form opinions based on PATTERNS across multiple memories, not just restating individual facts
- An opinion is a belief or judgment: "Alice prefers remote work", "Bob tends to be cautious with new technology"
- Assign confidence 0.0-1.0 based on how strongly the evidence supports the opinion
- For each opinion, cite which memory IDs support it and which (if any) contradict it
- If existing opinions are listed, evaluate them against new evidence — confirm, revise, or note contradictions
- Do NOT restate facts as opinions (e.g., "Alice works at Acme" is a fact, not an opinion)
- Focus on preferences, tendencies, attitudes, and behavioral patterns

Respond with a JSON array only, no other text:
[{"topic": "...", "belief": "...", "confidence": 0.0-1.0, "supportingEvidence": ["memoryId1", ...], "contradictingEvidence": ["memoryId1", ...]}]`;
}

/**
 * Parse the LLM response into structured opinions.
 */
function parseReflectionResponse(response: string): LlmOpinion[] {
  // Extract JSON array from response (handle markdown code blocks)
  let jsonStr = response.trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }

  try {
    const parsed: unknown = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter(
        (item): item is LlmOpinion =>
          typeof item === "object" &&
          item !== null &&
          typeof item.topic === "string" &&
          typeof item.belief === "string" &&
          typeof item.confidence === "number" &&
          item.topic.length > 0 &&
          item.belief.length > 0,
      )
      .map((item) => ({
        topic: item.topic,
        belief: item.belief,
        confidence: Math.max(0, Math.min(1, item.confidence)),
        supportingEvidence: Array.isArray(item.supportingEvidence)
          ? item.supportingEvidence.filter((e): e is string => typeof e === "string")
          : [],
        contradictingEvidence: Array.isArray(item.contradictingEvidence)
          ? item.contradictingEvidence.filter((e): e is string => typeof e === "string")
          : [],
      }));
  } catch {
    return [];
  }
}

/**
 * Update confidence based on new evidence using Bayesian-inspired adjustment.
 *
 * - New supporting evidence: confidence += (1 - confidence) * 0.1
 * - New contradicting evidence: confidence -= confidence * 0.15
 */
export function updateConfidence(
  currentConfidence: number,
  newSupportingCount: number,
  newContradictingCount: number,
): number {
  let c = currentConfidence;
  for (let i = 0; i < newSupportingCount; i++) {
    c += (1 - c) * 0.1;
  }
  for (let i = 0; i < newContradictingCount; i++) {
    c -= c * 0.15;
  }
  return Math.max(0, Math.min(1, c));
}

/**
 * Find entities eligible for reflection: entities with observations AND 5+ connected memories.
 *
 * NOTE: Use toInteger() for LIMIT because JS numbers are IEEE 754 doubles
 * and the Neo4j driver sends them as floats (e.g. 15.0), which Neo4j rejects.
 */
async function getReflectionCandidates(
  session: Session,
  agentId: string,
  limit: number,
): Promise<Array<{ entityName: string; observationSummary: string | null }>> {
  const result = await session.executeRead((tx) =>
    tx.run(
      `MATCH (e:Entity {agentId: $agentId})-[:EXTRACTED_FROM]->(m:Memory)
       WITH e, count(m) AS memCount
       WHERE memCount >= $minMemories
       OPTIONAL MATCH (o:Observation {agentId: $agentId, entityName: e.name})-[:OBSERVES]->(e)
       RETURN e.name AS entityName, o.summary AS observationSummary
       ORDER BY memCount DESC
       LIMIT toInteger($limit)`,
      {
        agentId,
        minMemories: MIN_MEMORIES_FOR_REFLECTION,
        limit,
      },
    ),
  );
  return result.records.map((r) => ({
    entityName: r.get("entityName") as string,
    observationSummary: (r.get("observationSummary") as string) ?? null,
  }));
}

/**
 * Run the reflection phase: synthesize opinions from entity memories.
 */
export async function runReflection(
  session: Session,
  agentId: string,
  config: ExtractionConfig,
  logger: Logger,
  options: {
    abortSignal?: AbortSignal;
    maxEntitiesPerRun?: number;
  } = {},
): Promise<ReflectionResult> {
  const { abortSignal, maxEntitiesPerRun = MAX_ENTITIES_PER_RUN } = options;

  const result: ReflectionResult = {
    entitiesReflected: 0,
    opinionsCreated: 0,
    opinionsUpdated: 0,
    opinionsArchived: 0,
    opinionsGeneralized: 0,
  };

  if (!config.enabled) {
    logger.info("memory-neo4j: [sleep] reflection skipped — extraction not enabled");
    return result;
  }

  // Find entities eligible for reflection
  const candidates = await getReflectionCandidates(session, agentId, maxEntitiesPerRun);
  if (candidates.length === 0) {
    logger.debug?.("memory-neo4j: [sleep] reflection — no eligible entities found");
    return result;
  }

  logger.info(`memory-neo4j: [sleep] reflection — processing ${candidates.length} entities`);

  for (const candidate of candidates) {
    if (abortSignal?.aborted) break;

    try {
      const { entityName, observationSummary } = candidate;

      // Collect memory texts for this entity
      const memories = await getEntityMemoryTexts(
        session,
        agentId,
        entityName,
        MAX_MEMORIES_PER_ENTITY,
      );
      if (memories.length < MIN_MEMORIES_FOR_REFLECTION) continue;

      // Fetch existing opinions for this entity
      const existingOpinions = await getOpinionsForEntity(session, agentId, entityName);

      // Build prompt and call LLM
      const prompt = buildReflectionPrompt(
        entityName,
        observationSummary,
        memories,
        existingOpinions,
        config.disposition,
      );
      const response = await callLlm(config, prompt, abortSignal);

      if (!response || response.trim().length === 0) {
        logger.warn(
          `memory-neo4j: [sleep] reflection — empty LLM response for entity "${entityName}"`,
        );
        continue;
      }

      // Parse LLM response
      const newOpinions = parseReflectionResponse(response);
      if (newOpinions.length === 0) {
        logger.debug?.(
          `memory-neo4j: [sleep] reflection — no valid opinions parsed for "${entityName}"`,
        );
        continue;
      }

      // Validate memory IDs — only keep IDs that exist in our fetched memories
      const validMemoryIds = new Set(memories.map((m) => m.id));

      // Process each opinion
      const existingByTopic = new Map(existingOpinions.map((o) => [o.topic, o]));

      for (const opinion of newOpinions) {
        const supportingIds = opinion.supportingEvidence.filter((id) => validMemoryIds.has(id));
        const contradictingIds = opinion.contradictingEvidence.filter((id) =>
          validMemoryIds.has(id),
        );

        const existing = existingByTopic.get(opinion.topic);

        let finalConfidence: number;
        let isNew: boolean;

        if (existing) {
          // Existing opinion — adjust confidence based on new evidence
          const existingSupportSet = new Set(existing.supportingMemoryIds);
          const existingContradictSet = new Set(existing.contradictingMemoryIds);
          const newSupporting = supportingIds.filter((id) => !existingSupportSet.has(id)).length;
          const newContradicting = contradictingIds.filter(
            (id) => !existingContradictSet.has(id),
          ).length;

          finalConfidence = updateConfidence(existing.confidence, newSupporting, newContradicting);
          isNew = false;
        } else {
          // New opinion — use LLM-assigned confidence
          finalConfidence = opinion.confidence;
          isNew = true;
        }

        // Archive if confidence is too low
        const archived = finalConfidence < ARCHIVE_CONFIDENCE_THRESHOLD;

        await upsertOpinion(session, agentId, {
          topic: opinion.topic,
          belief: opinion.belief,
          confidence: finalConfidence,
          entityName,
          supportingMemoryIds: supportingIds,
          contradictingMemoryIds: contradictingIds,
          archived,
          dispositionSnapshot: config.disposition,
        });

        if (archived) {
          result.opinionsArchived++;
        } else if (isNew) {
          result.opinionsCreated++;
        } else {
          result.opinionsUpdated++;
        }
      }

      result.entitiesReflected++;

      logger.debug?.(
        `memory-neo4j: [sleep] reflection for "${entityName}" — ${newOpinions.length} opinions processed`,
      );
    } catch (err) {
      if (abortSignal?.aborted) break;
      logger.warn(
        `memory-neo4j: [sleep] reflection failed for "${candidate.entityName}": ${String(err)}`,
      );
    }
  }

  // ── Belief generalization: cross-entity patterns (OP-188) ──
  // After per-entity reflection, look for common themes and generalize.
  if (result.entitiesReflected >= 2 && !abortSignal?.aborted) {
    try {
      const reflectedEntities = candidates
        .slice(0, result.entitiesReflected)
        .map((c) => c.entityName);
      const generalizedCount = await runGeneralization(
        session,
        agentId,
        config,
        logger,
        reflectedEntities,
        abortSignal,
      );
      result.opinionsGeneralized = generalizedCount;
    } catch (err) {
      logger.warn(`memory-neo4j: [sleep] belief generalization failed: ${String(err)}`);
    }
  }

  logger.info(
    `memory-neo4j: [sleep] reflection complete — ${result.entitiesReflected} entities, ${result.opinionsCreated} created, ${result.opinionsUpdated} updated, ${result.opinionsArchived} archived, ${result.opinionsGeneralized} generalized`,
  );

  return result;
}

// ============================================================================
// Belief Generalization — cross-entity pattern detection (OP-188)
// ============================================================================

/** Maximum entities to include in a generalization prompt. */
const MAX_ENTITIES_FOR_GENERALIZATION = 10;

/**
 * Build the LLM prompt for cross-entity belief generalization.
 */
function buildGeneralizationPrompt(
  entityOpinions: Array<{
    entityName: string;
    opinions: Array<{ topic: string; belief: string; confidence: number }>;
  }>,
): string {
  const entitiesBlock = entityOpinions
    .map(
      (e) =>
        `Entity: "${e.entityName}"\n${e.opinions.map((o) => `  - Topic: "${o.topic}" | Belief: "${o.belief}" (confidence: ${o.confidence})`).join("\n")}`,
    )
    .join("\n\n");

  return `You are a reflective reasoning engine performing cross-entity analysis. Review opinions formed about multiple entities and identify GENERALIZED patterns — principles, tendencies, or themes that span across entities.

${entitiesBlock}

Instructions:
- Look for SHARED themes across 2+ entities (e.g., if multiple people prefer async communication, generalize: "The team generally prefers async communication")
- Only form generalizations supported by opinions from multiple entities
- Assign confidence based on how consistent the pattern is across entities
- Do NOT restate individual entity opinions — only cross-entity generalizations
- Keep generalizations actionable and specific

Respond with a JSON array only, no other text:
[{"topic": "...", "belief": "...", "confidence": 0.0-1.0, "sourceEntities": ["entity1", "entity2", ...]}]`;
}

/** LLM output shape for a generalized opinion. */
type LlmGeneralizedOpinion = {
  topic: string;
  belief: string;
  confidence: number;
  sourceEntities: string[];
};

/**
 * Parse the LLM response for generalized opinions.
 */
function parseGeneralizationResponse(response: string): LlmGeneralizedOpinion[] {
  let jsonStr = response.trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }

  try {
    const parsed: unknown = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter(
        (item): item is LlmGeneralizedOpinion =>
          typeof item === "object" &&
          item !== null &&
          typeof item.topic === "string" &&
          typeof item.belief === "string" &&
          typeof item.confidence === "number" &&
          item.topic.length > 0 &&
          item.belief.length > 0,
      )
      .map((item) => ({
        topic: item.topic,
        belief: item.belief,
        confidence: Math.max(0, Math.min(1, item.confidence)),
        sourceEntities: Array.isArray(item.sourceEntities)
          ? item.sourceEntities.filter((e): e is string => typeof e === "string")
          : [],
      }));
  } catch {
    return [];
  }
}

/**
 * Run cross-entity belief generalization after per-entity reflection.
 * Groups entity opinions and asks the LLM to identify cross-entity patterns.
 * Stores generalized opinions as topic-level (entityName="") with generalized=true.
 */
async function runGeneralization(
  session: Session,
  agentId: string,
  config: ExtractionConfig,
  logger: Logger,
  entityNames: string[],
  abortSignal?: AbortSignal,
): Promise<number> {
  // Collect opinions for all reflected entities
  const entityOpinions: Array<{
    entityName: string;
    opinions: Array<{ topic: string; belief: string; confidence: number }>;
  }> = [];

  for (const entityName of entityNames.slice(0, MAX_ENTITIES_FOR_GENERALIZATION)) {
    if (abortSignal?.aborted) return 0;
    const opinions = await getOpinionsForEntity(session, agentId, entityName);
    if (opinions.length > 0) {
      entityOpinions.push({
        entityName,
        opinions: opinions.map((o) => ({
          topic: o.topic,
          belief: o.belief,
          confidence: o.confidence,
        })),
      });
    }
  }

  // Need opinions from at least 2 entities to generalize
  if (entityOpinions.length < 2) return 0;

  const prompt = buildGeneralizationPrompt(entityOpinions);
  const response = await callLlm(config, prompt, abortSignal);

  if (!response || response.trim().length === 0) {
    logger.debug?.("memory-neo4j: [sleep] generalization — empty LLM response");
    return 0;
  }

  const generalizedOpinions = parseGeneralizationResponse(response);
  if (generalizedOpinions.length === 0) return 0;

  let created = 0;
  for (const opinion of generalizedOpinions) {
    // Only keep generalizations that reference actual reflected entities
    const validEntities = opinion.sourceEntities.filter((e) => entityNames.includes(e));
    if (validEntities.length < 2) continue;

    await upsertOpinion(session, agentId, {
      topic: opinion.topic,
      belief: opinion.belief,
      confidence: opinion.confidence,
      entityName: "", // topic-level opinion, not entity-specific
      supportingMemoryIds: [],
      contradictingMemoryIds: [],
      generalized: true,
      dispositionSnapshot: config.disposition,
    });
    created++;
  }

  if (created > 0) {
    logger.info(`memory-neo4j: [sleep] generalization — ${created} cross-entity opinions created`);
  }

  return created;
}
