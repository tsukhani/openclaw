/**
 * Sleep cycle decay and temporal staleness operations for the Neo4j memory client.
 *
 * Contains functions for computing Ebbinghaus-inspired decay scores,
 * pruning decayed memories, decay distribution bucketing, and
 * fetching memories with temporal patterns for staleness checks.
 */

import neo4j, { type Session } from "neo4j-driver";
import { toJsNumber } from "./schema.js";

// --------------------------------------------------------------------------
// Sleep Cycle: Decay & Pruning
// --------------------------------------------------------------------------

/**
 * Find memories that have decayed below the retention threshold.
 *
 * Decay formula (Ebbinghaus-inspired):
 *   decay_score = importance × e^(-age_days / half_life)
 *
 * Where half_life scales with importance:
 *   half_life = baseHalfLifeDays × (1 + importance × importanceMultiplier)
 *
 * A memory with importance=1.0 decays slower than one with importance=0.3.
 *
 * IMPORTANT: Core memories (category='core') and user-pinned memories
 * are EXEMPT from decay. They persist indefinitely regardless of age.
 */
export async function findDecayedMemories(
  session: Session,
  options: {
    retentionThreshold?: number;
    baseHalfLifeDays?: number;
    importanceMultiplier?: number;
    /** Per-category half-life overrides. Categories not listed use baseHalfLifeDays. */
    decayCurves?: Record<string, { halfLifeDays: number }>;
    agentId?: string;
    limit?: number;
  } = {},
): Promise<
  Array<{ id: string; text: string; importance: number; ageDays: number; decayScore: number }>
> {
  const {
    retentionThreshold = 0.1,
    baseHalfLifeDays = 30,
    importanceMultiplier = 2,
    decayCurves,
    agentId,
    limit = 500,
  } = options;

  const agentFilter = agentId ? "AND m.agentId = $agentId" : "";

  // Build per-category half-life using parameterized map lookup instead of
  // string interpolation, avoiding any injection risk from category names.
  const curveEntries = decayCurves ? Object.entries(decayCurves) : [];
  const hasCurves = curveEntries.length > 0;

  // Pass category→halfLife mapping as a Cypher map parameter
  const curveMap: Record<string, number> = {};
  for (const [cat, { halfLifeDays }] of curveEntries) {
    curveMap[cat] = halfLifeDays;
  }

  const halfLifeExpr = hasCurves
    ? "CASE WHEN $curveMap[m.category] IS NOT NULL THEN $curveMap[m.category] ELSE $baseHalfLife END"
    : "$baseHalfLife";

  // Decay formula uses retrieval reinforcement: memories that are frequently
  // accessed decay slower. The effective age is anchored to the most recent
  // of createdAt or lastRetrievedAt, so recently recalled memories get a
  // recency boost even if they were created long ago.
  const result = await session.executeRead((tx) =>
    tx.run(
      `MATCH (m:Memory)
     WHERE m.createdAt IS NOT NULL
       AND m.category <> 'core'
       ${agentFilter}
     WITH m,
          duration.between(datetime(m.createdAt), datetime()).days AS ageDays,
          CASE
            WHEN m.lastRetrievedAt IS NOT NULL
            THEN duration.between(datetime(m.lastRetrievedAt), datetime()).days
            ELSE duration.between(datetime(m.createdAt), datetime()).days
          END AS effectiveAgeDays,
          m.importance AS importance,
          coalesce(m.retrievalCount, 0) AS retrievalCount
     WITH m, ageDays, effectiveAgeDays, importance, retrievalCount,
          ${halfLifeExpr} * (1.0 + importance * $importanceMult) * (1.0 + log(1.0 + retrievalCount) * 0.2) AS halfLife
     // M4: Use CASE to floor importance at 0.01 — memories with importance=0 would always
     // produce decayScore=0 and be pruned immediately regardless of age.
     WITH m, ageDays, importance, CASE WHEN importance <= 0 THEN 0.01 ELSE importance END AS safeImportance, halfLife,
          CASE WHEN importance <= 0 THEN 0.01 ELSE importance END * exp(-1.0 * effectiveAgeDays / halfLife) AS decayScore
     WHERE decayScore < $threshold
     RETURN m.id AS id, m.text AS text, importance, ageDays, decayScore
     ORDER BY decayScore ASC
     LIMIT $limit`,
      {
        threshold: retentionThreshold,
        baseHalfLife: baseHalfLifeDays,
        importanceMult: importanceMultiplier,
        curveMap,
        ...(agentId ? { agentId } : {}),
        limit: neo4j.int(limit),
      },
    ),
  );

  return result.records.map((r) => ({
    id: r.get("id") as string,
    text: r.get("text") as string,
    importance: r.get("importance") as number,
    ageDays: r.get("ageDays") as number,
    decayScore: r.get("decayScore") as number,
  }));
}

/**
 * Delete decayed memories.
 * OP-142: No mentionCount decrement — entities are independent of Memory lifecycle.
 */
export async function pruneMemories(session: Session, memoryIds: string[]): Promise<number> {
  // C2: Use executeWrite for proper transaction routing in clustered deployments
  const result = await session.executeWrite((tx) =>
    tx.run(
      `UNWIND $ids AS memId
       MATCH (m:Memory {id: memId})
       DETACH DELETE m
       RETURN count(*) AS deleted`,
      { ids: memoryIds },
    ),
  );

  return toJsNumber(result.records[0]?.get("deleted"));
}

/**
 * Get decay score distribution bucketed into health categories.
 * Computes decay scores server-side and buckets them.
 */
/**
 * H5: Accept optional decay parameters so the distribution matches the actual decay config.
 * When omitted, uses the same defaults as findDecayedMemories for consistency.
 */
export async function getDecayDistribution(
  session: Session,
  agentId?: string,
  options?: {
    baseHalfLifeDays?: number;
    importanceMultiplier?: number;
    /** C3: Per-category half-life overrides — must match findDecayedMemories config. */
    decayCurves?: Record<string, { halfLifeDays: number }>;
  },
): Promise<Array<{ bucket: string; count: number }>> {
  const baseHalfLife = options?.baseHalfLifeDays ?? 30;
  const importanceMult = options?.importanceMultiplier ?? 2;
  const agentFilter = agentId ? "AND m.agentId = $agentId" : "";

  // C3: Per-category half-life overrides (aligned with findDecayedMemories)
  const curveEntries = options?.decayCurves ? Object.entries(options.decayCurves) : [];
  const hasCurves = curveEntries.length > 0;
  const curveMap: Record<string, number> = {};
  for (const [cat, { halfLifeDays }] of curveEntries) {
    curveMap[cat] = halfLifeDays;
  }
  const halfLifeBaseExpr = hasCurves
    ? "CASE WHEN $curveMap[m.category] IS NOT NULL THEN $curveMap[m.category] ELSE $baseHalfLife END"
    : "$baseHalfLife";

  const result = await session.executeRead((tx) =>
    tx.run(
      `MATCH (m:Memory)
     WHERE m.createdAt IS NOT NULL AND m.category <> 'core' ${agentFilter}
     WITH m,
          m.importance AS importance,
          CASE
            WHEN m.lastRetrievedAt IS NOT NULL
            THEN duration.between(datetime(m.lastRetrievedAt), datetime()).days
            ELSE duration.between(datetime(m.createdAt), datetime()).days
          END AS effectiveAgeDays,
          coalesce(m.retrievalCount, 0) AS retrievalCount
     // C3: Floor importance at 0.01 to match findDecayedMemories (M4 safety floor)
     WITH m, CASE WHEN importance <= 0 THEN 0.01 ELSE importance END AS safeImportance,
          ${halfLifeBaseExpr} * (1.0 + importance * $importanceMult) * (1.0 + log(1.0 + retrievalCount) * 0.2) AS halfLife,
          effectiveAgeDays
     WITH CASE
       WHEN safeImportance * exp(-1.0 * effectiveAgeDays / halfLife) >= 0.8 THEN 'healthy'
       WHEN safeImportance * exp(-1.0 * effectiveAgeDays / halfLife) >= 0.5 THEN 'moderate'
       WHEN safeImportance * exp(-1.0 * effectiveAgeDays / halfLife) >= 0.2 THEN 'fading'
       ELSE 'near-pruning'
     END AS bucket
     RETURN bucket, count(*) AS cnt
     ORDER BY CASE bucket
       WHEN 'healthy' THEN 1
       WHEN 'moderate' THEN 2
       WHEN 'fading' THEN 3
       WHEN 'near-pruning' THEN 4
     END`,
      {
        baseHalfLife,
        importanceMult,
        curveMap,
        ...(agentId ? { agentId } : {}),
      },
    ),
  );
  return result.records.map((r) => ({
    bucket: r.get("bucket") as string,
    count: toJsNumber(r.get("cnt")),
  }));
}

// --------------------------------------------------------------------------
// Temporal Staleness Scanning
// --------------------------------------------------------------------------

/**
 * Fetch non-core memories older than minAgeDays for temporal staleness checking.
 * Only returns memories that contain date-like patterns to avoid wasting LLM calls
 * on memories that have no temporal component.
 */
export async function fetchMemoriesForTemporalCheck(
  session: Session,
  minAgeDays: number = 3,
  agentId?: string,
): Promise<Array<{ id: string; text: string }>> {
  const agentFilter = agentId ? "AND m.agentId = $agentId" : "";
  // Use originalCreatedAt (true information age) with createdAt as fallback
  // Expanded regex to catch more temporal patterns:
  //   - "Feb 13", "Mar 20" (abbreviated month + day without ordinal)
  //   - "February 13", "March 20-25" (full month + day/range)
  //   - Original patterns: HH:MM, AM/PM, tomorrow/today, ordinal+month, ISO dates, etc.
  // Skip memories checked in the last 24 hours to avoid redundant LLM calls across sleep cycles
  const result = await session.executeRead((tx) =>
    tx.run(
      `MATCH (m:Memory)
     WHERE m.category <> 'core'
       AND m.validUntil IS NULL
       AND COALESCE(m.originalCreatedAt, m.createdAt) IS NOT NULL
       AND duration.between(datetime(COALESCE(m.originalCreatedAt, m.createdAt)), datetime()).days >= $minAgeDays
       AND (m.temporalCheckedAt IS NULL OR duration.between(datetime(m.temporalCheckedAt), datetime()).hours >= 24)
       AND (m.text =~ '(?i).*(\\d{1,2}[:/]\\d{2}|\\d{1,2}\\s*(am|pm)|tomorrow|today|tonight|this morning|this afternoon|this evening|yesterday|last night|next week|\\d{1,2}(st|nd|rd|th)?\\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december)\\s+\\d{1,2}|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}/\\d{1,2}/\\d{2,4}|at \\d+%|progress|downloading|in progress|pending|waiting for).*')
       ${agentFilter}
     RETURN m.id AS id, m.text AS text
     ORDER BY COALESCE(m.originalCreatedAt, m.createdAt) ASC
     LIMIT 200`,
      { minAgeDays: neo4j.int(minAgeDays), ...(agentId ? { agentId } : {}) },
    ),
  );

  return result.records.map((r) => ({
    id: r.get("id") as string,
    text: r.get("text") as string,
  }));
}

/**
 * Set temporalCheckedAt on memories that were checked for temporal staleness.
 * Prevents re-checking the same memories on subsequent sleep cycles within 24h.
 */
export async function markTemporalChecked(session: Session, ids: string[]): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  await session.executeWrite((tx) =>
    tx.run(
      `UNWIND $ids AS id
       MATCH (m:Memory {id: id})
       SET m.temporalCheckedAt = $now`,
      { ids, now: new Date().toISOString() },
    ),
  );
}
