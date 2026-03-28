/**
 * CLI command registration for memory-neo4j.
 *
 * Registers the `openclaw memory neo4j` subcommand group with commands:
 * - list: List memory counts by agent and category
 * - search: Search memories via hybrid search
 * - stats: Show memory statistics and configuration
 * - sleep: Run sleep cycle (six-phase memory consolidation)
 * - index: Re-embed all memories after changing embedding model
 * - cleanup: Retroactively apply attention gate to stored memories
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/memory-neo4j";
import {
  handleCleanup,
  handleEval,
  handleHealth,
  handleIndex,
  handleList,
  handleSearch,
  handleSleep,
  handleStats,
  handleSupersede,
  VALID_ABILITIES,
} from "./cli-commands.js";
import type { ExtractionConfig, MemoryNeo4jConfig } from "./config.js";
import type { Embeddings } from "./embeddings.js";
import { EVAL_VARIANTS } from "./eval/variants.js";
import { metrics } from "./metrics.js";
import type { Neo4jMemoryClient } from "./neo4j-client.js";

export type CliDeps = {
  db: Neo4jMemoryClient;
  embeddings: Embeddings;
  cfg: MemoryNeo4jConfig;
  extractionConfig: ExtractionConfig;
  vectorDim: number;
};

/**
 * Register the `openclaw memory neo4j` CLI subcommand group.
 */
export function registerCli(api: OpenClawPluginApi, deps: CliDeps): void {
  const { db, embeddings, cfg, extractionConfig, vectorDim } = deps;

  api.registerCli(
    ({ program }) => {
      // Find existing memory command or create fallback
      let memoryCmd = program.commands.find((cmd) => cmd.name() === "memory");
      if (!memoryCmd) {
        // Fallback if core memory CLI not registered yet
        memoryCmd = program.command("memory").description("Memory commands");
      }

      // Add neo4j memory subcommand group
      const memory = memoryCmd.command("neo4j").description("Neo4j graph memory commands");

      memory
        .command("list")
        .description("List memories grouped by agent and category")
        .option("--agent <id>", "Filter by agent id")
        .option("--category <name>", "Filter by category")
        .option("--limit <n>", "Max memories per category (default: 20)")
        .option("--json", "Output as JSON")
        .action(
          async (opts: { agent?: string; category?: string; limit?: string; json?: boolean }) => {
            await handleList(db, opts);
          },
        );

      memory
        .command("search")
        .description("Search memories")
        .argument("<query>", "Search query")
        .option("--limit <n>", "Max results", "5")
        .option("--agent <id>", "Agent id (default: default)")
        .option("--include-expired", "Include superseded/expired memories in results")
        .action(
          async (
            query: string,
            opts: { limit: string; agent?: string; includeExpired?: boolean },
          ) => {
            await handleSearch(db, embeddings, extractionConfig, cfg, query, opts);
          },
        );

      memory
        .command("supersede")
        .description("Mark an existing memory as superseded by a newer one")
        .argument("<old-id>", "ID of the memory to supersede")
        .argument("<new-id>", "ID of the memory that replaces it")
        .action(async (oldId: string, newId: string) => {
          await handleSupersede(db, oldId, newId);
        });

      memory
        .command("stats")
        .description("Show memory statistics and configuration")
        .option("--agent <id>", "Filter statistics to a specific agent")
        .action(async (opts: { agent?: string }) => {
          await handleStats(db, cfg, extractionConfig, opts);
        });

      memory
        .command("sleep")
        .description("Run sleep cycle — consolidate memories")
        .option("--agent <id>", "Agent id (default: all agents)")
        .option("--dedup-threshold <n>", "Vector similarity threshold for dedup (default: 0.95)")
        .option("--decay-threshold <n>", "Decay score threshold for pruning (default: 0.1)")
        .option("--decay-half-life <days>", "Base half-life in days (default: 30)")
        .option("--batch-size <n>", "Extraction batch size (default: 50)")
        .option("--delay <ms>", "Delay between extraction batches in ms (default: 1000)")
        .option("--max-semantic-pairs <n>", "Max LLM-checked semantic dedup pairs (default: 500)")
        .option("--concurrency <n>", "Parallel LLM calls — match OLLAMA_NUM_PARALLEL (default: 8)")
        .option(
          "--skip-semantic",
          "Skip LLM-based semantic dedup (Phase 1b) and conflict detection (Phase 1c)",
        )
        .option("--skip-retroactive-tagging", "Skip retroactive tagging (Phase 2b)")
        .option("--report", "Show quality metrics after sleep cycle completes")
        .action(
          async (opts: {
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
          }) => {
            await handleSleep(db, embeddings, extractionConfig, cfg, api.logger, opts);
          },
        );

      memory
        .command("index")
        .description(
          "Re-embed all memories and entities — use after changing embedding model/provider",
        )
        .option("--batch-size <n>", "Embedding batch size (default: 50)")
        .action(async (opts: { batchSize?: string }) => {
          await handleIndex(db, embeddings, cfg, vectorDim, opts);
        });

      memory
        .command("cleanup")
        .description(
          "Retroactively apply the attention gate — find and remove low-substance memories",
        )
        .option("--execute", "Actually delete (default: dry-run preview)")
        .option("--all", "Include explicitly-stored memories (default: auto-capture only)")
        .option("--agent <id>", "Only clean up memories for a specific agent")
        .action(async (opts: { execute?: boolean; all?: boolean; agent?: string }) => {
          await handleCleanup(db, opts);
        });

      memory
        .command("health")
        .description("Memory system health dashboard")
        .option("--agent <id>", "Scope to a specific agent")
        .option("--json", "Output all sections as JSON")
        .action(async (opts: { agent?: string; json?: boolean }) => {
          await handleHealth(db, opts);
        });

      memory
        .command("metrics")
        .description("Show in-process metrics snapshot (capture rates, dedup, phase timings)")
        .action(() => {
          console.log(JSON.stringify(metrics.snapshot(), null, 2));
        });

      const validVariants = Object.keys(EVAL_VARIANTS);

      memory
        .command("eval")
        .description("Run retrieval evaluation against custom fixtures or LongMemEval benchmark")
        .option(
          "--dataset <name>",
          'Dataset to evaluate: "custom", "longmemeval_s", "locomo", "hybrid", or a single ability name (extraction|temporal|updates|multi-session|abstention)',
          "custom",
        )
        .option(
          "--ability <name>",
          "Filter to a specific ability: extraction|temporal|updates|multi-session|abstention",
        )
        .option("--case <id>", "Run specific case ID(s), comma-separated (e.g. ext-009)")
        .option("--limit <n>", "Max test cases to load (useful for quick smoke tests)")
        .option("--k <n>", "Retrieval cutoff K (default: 5)", "5")
        .option(
          "--format <fmt>",
          "Output format: console|json|markdown (default: console)",
          "console",
        )
        .option("--output <path>", "Write output to file (for json/markdown formats)")
        .option("--e2e", "Run end-to-end answer generation and grading (Tier 2)")
        .option("--no-judge", "Skip LLM judge (context completeness will not be evaluated)")
        .option(
          "--variant <name>",
          `Named search config variant (${validVariants.join("|")})`,
          "default",
        )
        .option("--signal-attribution", "Include per-signal attribution stats in results")
        .option("--ci", "CI mode: output flat JSON to stdout, exit 1 on regression")
        .option("--baseline <path>", "Load baseline JSON for regression comparison")
        .option("--save-baseline <path>", "Save current results as new baseline JSON")
        .option("--variant-a <name>", "A/B test: run variant A (requires --variant-b)")
        .option("--variant-b <name>", "A/B test: run variant B and compare against --variant-a")
        .option(
          "--production",
          "Production mode: skip memory ingestion, query existing production memories (agentId=main)",
        )
        .option("--agent-id <id>", "Agent ID to query in production mode (default: main)")
        .option(
          "--warmup",
          "Run queries twice: cold pass then warm pass (cold-start vs steady-state comparison)",
        )
        .option(
          "--perf-regression-threshold <n>",
          "Relative threshold for p95 latency regression (default: 0.20 = 20%)",
        )
        .action(
          async (opts: {
            dataset: string;
            ability?: string;
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
          }) => {
            await handleEval(db, embeddings, extractionConfig, cfg, opts);
          },
        );
    },
    { commands: ["memory neo4j"] },
  );
}
