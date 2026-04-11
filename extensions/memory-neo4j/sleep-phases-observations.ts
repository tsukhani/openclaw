/**
 * Sleep cycle phase: Per-entity observation summary generation (OP-183).
 *
 * Runs after entity extraction and community detection, before link creation.
 * For each entity with 3+ connected memories (and stale or missing observations),
 * synthesizes a concise factual profile paragraph via LLM and stores it as an
 * Observation node with an OBSERVES relationship to the Entity.
 */

import type { Session } from "neo4j-driver";
import type { ExtractionConfig } from "./config.js";
import { callLlm } from "./llm-client.js";
import {
  getStaleEntities,
  getEntityMemoryTexts,
  upsertObservation,
} from "./neo4j-client-observation.js";
import type { Logger } from "./schema.js";

/** Maximum entities to process per sleep run to avoid LLM cost explosion. */
const MAX_ENTITIES_PER_RUN = 20;

/** Maximum memories to collect per entity for the LLM prompt. */
const MAX_MEMORIES_PER_ENTITY = 50;

export type ObservationGenerationResult = {
  entitiesProcessed: number;
  observationsCreated: number;
  observationsUpdated: number;
};

/**
 * Build the LLM prompt for observation synthesis.
 * Produces a factual, third-person profile paragraph (~100-200 words).
 */
function buildObservationPrompt(entityName: string, memoryTexts: string[]): string {
  const memoriesBlock = memoryTexts.map((t, i) => `${i + 1}. ${t}`).join("\n");
  return `You are a knowledge synthesis assistant. Given the following memories about the entity "${entityName}", write a concise factual summary in third person (100-200 words).

The summary should:
- Be written as a single paragraph
- Cover the most important facts, relationships, and attributes
- Use present tense for current facts, past tense for historical ones
- Be purely factual — no speculation or opinions
- Not include phrases like "based on the memories" or "according to"

Memories:
${memoriesBlock}

Write the summary now:`;
}

/**
 * Generate observation summaries for stale entities.
 *
 * For each stale entity:
 * 1. Collect all connected Memory texts (via EXTRACTED_FROM, limit to most recent 50)
 * 2. Call LLM to synthesize a concise observation summary (~100-200 words)
 * 3. Upsert the Observation node
 */
export async function runObservationGeneration(
  session: Session,
  agentId: string,
  config: ExtractionConfig,
  logger: Logger,
  options: {
    abortSignal?: AbortSignal;
    maxEntitiesPerRun?: number;
  } = {},
): Promise<ObservationGenerationResult> {
  const { abortSignal, maxEntitiesPerRun = MAX_ENTITIES_PER_RUN } = options;

  const result: ObservationGenerationResult = {
    entitiesProcessed: 0,
    observationsCreated: 0,
    observationsUpdated: 0,
  };

  if (!config.enabled) {
    logger.info("memory-neo4j: [sleep] observation generation skipped — extraction not enabled");
    return result;
  }

  // Find entities needing observation refresh
  const staleEntities = await getStaleEntities(session, agentId, maxEntitiesPerRun);
  if (staleEntities.length === 0) {
    logger.debug?.("memory-neo4j: [sleep] observation generation — no stale entities found");
    return result;
  }

  logger.info(
    `memory-neo4j: [sleep] observation generation — processing ${staleEntities.length} stale entities`,
  );

  for (const entityName of staleEntities) {
    if (abortSignal?.aborted) {
      break;
    }

    try {
      // Collect memory texts for this entity
      const memories = await getEntityMemoryTexts(
        session,
        agentId,
        entityName,
        MAX_MEMORIES_PER_ENTITY,
      );
      if (memories.length === 0) {
        continue;
      }

      // Check if observation already exists (for created vs updated tracking)
      const existingCheck = await session.executeRead((tx) =>
        tx.run(
          `MATCH (o:Observation {agentId: $agentId, entityName: $entityName})
           RETURN o.id AS id LIMIT 1`,
          { agentId, entityName },
        ),
      );
      const isUpdate = existingCheck.records.length > 0;

      // Build prompt and call LLM
      const memoryTexts = memories.map((m) => m.text);
      const prompt = buildObservationPrompt(entityName, memoryTexts);
      const summary = await callLlm(config, prompt, abortSignal);

      if (!summary || summary.trim().length === 0) {
        logger.warn(
          `memory-neo4j: [sleep] observation generation — empty LLM response for entity "${entityName}"`,
        );
        continue;
      }

      // Upsert the observation
      await upsertObservation(session, agentId, entityName, summary.trim(), memories.length);

      result.entitiesProcessed++;
      if (isUpdate) {
        result.observationsUpdated++;
      } else {
        result.observationsCreated++;
      }

      logger.debug?.(
        `memory-neo4j: [sleep] observation ${isUpdate ? "updated" : "created"} for "${entityName}" (${memories.length} memories)`,
      );
    } catch (err) {
      if (abortSignal?.aborted) {
        break;
      }
      logger.warn(
        `memory-neo4j: [sleep] observation generation failed for "${entityName}": ${String(err)}`,
      );
    }
  }

  logger.info(
    `memory-neo4j: [sleep] observation generation complete — ${result.entitiesProcessed} entities, ${result.observationsCreated} created, ${result.observationsUpdated} updated`,
  );

  return result;
}
