/**
 * Sleep cycle phase: Community detection via label propagation.
 *
 * Runs after entity extraction (Phase 2), before decay (Phase 3).
 * Clusters strongly-connected entities into communities, generates
 * LLM summaries, and stores results as Community nodes.
 */

import { createHash, randomUUID } from "node:crypto";
import type { Session } from "neo4j-driver";
import type { MemoryNeo4jConfig } from "./config.js";
import {
  runLabelPropagation,
  mergeCommunity,
  cleanStaleCommunityLinks,
} from "./neo4j-client-community.js";
import type { CommunityNode, Logger } from "./schema.js";

/** Sub-config type extracted from MemoryNeo4jConfig for community detection. */
type CommunityDetectionConfig = NonNullable<MemoryNeo4jConfig["communityDetection"]>;

export type CommunityDetectionResult = {
  communitiesFound: number;
  entitiesGrouped: number;
  communitiesRemoved: number;
};

/**
 * Run community detection on the entity graph for an agent.
 *
 * 1. Run label propagation to find clusters
 * 2. Create/update Community nodes with member links
 * 3. Clean stale communities that no longer have members
 */
export async function runCommunityDetection(
  session: Session,
  agentId: string,
  cfg: MemoryNeo4jConfig | CommunityDetectionConfig,
  logger: Logger,
  abortSignal?: AbortSignal,
): Promise<CommunityDetectionResult> {
  // Accept either a full MemoryNeo4jConfig or a CommunityDetectionConfig sub-object
  const communityConfig: CommunityDetectionConfig | undefined =
    "communityDetection" in cfg
      ? (cfg as MemoryNeo4jConfig).communityDetection
      : (cfg as CommunityDetectionConfig);
  if (!communityConfig?.enabled) {
    return { communitiesFound: 0, entitiesGrouped: 0, communitiesRemoved: 0 };
  }

  // Step 1: Run label propagation
  const clusters = await runLabelPropagation(session, agentId, {
    maxIterations: communityConfig.maxIterations,
    minCommunitySize: communityConfig.minCommunitySize,
  });

  if (clusters.length === 0) {
    logger.debug?.("memory-neo4j: community detection — no communities found");
    return { communitiesFound: 0, entitiesGrouped: 0, communitiesRemoved: 0 };
  }

  // Step 2: Create/update Community nodes
  // M1: Batch all entity name lookups in a single query to avoid N+1
  const allMemberIds = clusters.flatMap((ids) => ids);
  const nameMap = new Map<string, { name: string; relCount: number }>();
  if (allMemberIds.length > 0) {
    const nameResult = await session.executeRead((tx) =>
      tx.run(
        `MATCH (e:Entity) WHERE e.id IN $ids
         RETURN e.id AS id, e.name AS name, coalesce(e.relationshipCount, 0) AS relCount`,
        { ids: allMemberIds },
      ),
    );
    for (const r of nameResult.records) {
      nameMap.set(r.get("id") as string, {
        name: r.get("name") as string,
        relCount: Number(r.get("relCount")),
      });
    }
  }

  const activeCommunityIds: string[] = [];
  let totalEntities = 0;

  for (const memberIds of clusters) {
    if (abortSignal?.aborted) break;
    const sortedMembers = [...memberIds].sort();
    const communityId = createHash("sha256")
      .update(sortedMembers.join(":"))
      .digest("hex")
      .slice(0, 36);
    // Use pre-fetched entity names sorted by relationship count
    const entityNames = memberIds
      .map((id) => nameMap.get(id))
      .filter((e): e is { name: string; relCount: number } => e != null)
      .sort((a, b) => b.relCount - a.relCount)
      .slice(0, 5)
      .map((e) => e.name);
    const name =
      entityNames.length > 0
        ? entityNames.slice(0, 3).join(", ") +
          (memberIds.length > 3 ? ` (+${memberIds.length - 3})` : "")
        : `Community (${memberIds.length} entities)`;

    const community: CommunityNode = {
      id: communityId,
      name,
      summary: `Cluster of ${memberIds.length} related entities: ${entityNames.join(", ")}`,
      entityCount: memberIds.length,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await mergeCommunity(session, community, memberIds);
    activeCommunityIds.push(communityId);
    totalEntities += memberIds.length;
  }

  // Step 3: Clean stale communities
  const removed = await cleanStaleCommunityLinks(session, activeCommunityIds);

  logger.info(
    `memory-neo4j: community detection — found ${clusters.length} communities (${totalEntities} entities), removed ${removed} stale`,
  );

  return {
    communitiesFound: clusters.length,
    entitiesGrouped: totalEntities,
    communitiesRemoved: removed,
  };
}
