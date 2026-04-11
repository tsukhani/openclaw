/**
 * Sleep cycle Phase 9 group — entity and relationship reclassification.
 *
 * - Phase 9:  Entity reclassification (concept → specific types via LLM)
 * - Phase 9b: Relationship reclassification (RELATED_TO → specific types via LLM)
 *
 * These phases improve graph traversal quality by replacing generic types
 * with specific, semantically meaningful types determined by an LLM.
 */

import type { ExtractionConfig } from "./config.js";
import { stripCodeFences } from "./extractor.js";
import { callLlm } from "./llm-client.js";
import type { Neo4jMemoryClient } from "./neo4j-client.js";
import type { Logger } from "./schema.js";
import { sanitizeRelationshipType } from "./schema.js";
import type { SleepCycleOptions, SleepCycleResult } from "./sleep-cycle-types.js";

// H4: Safety bound to prevent infinite loops if marking entities/relationships
// as processed silently fails and the same batch keeps being returned.
const MAX_RECLASSIFICATION_ITERATIONS = 100;

// ============================================================================
// Prompts
// ============================================================================

const ENTITY_RECLASSIFICATION_SYSTEM = `You are a knowledge graph entity type classifier. Given a list of entities with their names, current type, descriptions, and sample memory contexts, assign the most specific and accurate type for each.

Return JSON:
{
  "classifications": [
    {"name": "neo4j", "newType": "software"},
    {"name": "telegram", "newType": "messaging_platform"}
  ]
}

Rules:
- Use descriptive lowercase types: person, organization, company, location, city, country, software, tool, service, platform, framework, database, device, hardware, product, website, game, book, movie, event, etc.
- Only reclassify if you are confident the new type is more specific and accurate
- If the current type is already correct, return the same type unchanged
- If you cannot determine a better type, return the current type unchanged
- ALWAYS return a classification for every entity in the input list`;

const RELATIONSHIP_RECLASSIFICATION_SYSTEM = `You are a knowledge graph relationship classifier. Given entity pairs currently connected by a generic RELATED_TO relationship, along with their types, descriptions, and memory context, determine the most specific relationship type.

Return JSON:
{
  "classifications": [
    {"source": "tarun", "target": "neo4j", "newType": "USES"},
    {"source": "aaditya", "target": "tarun", "newType": "CHILD_OF"}
  ]
}

Rules:
- Use UPPER_SNAKE_CASE relationship types
- Common types: WORKS_AT, LIVES_AT, KNOWS, MARRIED_TO, PARENT_OF, CHILD_OF, SIBLING_OF, GRANDPARENT_OF, GRANDCHILD_OF, USES, CREATED, MANAGES, PART_OF, OWNS, INTEGRATES_WITH, REPORTS_TO, LOCATED_IN, STUDIED_AT, FOUNDED, ATTENDED, MEMBER_OF, BUILT_WITH, DEPENDS_ON, EMPLOYS, HAS_PHONE, HAS_EMAIL
- Only suggest a type if the context clearly supports it
- If you cannot determine a specific type, return "RELATED_TO" (keep unchanged)
- ALWAYS return a classification for every pair in the input list`;

// ============================================================================
// Phase 9: Entity Reclassification
// ============================================================================

export async function runEntityReclassification(
  db: Neo4jMemoryClient,
  config: ExtractionConfig,
  logger: Logger,
  options: SleepCycleOptions,
  result: SleepCycleResult,
): Promise<void> {
  const {
    abortSignal,
    skipEntityReclassification = false,
    reclassificationBatchSize = 20,
    onPhaseStart,
    onProgress,
  } = options;

  if (abortSignal?.aborted) {
    return;
  }
  if (!config.enabled) {
    logger.info("memory-neo4j: [sleep] Phase 9 skipped — extraction not enabled");
    return;
  }
  if (skipEntityReclassification) {
    logger.info("memory-neo4j: [sleep] Phase 9 skipped — entity reclassification disabled");
    return;
  }

  onPhaseStart?.("entityReclassification");
  logger.info("memory-neo4j: [sleep] Phase 9: Entity Reclassification");

  try {
    let hasMore = true;
    let iterations = 0;
    // L8: Track processed entity IDs to avoid re-processing across batches
    const processedIds = new Set<string>();
    // oxlint-disable-next-line eslint/no-unmodified-loop-condition
    while (hasMore && !abortSignal?.aborted) {
      if (++iterations > MAX_RECLASSIFICATION_ITERATIONS) {
        logger.warn(
          `memory-neo4j: [sleep] Phase 9 hit safety bound (${MAX_RECLASSIFICATION_ITERATIONS} iterations) — aborting to prevent infinite loop`,
        );
        break;
      }

      // Fetch entities needing reclassification (type = 'concept', not yet processed)
      let entities = await db.listEntitiesForReclassification(reclassificationBatchSize);
      // L8: Filter out entities already processed in a previous batch
      entities = entities.filter((e) => !processedIds.has(e.id));

      if (entities.length === 0) {
        hasMore = false;
        break;
      }

      // Build user prompt with entity details and memory context
      const userPrompt = entities
        .map((e) => {
          const contextStr =
            e.memoryContexts.length > 0
              ? `\nSample memories mentioning this entity:\n${e.memoryContexts.map((m) => `  - ${JSON.stringify(m)}`).join("\n")}`
              : "";
          return `- name: ${JSON.stringify(e.name)}, currentType: ${JSON.stringify(e.type)}, description: ${JSON.stringify(e.description ?? "none")}${contextStr}`;
        })
        .join("\n\n");

      const response = await callLlm(
        config,
        [
          { role: "system", content: ENTITY_RECLASSIFICATION_SYSTEM },
          { role: "user", content: userPrompt },
        ],
        abortSignal,
      );

      if (!response) {
        logger.warn("memory-neo4j: [sleep] Phase 9 — LLM returned null response");
        for (const e of entities) {
          await db.markEntityReclassificationFailed(e.id).catch(() => {});
        }
        result.entityReclassification.failed += entities.length;
        continue;
      }

      try {
        const parsed = JSON.parse(stripCodeFences(response)) as {
          classifications?: Array<{ name: string; newType: string }>;
        };
        const classifications = parsed.classifications ?? [];

        for (const entity of entities) {
          const classification = classifications.find(
            (c) => c.name?.toLowerCase() === entity.name.toLowerCase(),
          );

          if (!classification) {
            await db.markEntityReclassificationComplete(entity.id).catch(() => {});
            result.entityReclassification.entitiesEvaluated++;
            continue;
          }

          const newType = classification.newType?.trim().toLowerCase();
          // M15: Reject excessively long type strings from LLM
          if (!newType || newType === entity.type || newType.length > 50) {
            await db.markEntityReclassificationComplete(entity.id).catch(() => {});
            result.entityReclassification.entitiesEvaluated++;
            continue;
          }

          try {
            await db.updateEntityType(entity.id, newType);
            result.entityReclassification.entitiesReclassified++;
          } catch (writeErr) {
            logger.warn(
              `memory-neo4j: [sleep] Phase 9 — failed to update entity type for "${entity.name}": ${String(writeErr)}`,
            );
            await db.markEntityReclassificationFailed(entity.id).catch(() => {});
            result.entityReclassification.failed++;
            continue;
          }
          result.entityReclassification.entitiesEvaluated++;

          onProgress?.("entityReclassification", `"${entity.name}" ${entity.type} → ${newType}`);
        }
      } catch (parseErr) {
        logger.warn(
          `memory-neo4j: [sleep] Phase 9 — failed to parse LLM response: ${String(parseErr)}`,
        );
        for (const e of entities) {
          await db.markEntityReclassificationFailed(e.id).catch(() => {});
        }
        result.entityReclassification.failed += entities.length;
      }

      // L8: Mark all entities in this batch as processed
      for (const e of entities) {
        processedIds.add(e.id);
      }
    }

    logger.info(
      `memory-neo4j: [sleep] Phase 9 complete — ${result.entityReclassification.entitiesReclassified} reclassified, ${result.entityReclassification.failed} failed`,
    );
  } catch (err) {
    logger.warn(`memory-neo4j: [sleep] Phase 9 error: ${String(err)}`);
  }
}

// ============================================================================
// Phase 9b: Relationship Reclassification
// ============================================================================

export async function runRelationshipReclassification(
  db: Neo4jMemoryClient,
  config: ExtractionConfig,
  logger: Logger,
  options: SleepCycleOptions,
  result: SleepCycleResult,
): Promise<void> {
  const {
    abortSignal,
    skipRelationshipReclassification = false,
    reclassificationBatchSize = 20,
    onPhaseStart,
    onProgress,
  } = options;

  if (abortSignal?.aborted) {
    return;
  }
  if (!config.enabled) {
    logger.info("memory-neo4j: [sleep] Phase 9b skipped — extraction not enabled");
    return;
  }
  if (skipRelationshipReclassification) {
    logger.info("memory-neo4j: [sleep] Phase 9b skipped — relationship reclassification disabled");
    return;
  }

  onPhaseStart?.("relationshipReclassification");
  logger.info("memory-neo4j: [sleep] Phase 9b: Relationship Reclassification");

  try {
    let hasMore = true;
    let iterations = 0;
    // C2: Track processed relationship pairs to avoid re-processing (matches entity pattern at line 97)
    const processedPairs = new Set<string>();
    // oxlint-disable-next-line eslint/no-unmodified-loop-condition
    while (hasMore && !abortSignal?.aborted) {
      if (++iterations > MAX_RECLASSIFICATION_ITERATIONS) {
        logger.warn(
          `memory-neo4j: [sleep] Phase 9b hit safety bound (${MAX_RECLASSIFICATION_ITERATIONS} iterations) — aborting to prevent infinite loop`,
        );
        break;
      }

      let relationships = await db.listRelatedToForReclassification(reclassificationBatchSize);
      // C2: Filter out relationships already processed in a previous iteration
      relationships = relationships.filter(
        (r) => !processedPairs.has(`${r.sourceName}::${r.targetName}`),
      );

      if (relationships.length === 0) {
        hasMore = false;
        break;
      }

      // Build user prompt with relationship details and memory context
      const userPrompt = relationships
        .map((r) => {
          const contextStr =
            r.memoryContexts.length > 0
              ? `\nMemories mentioning both entities:\n${r.memoryContexts.map((m) => `  - ${JSON.stringify(m)}`).join("\n")}`
              : "";
          return `- source: ${JSON.stringify(r.sourceName)} (${r.sourceType}${r.sourceDesc ? `, ${JSON.stringify(r.sourceDesc)}` : ""}), target: ${JSON.stringify(r.targetName)} (${r.targetType}${r.targetDesc ? `, ${JSON.stringify(r.targetDesc)}` : ""})${contextStr}`;
        })
        .join("\n\n");

      const response = await callLlm(
        config,
        [
          { role: "system", content: RELATIONSHIP_RECLASSIFICATION_SYSTEM },
          { role: "user", content: userPrompt },
        ],
        abortSignal,
      );

      if (!response) {
        logger.warn("memory-neo4j: [sleep] Phase 9b — LLM returned null response");
        for (const r of relationships) {
          await db
            .markRelationshipReclassificationSkipped(r.sourceName, r.targetName)
            .catch(() => {});
        }
        result.relationshipReclassification.failed += relationships.length;
        continue;
      }

      try {
        const parsed = JSON.parse(stripCodeFences(response)) as {
          classifications?: Array<{ source: string; target: string; newType: string }>;
        };
        const classifications = parsed.classifications ?? [];

        for (const rel of relationships) {
          const classification = classifications.find(
            (c) =>
              c.source?.toLowerCase() === rel.sourceName.toLowerCase() &&
              c.target?.toLowerCase() === rel.targetName.toLowerCase(),
          );

          if (!classification) {
            await db
              .markRelationshipReclassificationSkipped(rel.sourceName, rel.targetName)
              .catch(() => {});
            result.relationshipReclassification.relationshipsEvaluated++;
            continue;
          }

          const sanitized = sanitizeRelationshipType(classification.newType);
          if (!sanitized || sanitized === "RELATED_TO") {
            await db
              .markRelationshipReclassificationSkipped(rel.sourceName, rel.targetName)
              .catch(() => {});
            result.relationshipReclassification.relationshipsEvaluated++;
            continue;
          }

          try {
            await db.reclassifyRelationship(
              rel.sourceName,
              rel.targetName,
              "RELATED_TO",
              sanitized,
            );
            result.relationshipReclassification.relationshipsReclassified++;
          } catch (writeErr) {
            logger.warn(
              `memory-neo4j: [sleep] Phase 9b — failed to reclassify relationship "${rel.sourceName}" → "${rel.targetName}": ${String(writeErr)}`,
            );
            await db
              .markRelationshipReclassificationSkipped(rel.sourceName, rel.targetName)
              .catch(() => {});
            result.relationshipReclassification.failed++;
            continue;
          }
          result.relationshipReclassification.relationshipsEvaluated++;

          onProgress?.(
            "relationshipReclassification",
            `"${rel.sourceName}" → "${rel.targetName}": RELATED_TO → ${sanitized}`,
          );
        }
      } catch (parseErr) {
        logger.warn(
          `memory-neo4j: [sleep] Phase 9b — failed to parse LLM response: ${String(parseErr)}`,
        );
        for (const r of relationships) {
          await db
            .markRelationshipReclassificationSkipped(r.sourceName, r.targetName)
            .catch(() => {});
        }
        result.relationshipReclassification.failed += relationships.length;
      }

      // C2: Mark all relationships in this batch as processed
      for (const r of relationships) {
        processedPairs.add(`${r.sourceName}::${r.targetName}`);
      }
    }

    logger.info(
      `memory-neo4j: [sleep] Phase 9b complete — ${result.relationshipReclassification.relationshipsReclassified} reclassified, ${result.relationshipReclassification.failed} failed`,
    );
  } catch (err) {
    logger.warn(`memory-neo4j: [sleep] Phase 9b error: ${String(err)}`);
  }
}
