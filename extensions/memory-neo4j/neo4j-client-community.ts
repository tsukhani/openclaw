/**
 * Community detection and management operations for the Neo4j memory client.
 *
 * Implements label propagation clustering on the entity graph,
 * storing results as Community nodes with BELONGS_TO relationships.
 */

import { randomUUID } from "node:crypto";
import neo4j, { type Session } from "neo4j-driver";
import type { CommunityNode, Logger } from "./schema.js";

/**
 * Run label propagation on the entity graph (custom Cypher, no GDS required).
 *
 * Algorithm:
 * 1. Each entity starts with its own label (its ID)
 * 2. Each iteration, each entity adopts the most common label among its neighbors
 * 3. Repeats until convergence or maxIterations reached
 *
 * Returns clusters: arrays of entity IDs that share the same label.
 */
export async function runLabelPropagation(
  session: Session,
  agentId: string,
  options: { maxIterations?: number; minCommunitySize?: number } = {},
): Promise<string[][]> {
  const maxIter = options.maxIterations ?? 10;
  const minSize = options.minCommunitySize ?? 3;

  // Step 1: Fetch all entities and their inter-entity relationships for this agent
  const graphResult = await session.executeRead((tx) =>
    tx.run(
      `MATCH (e:Entity {agentId: $agentId})
       OPTIONAL MATCH (e)-[r]-(neighbor:Entity)
       WHERE type(r) <> 'TAGGED' AND type(r) <> 'DERIVED_FROM'
         AND type(r) <> 'EPISODE_SOURCE' AND type(r) <> 'BELONGS_TO'
       RETURN e.id AS entityId, collect(DISTINCT neighbor.id) AS neighborIds`,
      { agentId },
    ),
  );

  if (graphResult.records.length === 0) return [];

  // Build adjacency list and initialize labels
  const labels = new Map<string, string>(); // entityId → label
  const neighbors = new Map<string, string[]>(); // entityId → neighbor IDs

  for (const record of graphResult.records) {
    const entityId = record.get("entityId") as string;
    const nbrs = (record.get("neighborIds") as string[]).filter(Boolean);
    labels.set(entityId, entityId); // initial label = own ID
    neighbors.set(entityId, nbrs);
  }

  // Step 2: Iterate label propagation
  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false;
    for (const [entityId, nbrs] of neighbors) {
      if (nbrs.length === 0) continue;

      // Count labels among neighbors
      const labelCounts = new Map<string, number>();
      for (const nbr of nbrs) {
        const nbrLabel = labels.get(nbr);
        if (nbrLabel) {
          labelCounts.set(nbrLabel, (labelCounts.get(nbrLabel) ?? 0) + 1);
        }
      }

      // Find most common label
      let bestLabel = labels.get(entityId)!;
      let bestCount = 0;
      for (const [label, count] of labelCounts) {
        if (count > bestCount) {
          bestCount = count;
          bestLabel = label;
        }
      }

      if (bestLabel !== labels.get(entityId)) {
        labels.set(entityId, bestLabel);
        changed = true;
      }
    }

    if (!changed) break; // converged
  }

  // Step 3: Group entities by label, filter by minSize
  const clusters = new Map<string, string[]>();
  for (const [entityId, label] of labels) {
    if (!clusters.has(label)) clusters.set(label, []);
    clusters.get(label)!.push(entityId);
  }

  return [...clusters.values()].filter((c) => c.length >= minSize);
}

/**
 * Create or update a Community node in Neo4j and link member entities via BELONGS_TO.
 */
export async function mergeCommunity(
  session: Session,
  community: CommunityNode,
  memberEntityIds: string[],
): Promise<void> {
  const now = new Date().toISOString();

  // Merge community node
  await session.executeWrite((tx) =>
    tx.run(
      `MERGE (c:Community {id: $id})
       ON CREATE SET
         c.name = $name, c.summary = $summary,
         c.entityCount = $entityCount,
         c.createdAt = $createdAt, c.updatedAt = $updatedAt
       ON MATCH SET
         c.name = $name, c.summary = $summary,
         c.entityCount = $entityCount, c.updatedAt = $updatedAt
       WITH c
       UNWIND $memberIds AS memberId
       MATCH (e:Entity {id: memberId})
       MERGE (e)-[:BELONGS_TO]->(c)`,
      {
        id: community.id,
        name: community.name,
        summary: community.summary,
        entityCount: neo4j.int(memberEntityIds.length),
        createdAt: community.createdAt ?? now,
        updatedAt: now,
        memberIds: memberEntityIds,
      },
    ),
  );
}

/**
 * Remove stale BELONGS_TO relationships for entities no longer in any detected community.
 */
export async function cleanStaleCommunityLinks(
  session: Session,
  activeCommunityIds: string[],
): Promise<number> {
  const result = await session.executeWrite((tx) =>
    tx.run(
      `MATCH (e:Entity)-[r:BELONGS_TO]->(c:Community)
       WHERE NOT c.id IN $activeIds
       DELETE r
       WITH DISTINCT c
       WHERE NOT EXISTS { MATCH ()-[:BELONGS_TO]->(c) }
       DETACH DELETE c
       RETURN count(c) AS removed`,
      { activeIds: activeCommunityIds },
    ),
  );
  return (result.records[0]?.get("removed") as number) ?? 0;
}

/**
 * Get all communities for an agent (via member entities' agentId property).
 */
export async function getCommunities(
  session: Session,
  agentId: string,
  limit: number = 50,
): Promise<CommunityNode[]> {
  const result = await session.executeRead((tx) =>
    tx.run(
      `MATCH (c:Community)<-[:BELONGS_TO]-(e:Entity {agentId: $agentId})
       WITH DISTINCT c
       RETURN c.id AS id, c.name AS name, c.summary AS summary,
              c.entityCount AS entityCount, c.createdAt AS createdAt, c.updatedAt AS updatedAt
       ORDER BY c.entityCount DESC
       LIMIT $limit`,
      { agentId, limit: neo4j.int(limit) },
    ),
  );

  return result.records.map((r) => ({
    id: r.get("id") as string,
    name: r.get("name") as string,
    summary: (r.get("summary") as string) ?? "",
    entityCount: r.get("entityCount") as number,
    createdAt: String(r.get("createdAt") ?? ""),
    updatedAt: String(r.get("updatedAt") ?? ""),
  }));
}
