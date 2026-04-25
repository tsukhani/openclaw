/**
 * Subcommand handler implementations for the memory-neo4j CLI.
 *
 * Each export corresponds to a single `openclaw memory neo4j <cmd>` handler.
 * The thin registration table lives in cli.ts.
 */

import os from "node:os";
import path from "node:path";
import neo4j from "neo4j-driver";
import { passesAttentionGate } from "./attention-gate.js";
import type { CliDeps } from "./cli.js";
import type { ExtractionConfig, MemoryNeo4jConfig } from "./config.js";
import type { Embeddings } from "./embeddings.js";
import { bar } from "./eval/format-utils.js";
import { reportAbComparison, runAbComparison, runEval } from "./eval/index.js";
import type { EvalOutputFormat, MemoryAbility } from "./eval/types.js";
import { EVAL_VARIANTS } from "./eval/variants.js";
import { stripMessageWrappers } from "./message-utils.js";
import type { Neo4jMemoryClient } from "./neo4j-client.js";
import { resolveSelfEntityName } from "./plugin-hooks.js";
import type { Logger } from "./schema.js";
import { buildSearchOptions, hybridSearch } from "./search.js";
import { runSleepCycle } from "./sleep-cycle.js";

/** Iterative max to avoid stack overflow from Math.max(...spread) on large arrays. */
function iterMax(arr: number[]): number {
  if (arr.length === 0) {
    return 0;
  }
  let max = -Infinity;
  for (const v of arr) {
    if (v > max) {
      max = v;
    }
  }
  return max;
}

/** Render a bar chart segment. Shared by all CLI command handlers. */

// ── list ────────────────────────────────────────────────────────────────────

export async function handleList(
  db: Neo4jMemoryClient,
  opts: { agent?: string; category?: string; limit?: string; json?: boolean },
): Promise<void> {
  try {
    await db.ensureInitialized();
    const perCategoryLimit = opts.limit ? Number.parseInt(opts.limit, 10) : 20;
    if (Number.isNaN(perCategoryLimit) || perCategoryLimit <= 0) {
      console.error("Error: --limit must be greater than 0");
      process.exitCode = 1;
      return;
    }

    // Build query with optional filters
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};
    if (opts.agent) {
      conditions.push("m.agentId = $agentId");
      params.agentId = opts.agent;
    }
    if (opts.category) {
      conditions.push("m.category = $category");
      params.category = opts.category;
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const rows = await db.runQuery<{
      agentId: string;
      category: string;
      id: string;
      text: string;
      importance: number;
      createdAt: string;
      source: string;
    }>(
      `MATCH (m:Memory) ${where}
                 WITH m.agentId AS agentId, m.category AS category, m
                 ORDER BY m.importance DESC
                 WITH agentId, category, collect({
                   id: m.id, text: m.text, importance: m.importance,
                   createdAt: m.createdAt, source: coalesce(m.source, 'unknown')
                 }) AS memories
                 UNWIND memories[0..$perCategoryLimit] AS mem
                 RETURN agentId, category,
                        mem.id AS id, mem.text AS text,
                        mem.importance AS importance,
                        mem.createdAt AS createdAt,
                        mem.source AS source
                 ORDER BY agentId, category, importance DESC`,
      { ...params, perCategoryLimit: neo4j.int(perCategoryLimit) },
    );

    // ── Query entities, relationships, tags (used by both JSON and text output) ──
    const eConditions: string[] = [];
    const eParams: Record<string, unknown> = {};
    if (opts.agent) {
      eConditions.push("e.agentId = $agentId");
      eParams.agentId = opts.agent;
    }
    const eWhere = eConditions.length > 0 ? `WHERE ${eConditions.join(" AND ")}` : "";
    const entityRows = await db.runQuery<{
      agentId: string;
      name: string;
      type: string;
      description: string | null;
      relCount: number;
    }>(
      `MATCH (e:Entity) ${eWhere}
       OPTIONAL MATCH (e)-[r]-(:Entity)
       WITH e, count(r) AS relCount
       RETURN coalesce(e.agentId, 'unknown') AS agentId, e.name AS name,
              e.type AS type, e.description AS description, relCount
       ORDER BY e.agentId, relCount DESC, e.name`,
      eParams,
    );

    const rConditions: string[] = [];
    const rParams: Record<string, unknown> = {};
    if (opts.agent) {
      rConditions.push("(e1.agentId = $agentId OR e2.agentId = $agentId)");
      rParams.agentId = opts.agent;
    }
    const rWhere = rConditions.length > 0 ? `WHERE ${rConditions.join(" AND ")}` : "";
    const relRows = await db.runQuery<{
      source: string;
      relType: string;
      target: string;
      confidence: number;
    }>(
      `MATCH (e1:Entity)-[r]->(e2:Entity) ${rWhere}
       RETURN e1.name AS source, type(r) AS relType, e2.name AS target,
              coalesce(r.confidence, 0) AS confidence
       ORDER BY r.confidence DESC, e1.name
       LIMIT 100`,
      rParams,
    );

    const tConditions: string[] = [];
    const tParams: Record<string, unknown> = {};
    if (opts.agent) {
      tConditions.push("m.agentId = $agentId");
      tParams.agentId = opts.agent;
    }
    const tWhere = tConditions.length > 0 ? `WHERE ${tConditions.join(" AND ")}` : "";
    const tagRows = await db.runQuery<{
      agentId: string;
      tagName: string;
      tagCategory: string;
      memCount: number;
    }>(
      `MATCH (m:Memory)-[:TAGGED]->(t:Tag) ${tWhere}
       WITH coalesce(m.agentId, 'unknown') AS agentId, t.name AS tagName,
            coalesce(t.category, 'other') AS tagCategory, count(m) AS memCount
       RETURN agentId, tagName, tagCategory, memCount
       ORDER BY agentId, memCount DESC, tagName`,
      tParams,
    );

    if (opts.json) {
      console.log(
        JSON.stringify(
          { memories: rows, entities: entityRows, relationships: relRows, tags: tagRows },
          null,
          2,
        ),
      );
      return;
    }

    if (rows.length === 0 && entityRows.length === 0 && tagRows.length === 0) {
      console.log("No memories found.");
      return;
    }

    // Group by agent -> category -> memories
    const byAgent = new Map<
      string,
      Map<
        string,
        Array<{
          id: string;
          text: string;
          importance: number;
          createdAt: string;
          source: string;
        }>
      >
    >();
    for (const row of rows) {
      const agent = row.agentId ?? "default";
      const cat = row.category ?? "other";
      if (!byAgent.has(agent)) {
        byAgent.set(agent, new Map());
      }
      const catMap = byAgent.get(agent)!;
      if (!catMap.has(cat)) {
        catMap.set(cat, []);
      }
      catMap.get(cat)!.push({
        id: row.id,
        text: row.text,
        importance: row.importance,
        createdAt: row.createdAt,
        source: row.source,
      });
    }

    for (const [agentId, categories] of byAgent) {
      const agentTotal = [...categories.values()].reduce((s, m) => s + m.length, 0);
      console.log(`\n\u250C\u2500 ${agentId} (${agentTotal} shown)`);

      for (const [category, memories] of categories) {
        console.log(`\u2502\n\u2502  \u2500\u2500 ${category} (${memories.length}) \u2500\u2500`);
        for (const mem of memories) {
          const pct = ((mem.importance * 100).toFixed(0) + "%").padStart(4);
          const preview = mem.text.length > 72 ? `${mem.text.slice(0, 69)}...` : mem.text;
          console.log(`\u2502  ${bar(mem.importance, 10)} ${pct}  ${preview}`);
        }
      }
      console.log("\u2514");
    }

    // ── Entities by agent (using pre-queried entityRows) ──────────────────
    if (entityRows.length > 0) {
      const entitiesByAgent = new Map<
        string,
        Array<{ name: string; type: string; description: string | null; relCount: number }>
      >();
      for (const row of entityRows) {
        const agent = row.agentId ?? "unknown";
        if (!entitiesByAgent.has(agent)) {
          entitiesByAgent.set(agent, []);
        }
        entitiesByAgent.get(agent)!.push({
          name: row.name,
          type: row.type,
          description: row.description,
          relCount: row.relCount,
        });
      }

      for (const [agentId, entities] of entitiesByAgent) {
        console.log(`\n\u250C\u2500 ${agentId} \u2014 Entities (${entities.length})`);
        for (const e of entities) {
          const desc = e.description ? ` \u2014 ${e.description.slice(0, 50)}` : "";
          console.log(`\u2502  [${e.type}] ${e.name} (${e.relCount} rels)${desc}`);
        }
        console.log("\u2514");
      }
    }

    // ── Relationships (using pre-queried relRows) ─────────────────────────
    if (relRows.length > 0) {
      console.log(`\n\u250C\u2500 Relationships (${relRows.length})`);
      for (const r of relRows) {
        const conf = r.confidence > 0 ? ` (${(r.confidence * 100).toFixed(0)}%)` : "";
        console.log(`\u2502  ${r.source} \u2500[${r.relType}]\u2500> ${r.target}${conf}`);
      }
      console.log("\u2514");
    }

    // ── Tags by agent (using pre-queried tagRows) ────────────────────────
    if (tagRows.length > 0) {
      const tagsByAgent = new Map<
        string,
        Array<{ tagName: string; tagCategory: string; memCount: number }>
      >();
      for (const row of tagRows) {
        const agent = row.agentId ?? "unknown";
        if (!tagsByAgent.has(agent)) {
          tagsByAgent.set(agent, []);
        }
        tagsByAgent.get(agent)!.push({
          tagName: row.tagName,
          tagCategory: row.tagCategory,
          memCount: row.memCount,
        });
      }

      for (const [agentId, tags] of tagsByAgent) {
        console.log(`\n\u250C\u2500 ${agentId} \u2014 Tags (${tags.length})`);
        for (const t of tags) {
          console.log(`\u2502  ${t.tagName} [${t.tagCategory}] (${t.memCount} memories)`);
        }
        console.log("\u2514");
      }
    }

    console.log("");
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

// ── search ──────────────────────────────────────────────────────────────────

export async function handleSearch(
  db: Neo4jMemoryClient,
  embeddings: Embeddings,
  extractionConfig: ExtractionConfig,
  cfg: MemoryNeo4jConfig,
  query: string,
  opts: { limit: string; agent?: string; includeExpired?: boolean; provenance?: boolean },
): Promise<void> {
  try {
    const provenanceEnabled = opts.provenance === true;
    // Resolve selfEntityName: config takes priority, then USER.md in workspace dir
    const workspaceDir = path.join(os.homedir(), ".openclaw", "workspace");
    const selfEntityName =
      cfg.selfEntityName ?? (await resolveSelfEntityName(workspaceDir).catch(() => null));
    const searchOptions = buildSearchOptions({
      cfg,
      extractionConfig,
      db,
      logger: { info() {}, warn() {}, debug() {}, error() {} } as unknown as Logger,
      selfEntityName,
      includeExpired: opts.includeExpired ?? false,
    });
    // CLI-specific override: provenance flag from --provenance option
    searchOptions!.provenanceEnabled = provenanceEnabled;
    const results = await hybridSearch(
      db,
      embeddings,
      query,
      Math.max(1, Number.parseInt(opts.limit, 10) || 5),
      opts.agent ?? "default",
      extractionConfig.enabled,
      searchOptions,
    );

    // Partition results by dominant signal for easier inspection.
    // "graph" = graph signal fired (score > 0); otherwise "memory" (vector/bm25).
    const graphResults = results.filter((r) => (r.signals?.graph?.score ?? 0) > 0);
    const memoryResults = results.filter((r) => (r.signals?.graph?.score ?? 0) === 0);

    const fmt = (r: (typeof results)[number]) => {
      const base: Record<string, unknown> = {
        id: r.id,
        text: r.text,
        category: r.category,
        importance: r.importance,
        score: r.score,
        signals: r.signals
          ? {
              vector: r.signals.vector?.score?.toFixed(4) ?? "\u2014",
              bm25: r.signals.bm25?.score?.toFixed(4) ?? "\u2014",
              graph: r.signals.graph?.score?.toFixed(4) ?? "\u2014",
            }
          : undefined,
      };
      if (provenanceEnabled) {
        if (r.provenance) {
          base.provenance = r.provenance;
        }
        if (r.fusionProvenance) {
          base.fusionProvenance = r.fusionProvenance;
        }
      }
      return base;
    };

    const output = {
      query,
      total: results.length,
      bySignal: {
        memory: memoryResults.map(fmt),
        graph: graphResults.map(fmt),
      },
    };
    console.log(JSON.stringify(output, null, 2));
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

// ── supersede ───────────────────────────────────────────────────────────────

export async function handleSupersede(
  db: Neo4jMemoryClient,
  oldId: string,
  newId: string,
): Promise<void> {
  try {
    await db.ensureInitialized();
    await db.supersedeMemory(oldId, newId);
    console.log(`\u2713 Memory ${oldId.slice(0, 8)} superseded by ${newId.slice(0, 8)}`);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

// ── stats ───────────────────────────────────────────────────────────────────

export async function handleStats(
  db: Neo4jMemoryClient,
  cfg: MemoryNeo4jConfig,
  extractionConfig: ExtractionConfig,
  opts: { agent?: string },
): Promise<void> {
  try {
    await db.ensureInitialized();
    const stats = await db.getMemoryStats(opts.agent);
    const total = stats.reduce((sum, s) => sum + s.count, 0);

    console.log("\nMemory (Neo4j) Statistics");
    console.log(
      "\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500",
    );
    console.log(`Total memories: ${total}`);
    console.log(`Neo4j URI:      ${cfg.neo4j.uri}`);
    console.log(`Embedding:      ${cfg.embedding.provider}/${cfg.embedding.model}`);
    console.log(
      `Extraction:     ${extractionConfig.enabled ? extractionConfig.model : "disabled"}`,
    );
    console.log(`Auto-capture:   ${cfg.autoCapture ? "enabled" : "disabled"}`);
    console.log(`Auto-recall:    ${cfg.autoRecall ? "enabled" : "disabled"}`);
    console.log(`Core memory:    ${cfg.coreMemory.enabled ? "enabled" : "disabled"}`);

    if (stats.length > 0) {
      // Group by agentId
      const byAgent = new Map<
        string,
        Array<{ category: string; count: number; avgImportance: number }>
      >();
      for (const row of stats) {
        const list = byAgent.get(row.agentId) || [];
        list.push({
          category: row.category,
          count: row.count,
          avgImportance: row.avgImportance,
        });
        byAgent.set(row.agentId, list);
      }

      for (const [agentId, categories] of byAgent) {
        const agentTotal = categories.reduce((sum, c) => sum + c.count, 0);
        const maxCatCount = iterMax(categories.map((c) => c.count));
        const catLabelLen = iterMax(categories.map((c) => c.category.length));

        console.log(`\n\u250C\u2500 ${agentId} (${agentTotal} memories)`);
        console.log("\u2502");
        console.log(
          `\u2502  ${"Category".padEnd(catLabelLen)}  ${"Count".padStart(5)}  ${"".padEnd(20)}  ${"Importance".padStart(10)}`,
        );
        console.log(`\u2502  ${"\u2500".repeat(catLabelLen + 5 + 20 * 2 + 18)}`);
        for (const { category, count, avgImportance } of categories) {
          const cat = category.padEnd(catLabelLen);
          const cnt = String(count).padStart(5);
          const pct = ((avgImportance * 100).toFixed(0) + "%").padStart(10);
          console.log(
            `\u2502  ${cat}  ${cnt}  ${bar(count / maxCatCount)}  ${pct}  ${bar(avgImportance)}`,
          );
        }
        console.log("\u2514");
      }

      console.log(`\nAgents: ${byAgent.size} (${[...byAgent.keys()].join(", ")})`);
    }

    // ── Entity stats by agent ────────────────────────────────────────────
    const agentFilter = opts.agent ? "WHERE e.agentId = $agentId" : "";
    const agentParams = opts.agent ? { agentId: opts.agent } : {};
    const entityStats = await db.runQuery<{
      agentId: string;
      type: string;
      count: number;
      totalRels: number;
    }>(
      `MATCH (e:Entity) ${agentFilter}
       OPTIONAL MATCH (e)-[r]-(:Entity)
       WITH coalesce(e.agentId, 'unknown') AS agentId, e.type AS type,
            count(DISTINCT e) AS count, count(r) AS totalRels
       RETURN agentId, type, count, totalRels
       ORDER BY agentId, count DESC`,
      agentParams,
    );

    if (entityStats.length > 0) {
      const entByAgent = new Map<
        string,
        Array<{ type: string; count: number; totalRels: number }>
      >();
      for (const row of entityStats) {
        const list = entByAgent.get(row.agentId) || [];
        list.push({ type: row.type, count: row.count, totalRels: row.totalRels });
        entByAgent.set(row.agentId, list);
      }

      for (const [agentId, types] of entByAgent) {
        const agentTotal = types.reduce((s, t) => s + t.count, 0);
        const agentRels = types.reduce((s, t) => s + t.totalRels, 0);
        const maxTypeCount = iterMax(types.map((t) => t.count));
        const typeLabelLen = iterMax(types.map((t) => t.type.length));

        console.log(
          `\n\u250C\u2500 ${agentId} (${agentTotal} entities, ${agentRels} relationships)`,
        );
        console.log("\u2502");
        console.log(
          `\u2502  ${"Type".padEnd(typeLabelLen)}  ${"Count".padStart(5)}  ${"".padEnd(20)}  ${"Rels".padStart(5)}`,
        );
        console.log(`\u2502  ${"\u2500".repeat(typeLabelLen + 5 + 20 + 10)}`);
        for (const { type, count, totalRels } of types) {
          const tp = type.padEnd(typeLabelLen);
          const cnt = String(count).padStart(5);
          const rels = String(totalRels).padStart(5);
          console.log(`\u2502  ${tp}  ${cnt}  ${bar(count / maxTypeCount)}  ${rels}`);
        }
        console.log("\u2514");
      }
    }

    // ── Tag stats by agent ───────────────────────────────────────────────
    const tagFilter = opts.agent ? "WHERE m.agentId = $agentId" : "";
    const tagParams = opts.agent ? { agentId: opts.agent } : {};
    const tagStats = await db.runQuery<{
      agentId: string;
      tagCategory: string;
      tagCount: number;
      memCount: number;
    }>(
      `MATCH (m:Memory)-[:TAGGED]->(t:Tag) ${tagFilter}
       WITH coalesce(m.agentId, 'unknown') AS agentId,
            coalesce(t.category, 'other') AS tagCategory,
            count(DISTINCT t) AS tagCount, count(m) AS memCount
       RETURN agentId, tagCategory, tagCount, memCount
       ORDER BY agentId, memCount DESC`,
      tagParams,
    );

    if (tagStats.length > 0) {
      const tagsByAgent = new Map<
        string,
        Array<{ tagCategory: string; tagCount: number; memCount: number }>
      >();
      for (const row of tagStats) {
        const list = tagsByAgent.get(row.agentId) || [];
        list.push({ tagCategory: row.tagCategory, tagCount: row.tagCount, memCount: row.memCount });
        tagsByAgent.set(row.agentId, list);
      }

      for (const [agentId, categories] of tagsByAgent) {
        const totalTags = categories.reduce((s, c) => s + c.tagCount, 0);
        const maxMemCount = iterMax(categories.map((c) => c.memCount));
        const catLabelLen = iterMax(categories.map((c) => c.tagCategory.length));

        console.log(`\n\u250C\u2500 ${agentId} (${totalTags} tags)`);
        console.log("\u2502");
        console.log(
          `\u2502  ${"Category".padEnd(catLabelLen)}  ${"Tags".padStart(5)}  ${"Memories".padStart(8)}  ${"".padEnd(20)}`,
        );
        console.log(`\u2502  ${"\u2500".repeat(catLabelLen + 5 + 8 + 20 + 8)}`);
        for (const { tagCategory, tagCount, memCount } of categories) {
          const cat = tagCategory.padEnd(catLabelLen);
          const tags = String(tagCount).padStart(5);
          const mems = String(memCount).padStart(8);
          console.log(`\u2502  ${cat}  ${tags}  ${mems}  ${bar(memCount / maxMemCount)}`);
        }
        console.log("\u2514");
      }
    }

    console.log("");
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

// ── sleep ───────────────────────────────────────────────────────────────────

export async function handleSleep(
  db: Neo4jMemoryClient,
  embeddings: Embeddings,
  extractionConfig: ExtractionConfig,
  cfg: MemoryNeo4jConfig,
  logger: Logger,
  opts: {
    agent?: string;
    dedupThreshold?: string;
    decayThreshold?: string;
    decayHalfLife?: string;
    batchSize?: string;
    delay?: string;
    maxSemanticPairs?: string;
    concurrency?: string;
    skipSemantic?: boolean;
    skipRetroactiveTagging?: boolean;
    report?: boolean;
  },
): Promise<void> {
  console.log("\n\ud83c\udf19 Memory Sleep Cycle");
  console.log(
    "\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550",
  );
  console.log("Multi-phase memory consolidation:\n");
  console.log("  Phase 1:   Deduplication       \u2014 Merge near-duplicate memories");
  console.log(
    "  Phase 1b:  Semantic Dedup      \u2014 LLM-based paraphrase detection (0.75\u20130.95 band)",
  );
  console.log("  Phase 1c:  Conflict Detection  \u2014 Resolve contradictory memories");
  console.log("  Phase 1d:  Entity Dedup        \u2014 Merge duplicate entity nodes");
  console.log("  Phase 2:   Extraction          \u2014 Extract entities and categorize");
  console.log("  Phase 2b:  Retroactive Tagging \u2014 Tag memories missing topic tags");
  console.log("  Phase 3:   Decay & Pruning     \u2014 Remove stale low-importance memories");
  console.log("  Phase 4:   Orphan Cleanup      \u2014 Remove disconnected nodes");
  console.log("  Phase 5:   Noise Cleanup       \u2014 Remove dangerous pattern memories");
  console.log("  Phase 5b:  Credential Scan     \u2014 Remove memories with leaked secrets\n");

  try {
    // Validate sleep cycle CLI parameters before running
    const batchSize = opts.batchSize ? Number.parseInt(opts.batchSize, 10) : undefined;
    const delay = opts.delay ? Number.parseInt(opts.delay, 10) : undefined;
    const decayHalfLife = opts.decayHalfLife ? Number.parseInt(opts.decayHalfLife, 10) : undefined;
    const decayThreshold = opts.decayThreshold ? Number.parseFloat(opts.decayThreshold) : undefined;

    if (batchSize != null && (Number.isNaN(batchSize) || batchSize <= 0)) {
      console.error("Error: --batch-size must be greater than 0");
      process.exitCode = 1;
      return;
    }
    if (delay != null && (Number.isNaN(delay) || delay < 0)) {
      console.error("Error: --delay must be >= 0");
      process.exitCode = 1;
      return;
    }
    if (decayHalfLife != null && (Number.isNaN(decayHalfLife) || decayHalfLife <= 0)) {
      console.error("Error: --decay-half-life must be greater than 0");
      process.exitCode = 1;
      return;
    }
    if (
      decayThreshold != null &&
      (Number.isNaN(decayThreshold) || decayThreshold < 0 || decayThreshold > 1)
    ) {
      console.error("Error: --decay-threshold must be between 0 and 1");
      process.exitCode = 1;
      return;
    }

    // C1: Validate dedupThreshold — must be between 0 and 1 (like decayThreshold above)
    const dedupThreshold = opts.dedupThreshold ? Number.parseFloat(opts.dedupThreshold) : undefined;
    if (
      dedupThreshold != null &&
      (Number.isNaN(dedupThreshold) || dedupThreshold < 0 || dedupThreshold > 1)
    ) {
      console.error("Error: --dedup-threshold must be between 0 and 1");
      process.exitCode = 1;
      return;
    }

    const maxSemanticPairs = opts.maxSemanticPairs
      ? Number.parseInt(opts.maxSemanticPairs, 10)
      : undefined;
    if (maxSemanticPairs != null && (Number.isNaN(maxSemanticPairs) || maxSemanticPairs <= 0)) {
      console.error("Error: --max-semantic-pairs must be greater than 0");
      process.exitCode = 1;
      return;
    }

    const concurrency = opts.concurrency ? Number.parseInt(opts.concurrency, 10) : undefined;
    if (concurrency != null && (Number.isNaN(concurrency) || concurrency <= 0)) {
      console.error("Error: --concurrency must be greater than 0");
      process.exitCode = 1;
      return;
    }

    await db.ensureInitialized();

    // Mirror the service path (index.ts): create an AbortController so
    // that a mid-cycle SIGINT/SIGTERM can cancel in-flight LLM calls
    // and phase iterations cleanly. (OP-95 gap)
    const cliAbort = new AbortController();
    const abortOnSignal = () => cliAbort.abort();
    process.once("SIGINT", abortOnSignal);
    process.once("SIGTERM", abortOnSignal);

    // H4: Wrap in try/finally to ensure signal handlers are removed even on error
    let result;
    try {
      result = await runSleepCycle(db, embeddings, extractionConfig, logger, {
        abortSignal: cliAbort.signal,
        agentId: opts.agent,
        dedupThreshold,
        skipSemanticDedup: opts.skipSemantic === true,
        skipRetroactiveTagging: opts.skipRetroactiveTagging === true,
        maxSemanticDedupPairs: maxSemanticPairs,
        llmConcurrency: concurrency ?? extractionConfig.concurrency,
        decayRetentionThreshold: decayThreshold,
        decayBaseHalfLifeDays: decayHalfLife,
        decayCurves: Object.keys(cfg.decayCurves).length > 0 ? cfg.decayCurves : undefined,
        extractionBatchSize: batchSize,
        extractionDelayMs: delay,
        onPhaseStart: (phase) => {
          const phaseNames: Record<string, string> = {
            dedup: "Phase 1: Deduplication",
            semanticDedup: "Phase 1b: Semantic Deduplication",
            conflict: "Phase 1c: Conflict Detection",
            entityDedup: "Phase 1d: Entity Deduplication",
            extraction: "Phase 2: Extraction",
            retroactiveTagging: "Phase 2b: Retroactive Tagging",
            decay: "Phase 3: Decay & Pruning",
            cleanup: "Phase 4: Orphan Cleanup",
            noiseCleanup: "Phase 5: Noise Cleanup",
            credentialScan: "Phase 5b: Credential Scan",
            tipGeneration: "Phase 6: Tip Generation",
            temporalStaleness: "Phase 3b: Temporal Staleness Check",
            retroactiveConflictScan: "Phase 3c: Retroactive Conflict Scan",
          };
          console.log(`\n\u25B6 ${phaseNames[phase] ?? phase}`);
          console.log(
            "\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500",
          );
        },
        onProgress: (_phase, message) => {
          console.log(`   ${message}`);
        },
      });
    } finally {
      // Remove signal handlers even if the cycle throws
      process.off("SIGINT", abortOnSignal);
      process.off("SIGTERM", abortOnSignal);
    }

    console.log(
      "\n\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550",
    );
    console.log(`\u2705 Sleep cycle complete in ${(result.durationMs / 1000).toFixed(1)}s`);
    console.log(
      "\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500",
    );
    console.log(
      `   Deduplication:  ${result.dedup.clustersFound} clusters \u2192 ${result.dedup.memoriesMerged} merged`,
    );
    console.log(
      `   Conflicts:      ${result.conflict.pairsFound} pairs, ${result.conflict.resolved} resolved, ${result.conflict.invalidated} invalidated`,
    );
    console.log(
      `   Semantic Dedup: ${result.semanticDedup.pairsChecked} pairs checked, ${result.semanticDedup.duplicatesMerged} merged`,
    );
    console.log(`   Decay/Pruning:  ${result.decay.memoriesPruned} memories pruned`);
    if ((result.temporalStaleness?.memoriesRemoved ?? 0) > 0) {
      console.log(
        `   Temporal Stale: ${result.temporalStaleness?.memoriesChecked ?? 0} checked, ${result.temporalStaleness?.memoriesRemoved ?? 0} removed (Phase 3b)`,
      );
    }
    if ((result.retroactiveConflictScan?.memoriesSuperseded ?? 0) > 0) {
      console.log(
        `   Retro Conflict: ${result.retroactiveConflictScan?.memoriesScanned ?? 0} scanned, ${result.retroactiveConflictScan?.memoriesSuperseded ?? 0} superseded (Phase 3c)`,
      );
    }
    console.log(
      `   Extraction:     ${result.extraction.succeeded}/${result.extraction.total} extracted` +
        (result.extraction.failed > 0 ? ` (${result.extraction.failed} failed)` : ""),
    );
    console.log(
      `   Retro-Tagging:  ${result.retroactiveTagging.tagged}/${result.retroactiveTagging.total} tagged` +
        (result.retroactiveTagging.failed > 0
          ? ` (${result.retroactiveTagging.failed} failed)`
          : ""),
    );
    console.log(
      `   Cleanup:        ${result.cleanup.entitiesRemoved} entities, ${result.cleanup.tagsRemoved} tags removed`,
    );
    console.log(
      `  \u26A1 Tip Generation: ${result.tipGeneration.sessionsScanned} sessions, ${result.tipGeneration.failurePatternsFound} patterns, ${result.tipGeneration.tipsStored} tips stored`,
    );
    if (result.aborted) {
      console.log("\n\u26A0\uFE0F  Sleep cycle was aborted before completion.");
    }

    // Quality report (optional)
    if (opts.report) {
      console.log(
        "\n\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550",
      );
      console.log("\ud83d\udcca Quality Report");
      console.log(
        "\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500",
      );

      try {
        // Extraction coverage
        const statusCounts = await db.countByExtractionStatus(opts.agent);
        const totalMems =
          statusCounts.pending + statusCounts.complete + statusCounts.failed + statusCounts.skipped;
        const coveragePct =
          totalMems > 0 ? ((statusCounts.complete / totalMems) * 100).toFixed(1) : "0.0";
        console.log(
          `\n  Extraction Coverage: ${coveragePct}% (${statusCounts.complete}/${totalMems})`,
        );
        console.log(
          `    pending=${statusCounts.pending}  complete=${statusCounts.complete}  failed=${statusCounts.failed}  skipped=${statusCounts.skipped}`,
        );

        // Entity graph stats
        const graphStats = await db.getEntityGraphStats(opts.agent);
        console.log(`\n  Entity Graph:`);
        console.log(
          `    Entities: ${graphStats.entityCount}  Relationships: ${graphStats.relationshipCount}  Density: ${graphStats.density.toFixed(2)}`,
        );

        // Decay distribution
        const decayDist = await db.getDecayDistribution(opts.agent);
        if (decayDist.length > 0) {
          const maxCount = iterMax(decayDist.map((d) => d.count));
          console.log(`\n  Decay Distribution:`);
          for (const { bucket, count } of decayDist) {
            const ratio = maxCount > 0 ? count / maxCount : 0;
            console.log(`    ${bucket.padEnd(13)} ${bar(ratio)} ${count}`);
          }
        }
      } catch (reportErr) {
        console.log(`\n  \u26A0\uFE0F  Could not generate quality report: ${String(reportErr)}`);
      }
    }

    console.log("");
  } catch (err) {
    console.error(
      `\n\u274C Sleep cycle failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
  }
}

// ── index ───────────────────────────────────────────────────────────────────

export async function handleIndex(
  db: Neo4jMemoryClient,
  embeddings: Embeddings,
  cfg: MemoryNeo4jConfig,
  vectorDim: number,
  opts: { batchSize?: string },
): Promise<void> {
  const batchSize = opts.batchSize ? Number.parseInt(opts.batchSize, 10) : 50;
  if (Number.isNaN(batchSize) || batchSize <= 0) {
    console.error("Error: --batch-size must be greater than 0");
    process.exitCode = 1;
    return;
  }

  console.log("\nMemory Neo4j \u2014 Reindex Embeddings");
  console.log(
    "\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550",
  );
  console.log(`Model:      ${cfg.embedding.provider}/${cfg.embedding.model}`);
  console.log(`Dimensions: ${vectorDim}`);
  console.log(`Batch size: ${batchSize}\n`);

  try {
    const startedAt = Date.now();
    const result = await db.reindex((texts) => embeddings.embedBatch(texts), {
      batchSize,
      onProgress: (phase, done, total) => {
        if (phase === "drop-indexes" && done === 0) {
          console.log("\u25B6 Dropping old vector index\u2026");
        } else if (phase === "memories") {
          console.log(`   Memories: ${done}/${total}`);
        } else if (phase === "create-indexes" && done === 0) {
          console.log("\u25B6 Recreating vector index\u2026");
        }
      },
    });

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(
      "\n\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550",
    );
    console.log(`\u2705 Reindex complete in ${elapsed}s \u2014 ${result.memories} memories`);
    console.log("");
  } catch (err) {
    console.error(`\n\u274C Reindex failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

// ── cleanup ─────────────────────────────────────────────────────────────────

export async function handleCleanup(
  db: Neo4jMemoryClient,
  opts: { execute?: boolean; all?: boolean; agent?: string },
): Promise<void> {
  try {
    await db.ensureInitialized();

    // Fetch memories -- by default only auto-capture (explicit stores are trusted)
    const conditions: string[] = [];
    if (!opts.all) {
      conditions.push("m.source = 'auto-capture'");
    }
    if (opts.agent) {
      conditions.push("m.agentId = $agentId");
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const allMemories = await db.runQuery<{
      id: string;
      text: string;
      source: string;
    }>(
      `MATCH (m:Memory) ${where}
               RETURN m.id AS id, m.text AS text, COALESCE(m.source, 'unknown') AS source
               ORDER BY m.createdAt ASC`,
      opts.agent ? { agentId: opts.agent } : {},
    );

    // Strip channel metadata wrappers (same as the real pipeline) then gate
    const noise: Array<{ id: string; text: string; source: string }> = [];
    for (const mem of allMemories) {
      const stripped = stripMessageWrappers(mem.text);
      if (!passesAttentionGate(stripped)) {
        noise.push(mem);
      }
    }

    if (noise.length === 0) {
      console.log("\nNo low-substance memories found. Everything passes the gate.");
      return;
    }

    console.log(
      `\nFound ${noise.length}/${allMemories.length} memories that fail the attention gate:\n`,
    );

    for (const mem of noise) {
      const preview = mem.text.length > 80 ? `${mem.text.slice(0, 77)}...` : mem.text;
      console.log(`  [${mem.source}] "${preview}"`);
    }

    if (!opts.execute) {
      console.log(
        `\nDry run \u2014 ${noise.length} memories would be removed. Re-run with --execute to delete.\n`,
      );
      return;
    }

    // Delete in batch
    const deleted = await db.pruneMemories(noise.map((m) => m.id));
    console.log(`\nDeleted ${deleted} low-substance memories.\n`);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

// ── health ──────────────────────────────────────────────────────────────────

export async function handleHealth(
  db: Neo4jMemoryClient,
  opts: { agent?: string; json?: boolean },
): Promise<void> {
  try {
    await db.ensureInitialized();

    const agentId = opts.agent;

    // Gather all data in parallel — use allSettled so one failure doesn't lose all results
    const settled = await Promise.allSettled([
      db.getMemoryStats(agentId),
      db.countMemories(agentId),
      db.countByExtractionStatus(agentId),
      db.getEntityGraphStats(agentId),
      db.getDecayDistribution(agentId),
      db.findOrphanEntities(500),
      db.findOrphanTags(500),
      db.findSingleUseTags(14, 500),
    ]);
    const val = <T>(r: PromiseSettledResult<T>, fallback: T): T =>
      r.status === "fulfilled" ? r.value : fallback;
    const emptyStatus = { pending: 0, complete: 0, failed: 0, skipped: 0, decomposed: 0 } as Record<
      import("./schema.js").ExtractionStatus,
      number
    >;
    const memoryStats = val(settled[0], []);
    const totalCount = val(settled[1], 0);
    const statusCounts = val(settled[2], emptyStatus);
    const graphStats = val(settled[3], { entityCount: 0, relationshipCount: 0, density: 0 });
    const decayDist = val(settled[4], []);
    const orphanEntities = val(settled[5], []);
    const orphanTags = val(settled[6], []);
    const singleUseTags = val(settled[7], []);

    const filteredStats = memoryStats;

    if (opts.json) {
      const totalExtraction =
        statusCounts.pending + statusCounts.complete + statusCounts.failed + statusCounts.skipped;
      console.log(
        JSON.stringify(
          {
            memoryOverview: {
              total: totalCount,
              byAgentCategory: filteredStats,
            },
            extractionHealth: {
              ...statusCounts,
              total: totalExtraction,
              coveragePercent:
                totalExtraction > 0
                  ? Number(((statusCounts.complete / totalExtraction) * 100).toFixed(1))
                  : 0,
            },
            entityGraph: {
              ...graphStats,
              orphanCount: orphanEntities.length,
            },
            tagHealth: {
              orphanCount: orphanTags.length,
              singleUseCount: singleUseTags.length,
            },
            decayDistribution: decayDist,
          },
          null,
          2,
        ),
      );
      return;
    }

    // Uses shared bar() helper defined at module level

    console.log(
      "\n\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557",
    );
    console.log("\u2551           Memory (Neo4j) Health Dashboard                \u2551");
    if (agentId) {
      console.log(`\u2551  Agent: ${agentId.padEnd(49)}\u2551`);
    }
    console.log(
      "\u255A\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255D",
    );

    // Section 1: Memory Overview
    console.log("\n\u250C\u2500 Memory Overview");
    console.log("\u2502");
    console.log(`\u2502  Total: ${totalCount} memories`);

    if (filteredStats.length > 0) {
      // Group by agent
      const byAgent = new Map<
        string,
        Array<{ category: string; count: number; avgImportance: number }>
      >();
      for (const row of filteredStats) {
        const list = byAgent.get(row.agentId) || [];
        list.push({
          category: row.category,
          count: row.count,
          avgImportance: row.avgImportance,
        });
        byAgent.set(row.agentId, list);
      }

      for (const [agent, categories] of byAgent) {
        const agentTotal = categories.reduce((s, c) => s + c.count, 0);
        const maxCat = iterMax(categories.map((c) => c.count));
        console.log(`\u2502`);
        console.log(`\u2502  ${agent} (${agentTotal}):`);
        for (const { category, count } of categories) {
          const ratio = maxCat > 0 ? count / maxCat : 0;
          console.log(`\u2502    ${category.padEnd(12)} ${bar(ratio)} ${count}`);
        }
      }
    }
    console.log("\u2514");

    // Section 2: Extraction Health
    const totalExtraction =
      statusCounts.pending + statusCounts.complete + statusCounts.failed + statusCounts.skipped;
    const coveragePct =
      totalExtraction > 0 ? ((statusCounts.complete / totalExtraction) * 100).toFixed(1) : "0.0";

    console.log("\n\u250C\u2500 Extraction Health");
    console.log("\u2502");
    console.log(`\u2502  Coverage: ${coveragePct}% (${statusCounts.complete}/${totalExtraction})`);
    console.log(`\u2502`);
    const statusEntries: Array<[string, number]> = [
      ["pending", statusCounts.pending],
      ["complete", statusCounts.complete],
      ["failed", statusCounts.failed],
      ["skipped", statusCounts.skipped],
    ];
    const maxStatus = iterMax(statusEntries.map(([, c]) => c));
    for (const [label, count] of statusEntries) {
      const ratio = maxStatus > 0 ? count / maxStatus : 0;
      console.log(`\u2502  ${label.padEnd(10)} ${bar(ratio)} ${count}`);
    }
    console.log("\u2514");

    // Section 3: Entity Graph
    console.log("\n\u250C\u2500 Entity Graph");
    console.log("\u2502");
    console.log(`\u2502  Entities:  ${graphStats.entityCount}`);
    console.log(`\u2502  Relationships: ${graphStats.relationshipCount}`);
    console.log(`\u2502  Density:   ${graphStats.density.toFixed(2)} rels/entity`);
    console.log(`\u2502  Orphans:   ${orphanEntities.length}`);
    console.log("\u2514");

    // Section 4: Tag Health
    console.log("\n\u250C\u2500 Tag Health");
    console.log("\u2502");
    console.log(`\u2502  Orphan tags:     ${orphanTags.length}`);
    console.log(`\u2502  Single-use tags: ${singleUseTags.length}`);
    console.log("\u2514");

    // Section 5: Decay Distribution
    console.log("\n\u250C\u2500 Decay Distribution");
    console.log("\u2502");
    if (decayDist.length > 0) {
      const maxDecay = iterMax(decayDist.map((d) => d.count));
      for (const { bucket, count } of decayDist) {
        const ratio = maxDecay > 0 ? count / maxDecay : 0;
        console.log(`\u2502  ${bucket.padEnd(13)} ${bar(ratio)} ${count}`);
      }
    } else {
      console.log("\u2502  No non-core memories found.");
    }
    console.log("\u2514\n");
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

// ── eval ────────────────────────────────────────────────────────────────────

/** Valid ability names for the eval command. */
export const VALID_ABILITIES: MemoryAbility[] = [
  "extraction",
  "temporal",
  "updates",
  "multi-session",
  "abstention",
];

export async function handleEval(
  db: Neo4jMemoryClient,
  embeddings: Embeddings,
  extractionConfig: ExtractionConfig,
  cfg: MemoryNeo4jConfig,
  opts: {
    dataset: string;
    ability?: string;
    case?: string;
    limit?: string;
    k: string;
    format: string;
    output?: string;
    e2e?: boolean;
    judge?: boolean;
    variant: string;
    signalAttribution?: boolean;
    ci?: boolean;
    baseline?: string;
    saveBaseline?: string;
    variantA?: string;
    variantB?: string;
    production?: boolean;
    agentId?: string;
    warmup?: boolean;
    perfRegressionThreshold?: string;
  },
): Promise<void> {
  const validVariants = Object.keys(EVAL_VARIANTS);

  const k = Number.parseInt(opts.k, 10);
  if (Number.isNaN(k) || k < 1) {
    console.error("Error: --k must be a positive integer");
    process.exitCode = 1;
    return;
  }

  const validFormats: EvalOutputFormat[] = ["console", "json", "markdown"];
  if (!validFormats.includes(opts.format as EvalOutputFormat)) {
    console.error(`Error: --format must be one of: ${validFormats.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  if (opts.ability && !VALID_ABILITIES.includes(opts.ability as MemoryAbility)) {
    console.error(`Error: --ability must be one of: ${VALID_ABILITIES.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  if (!validVariants.includes(opts.variant)) {
    console.error(`Error: --variant must be one of: ${validVariants.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  // Validate A/B variant names upfront
  if (opts.variantA && !validVariants.includes(opts.variantA)) {
    console.error(`Error: --variant-a must be one of: ${validVariants.join(", ")}`);
    process.exitCode = 1;
    return;
  }
  if (opts.variantB && !validVariants.includes(opts.variantB)) {
    console.error(`Error: --variant-b must be one of: ${validVariants.join(", ")}`);
    process.exitCode = 1;
    return;
  }
  if ((opts.variantA && !opts.variantB) || (!opts.variantA && opts.variantB)) {
    console.error("Error: --variant-a and --variant-b must be used together");
    process.exitCode = 1;
    return;
  }

  // Inform user if LLM judge is unavailable
  const judgeEnabled = opts.judge !== false && extractionConfig.enabled;
  if (!judgeEnabled && opts.judge !== false) {
    console.warn(
      "Warning: LLM judge disabled (no extraction API key configured). Context completeness metrics will be skipped.",
    );
  }

  const limit = opts.limit ? Number.parseInt(opts.limit, 10) : undefined;
  if (limit !== undefined && (Number.isNaN(limit) || limit < 1)) {
    console.error("Error: --limit must be a positive integer");
    process.exitCode = 1;
    return;
  }

  try {
    // A/B comparison mode
    if (opts.variantA && opts.variantB) {
      const abResult = await runAbComparison(
        db,
        embeddings,
        extractionConfig,
        cfg,
        opts.dataset,
        opts.variantA,
        opts.variantB,
        {
          evalOptions: {
            ability: opts.ability as MemoryAbility | undefined,
            limit,
            k,
            endToEnd: opts.e2e === true && judgeEnabled,
            judgeContext: judgeEnabled,
            signalAttribution: opts.signalAttribution === true,
          },
        },
      );
      reportAbComparison(abResult);
      return;
    }

    // Standard eval mode
    const runOptions = {
      dataset: opts.dataset,
      ability: opts.ability as MemoryAbility | undefined,
      caseId: opts.case,
      limit,
      k,
      format: opts.format as EvalOutputFormat,
      endToEnd: opts.e2e === true && judgeEnabled,
      judgeContext: judgeEnabled,
      outputFile: opts.output,
      variant: opts.variant,
      signalAttribution: opts.signalAttribution === true,
      ciMode: opts.ci === true,
      baselinePath: opts.baseline,
      saveBaselinePath: opts.saveBaseline,
      productionMode: opts.production === true,
      agentId: opts.agentId,
      warmup: opts.warmup === true,
      perfRegressionThreshold: opts.perfRegressionThreshold
        ? Number.parseFloat(opts.perfRegressionThreshold)
        : undefined,
    };

    await runEval(db, embeddings, extractionConfig, cfg, runOptions);
  } catch (err) {
    console.error(`\nEval failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
