/**
 * Episode CRUD operations for the episodic memory tier.
 *
 * Episodes store raw conversation segments (non-lossy) and link
 * to extracted semantic Memory nodes via EPISODE_SOURCE relationships.
 */

import neo4j, { type Session } from "neo4j-driver";
import type { EpisodeNode } from "./schema.js";
import { toJsNumber } from "./schema.js";

/**
 * Create or merge an Episode node in Neo4j.
 */
export async function mergeEpisode(session: Session, episode: EpisodeNode): Promise<string> {
  const result = await session.executeWrite((tx) =>
    tx.run(
      `MERGE (e:Episode {id: $id})
       ON CREATE SET
         e.text = $text, e.role = $role,
         e.timestamp = $timestamp, e.sessionKey = $sessionKey,
         e.agentId = $agentId
       RETURN e.id AS id`,
      {
        id: episode.id,
        text: episode.text,
        role: episode.role,
        timestamp: episode.timestamp,
        sessionKey: episode.sessionKey,
        agentId: episode.agentId,
      },
    ),
  );
  return (result.records[0]?.get("id") as string) ?? episode.id;
}

/**
 * Link a Memory node to its source Episode via EPISODE_SOURCE relationship.
 */
export async function linkMemoryToEpisode(
  session: Session,
  memoryId: string,
  episodeId: string,
): Promise<void> {
  await session.executeWrite((tx) =>
    tx.run(
      `MATCH (m:Memory {id: $memoryId}), (e:Episode {id: $episodeId})
       MERGE (m)-[:EPISODE_SOURCE]->(e)`,
      { memoryId, episodeId },
    ),
  );
}

/**
 * Query episodes by session key, agent ID, and/or time range.
 * Results are ordered by timestamp ascending (chronological).
 */
export async function queryEpisodes(
  session: Session,
  agentId: string,
  options: {
    sessionKey?: string;
    from?: string; // ISO-8601
    to?: string; // ISO-8601
    limit?: number;
  } = {},
): Promise<EpisodeNode[]> {
  const filters: string[] = ["e.agentId = $agentId"];
  const params: Record<string, unknown> = { agentId };

  if (options.sessionKey) {
    filters.push("e.sessionKey = $sessionKey");
    params.sessionKey = options.sessionKey;
  }
  if (options.from) {
    filters.push("e.timestamp >= $from");
    params.from = options.from;
  }
  if (options.to) {
    filters.push("e.timestamp <= $to");
    params.to = options.to;
  }

  const limit = options.limit ?? 100;
  params.limit = neo4j.int(limit);

  const result = await session.executeRead((tx) =>
    tx.run(
      `MATCH (e:Episode)
       WHERE ${filters.join(" AND ")}
       RETURN e.id AS id, e.text AS text, e.role AS role,
              e.timestamp AS timestamp, e.sessionKey AS sessionKey,
              e.agentId AS agentId
       ORDER BY e.timestamp ASC
       LIMIT $limit`,
      params,
    ),
  );

  return result.records.map((r) => ({
    id: r.get("id") as string,
    text: r.get("text") as string,
    role: r.get("role") as "user" | "assistant",
    timestamp: String(r.get("timestamp") ?? ""),
    sessionKey: r.get("sessionKey") as string,
    agentId: r.get("agentId") as string,
  }));
}

/**
 * Delete episodes older than the retention period.
 * Also removes EPISODE_SOURCE relationships from linked Memory nodes.
 */
export async function deleteExpiredEpisodes(
  session: Session,
  cutoffDate: string, // ISO-8601
  agentId?: string,
): Promise<number> {
  // H3: Batched deletion to prevent transaction timeout on large episode sets.
  const DELETE_BATCH_SIZE = 1000;
  const agentFilter = agentId ? "AND e.agentId = $agentId" : "";
  let totalDeleted = 0;
  for (;;) {
    const deleted = await session.executeWrite(async (tx) => {
      const result = await tx.run(
        `MATCH (e:Episode)
         WHERE e.timestamp < $cutoffDate ${agentFilter}
         WITH e LIMIT $batchSize
         DETACH DELETE e
         RETURN count(*) AS deleted`,
        { cutoffDate, ...(agentId ? { agentId } : {}), batchSize: neo4j.int(DELETE_BATCH_SIZE) },
      );
      return toJsNumber(result.records[0]?.get("deleted"));
    });
    totalDeleted += deleted;
    if (deleted < DELETE_BATCH_SIZE) break;
  }
  return totalDeleted;
}
