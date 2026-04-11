/**
 * Sleep cycle phase: Semantic + temporal link creation between Memory nodes (OP-182).
 *
 * Creates two new edge types:
 * - SIMILAR — bidirectional links between semantically similar memories (cosine ≥ 0.82)
 * - TEMPORAL_NEXT — directed links between temporally adjacent memories within a session
 *
 * These edges enable MPFP-style meta-path traversal (OP-181).
 */

import type { Session } from "neo4j-driver";
import type { ExtractionConfig } from "./config.js";
import { callLlm } from "./llm-client.js";
import type { Logger } from "./schema.js";

export type LinkCreationResult = {
  semanticLinksCreated: number;
  temporalLinksCreated: number;
  /** Number of CAUSED_BY causal edges created (OP-188). */
  causalLinksCreated: number;
};

// ── Semantic Links ──────────────────────────────────────────────────────────

const SEMANTIC_BATCH_SIZE = 100;
const SEMANTIC_SIMILARITY_THRESHOLD = 0.82;
const SEMANTIC_MAX_NEIGHBORS = 5;

/**
 * Create SIMILAR edges between semantically similar Memory nodes.
 *
 * Finds memories with embeddings but no outgoing SIMILAR edges, then links
 * each to its top-K nearest neighbors above the similarity threshold.
 * Processes in batches to avoid overwhelming the DB.
 */
export async function createSemanticLinks(
  session: Session,
  agentId: string,
  logger: Logger,
  abortSignal?: AbortSignal,
): Promise<number> {
  let totalCreated = 0;

  // Process in batches until no more unlinked memories
  // oxlint-disable-next-line eslint/no-unmodified-loop-condition
  while (!abortSignal?.aborted) {
    // Find memories with embeddings but no SIMILAR edges yet
    // NOTE: Use toInteger() for LIMIT because JS numbers are IEEE 754 doubles
    // and the Neo4j driver sends them as floats (e.g. 100.0), which Neo4j rejects.
    const unlinked = await session.executeRead((tx) =>
      tx.run(
        `MATCH (m:Memory)
         WHERE m.agentId = $agentId
           AND m.embedding IS NOT NULL
           AND NOT EXISTS { MATCH (m)-[:SIMILAR]->() }
         RETURN m.id AS id, m.embedding AS embedding
         LIMIT toInteger($limit)`,
        { agentId, limit: SEMANTIC_BATCH_SIZE },
      ),
    );

    if (unlinked.records.length === 0) {
      break;
    }

    for (const record of unlinked.records) {
      if (abortSignal?.aborted) {
        break;
      }

      const sourceId = record.get("id") as string;
      const embedding = record.get("embedding") as number[];

      // Find top neighbors via vector index
      const neighbors = await session.executeRead((tx) =>
        tx.run(
          `CALL db.index.vector.queryNodes("memory_embedding_index", $k, $embedding)
           YIELD node, score
           WHERE node.id <> $sourceId
             AND node.agentId = $agentId
             AND score >= $threshold
           RETURN node.id AS targetId, score
           LIMIT toInteger($maxNeighbors)`,
          {
            // Query k+1 to account for self-match being filtered out
            k: SEMANTIC_MAX_NEIGHBORS + 1,
            embedding,
            sourceId,
            agentId,
            threshold: SEMANTIC_SIMILARITY_THRESHOLD,
            maxNeighbors: SEMANTIC_MAX_NEIGHBORS,
          },
        ),
      );

      // Create bidirectional SIMILAR edges
      for (const neighbor of neighbors.records) {
        const targetId = neighbor.get("targetId") as string;
        const score = neighbor.get("score") as number;

        await session.executeWrite((tx) =>
          tx.run(
            `MATCH (a:Memory {id: $sourceId}), (b:Memory {id: $targetId})
             MERGE (a)-[r:SIMILAR]->(b)
             ON CREATE SET r.weight = $score, r.createdAt = datetime()`,
            { sourceId, targetId, score },
          ),
        );
        totalCreated++;
      }
    }

    // If we got fewer than the batch size, we're done
    if (unlinked.records.length < SEMANTIC_BATCH_SIZE) {
      break;
    }
  }

  return totalCreated;
}

// ── Temporal Links ──────────────────────────────────────────────────────────

const TEMPORAL_BATCH_SIZE = 50;

/**
 * Create TEMPORAL_NEXT edges between consecutive Memory nodes within each session.
 *
 * Groups memories by sessionKey, orders by createdAt, then links each memory
 * to the next in the sequence. Weight decays for larger time gaps.
 */
export async function createTemporalLinks(
  session: Session,
  agentId: string,
  logger: Logger,
  abortSignal?: AbortSignal,
): Promise<number> {
  if (abortSignal?.aborted) {
    return 0;
  }
  let totalCreated = 0;

  // Find sessions with unlinked memories, grouped and ordered
  const sessionGroups = await session.executeRead((tx) =>
    tx.run(
      `MATCH (m:Memory)
       WHERE m.agentId = $agentId
         AND m.sessionKey IS NOT NULL
         AND NOT EXISTS { MATCH (m)-[:TEMPORAL_NEXT]->() }
       WITH m ORDER BY m.sessionKey, m.createdAt
       WITH m.sessionKey AS sessionKey, collect(m) AS memories
       WHERE size(memories) > 1
       RETURN sessionKey, [mem IN memories | {id: mem.id, createdAt: mem.createdAt}] AS memories
       LIMIT toInteger($limit)`,
      { agentId, limit: TEMPORAL_BATCH_SIZE },
    ),
  );

  for (const record of sessionGroups.records) {
    if (abortSignal?.aborted) {
      break;
    }

    const memories = record.get("memories") as Array<{ id: string; createdAt: string }>;

    // Link consecutive pairs
    for (let i = 0; i < memories.length - 1; i++) {
      const fromId = memories[i].id;
      const toId = memories[i + 1].id;

      // Weight by temporal proximity: decay based on gap between memories
      const fromTime = new Date(memories[i].createdAt).getTime();
      const toTime = new Date(memories[i + 1].createdAt).getTime();
      const gapMs = Math.max(0, toTime - fromTime);
      // Exponential decay: 1.0 for immediate neighbors, halves every 5 minutes
      const weight = Math.max(0.1, Math.exp(-gapMs / (5 * 60 * 1000)));

      await session.executeWrite((tx) =>
        tx.run(
          `MATCH (a:Memory {id: $fromId}), (b:Memory {id: $toId})
           MERGE (a)-[r:TEMPORAL_NEXT]->(b)
           ON CREATE SET r.weight = $weight, r.createdAt = datetime()`,
          { fromId, toId, weight },
        ),
      );
      totalCreated++;
    }
  }

  return totalCreated;
}

// ── Causal Links (OP-188) ─────────────────────────────────────────────────

/** Maximum memory pairs to evaluate for causal relationships per run. */
const CAUSAL_BATCH_SIZE = 20;

/** LLM output shape for a causal relationship assessment. */
type CausalAssessment = {
  fromId: string;
  toId: string;
  isCausal: boolean;
  reason: string;
  confidence: number;
};

/**
 * Create CAUSED_BY directed edges between Memory nodes that have TEMPORAL_NEXT
 * edges but no existing CAUSED_BY edges.
 *
 * Uses LLM to identify causal relationships between temporally adjacent memories.
 * Only processes pairs that already have TEMPORAL_NEXT but lack CAUSED_BY edges
 * to avoid redundant LLM calls.
 */
export async function createCausalLinks(
  session: Session,
  agentId: string,
  config: ExtractionConfig,
  logger: Logger,
  abortSignal?: AbortSignal,
): Promise<number> {
  if (!config.enabled) {
    return 0;
  }
  if (abortSignal?.aborted) {
    return 0;
  }

  let totalCreated = 0;

  // Find memory pairs with TEMPORAL_NEXT but no CAUSED_BY
  const candidates = await session.executeRead((tx) =>
    tx.run(
      `MATCH (a:Memory {agentId: $agentId})-[:TEMPORAL_NEXT]->(b:Memory {agentId: $agentId})
       WHERE NOT EXISTS { MATCH (a)-[:CAUSED_BY]->(b) }
         AND NOT EXISTS { MATCH (b)-[:CAUSED_BY]->(a) }
       RETURN a.id AS fromId, a.text AS fromText, b.id AS toId, b.text AS toText
       LIMIT toInteger($limit)`,
      { agentId, limit: CAUSAL_BATCH_SIZE },
    ),
  );

  if (candidates.records.length === 0) {
    return 0;
  }

  // Build pairs for LLM evaluation
  const pairs = candidates.records.map((r) => ({
    fromId: r.get("fromId") as string,
    fromText: r.get("fromText") as string,
    toId: r.get("toId") as string,
    toText: r.get("toText") as string,
  }));

  // Build prompt for batch causal assessment
  const pairsBlock = pairs
    .map((p, i) => `${i + 1}. [${p.fromId}] "${p.fromText}" → [${p.toId}] "${p.toText}"`)
    .join("\n");

  const prompt = `You are analyzing causal relationships between temporally adjacent memories. For each pair, determine if the first memory CAUSED or directly LED TO the second memory.

Memory pairs (earlier → later):
${pairsBlock}

Instructions:
- A causal relationship means the first event directly caused, enabled, or led to the second
- Temporal adjacency alone is NOT causation — they must have a logical causal link
- Assign confidence 0.0-1.0 based on how clearly causal the relationship is
- Be conservative — only mark as causal when the link is clear

Respond with a JSON array only, no other text:
[{"fromId": "...", "toId": "...", "isCausal": true/false, "reason": "...", "confidence": 0.0-1.0}]`;

  const response = await callLlm(config, prompt, abortSignal);
  if (!response || response.trim().length === 0) {
    return 0;
  }

  // Parse response
  let assessments: CausalAssessment[] = [];
  try {
    let jsonStr = response.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
      jsonStr = fenceMatch[1].trim();
    }

    const parsed: unknown = JSON.parse(jsonStr);
    if (Array.isArray(parsed)) {
      assessments = parsed.filter(
        (item): item is CausalAssessment =>
          typeof item === "object" &&
          item !== null &&
          typeof item.fromId === "string" &&
          typeof item.toId === "string" &&
          typeof item.isCausal === "boolean" &&
          typeof item.confidence === "number",
      );
    }
  } catch {
    logger.debug?.("memory-neo4j: [sleep] causal link assessment — failed to parse LLM response");
    return 0;
  }

  // Create CAUSED_BY edges for causal pairs
  const validPairIds = new Set(pairs.map((p) => `${p.fromId}\0${p.toId}`));

  for (const assessment of assessments) {
    if (abortSignal?.aborted) {
      break;
    }
    if (!assessment.isCausal) {
      continue;
    }
    if (assessment.confidence < 0.5) {
      continue;
    }

    // Validate that this pair was in our candidate set
    const pairKey = `${assessment.fromId}\0${assessment.toId}`;
    if (!validPairIds.has(pairKey)) {
      continue;
    }

    await session.executeWrite((tx) =>
      tx.run(
        `MATCH (a:Memory {id: $fromId}), (b:Memory {id: $toId})
         MERGE (a)-[r:CAUSED_BY]->(b)
         ON CREATE SET r.reason = $reason, r.confidence = $confidence, r.createdAt = datetime()`,
        {
          fromId: assessment.fromId,
          toId: assessment.toId,
          reason: typeof assessment.reason === "string" ? assessment.reason : "",
          confidence: Math.max(0, Math.min(1, assessment.confidence)),
        },
      ),
    );
    totalCreated++;
  }

  if (totalCreated > 0) {
    logger.info(`memory-neo4j: [sleep] causal links — ${totalCreated} CAUSED_BY edges created`);
  }

  return totalCreated;
}
