/**
 * OpenClaw Memory (LanceDB) Plugin
 *
 * Long-term memory with vector search for AI conversations.
 * Uses LanceDB for storage and OpenAI for embeddings.
 * Provides seamless auto-recall and auto-capture via lifecycle hooks.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import * as lancedb from "@lancedb/lancedb";
import { Type } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import { stringEnum } from "openclaw/plugin-sdk";
import {
  MEMORY_CATEGORIES,
  type AutoCaptureConfig,
  type MemoryCategory,
  memoryConfigSchema,
  vectorDimsForModel,
} from "./config.js";

// ============================================================================
// Types
// ============================================================================

type MemoryEntry = {
  id: string;
  text: string;
  vector: number[];
  importance: number;
  category: MemoryCategory;
  agent_id: string;
  createdAt: number;
};

type MemorySearchResult = {
  entry: MemoryEntry;
  score: number;
};

// ============================================================================
// LanceDB Provider
// ============================================================================

const TABLE_NAME = "memories";

class MemoryDB {
  private db: lancedb.Connection | null = null;
  private table: lancedb.Table | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(
    private readonly dbPath: string,
    private readonly vectorDim: number,
  ) {}

  private async ensureInitialized(): Promise<void> {
    if (this.table) {
      return;
    }
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this.doInitialize();
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    this.db = await lancedb.connect(this.dbPath);
    const tables = await this.db.tableNames();

    if (tables.includes(TABLE_NAME)) {
      this.table = await this.db.openTable(TABLE_NAME);
      // Migrate: add agent_id column if missing (existing rows get "main")
      await this.migrateAgentId();
    } else {
      this.table = await this.db.createTable(TABLE_NAME, [
        {
          id: "__schema__",
          text: "",
          vector: Array.from({ length: this.vectorDim }).fill(0),
          importance: 0,
          category: "other",
          agent_id: "main",
          createdAt: 0,
        },
      ]);
      await this.table.delete('id = "__schema__"');
    }
  }

  private async migrateAgentId(): Promise<void> {
    try {
      const sample = await this.table!.query().limit(1).toArray();
      if (sample.length > 0 && !("agent_id" in sample[0])) {
        await this.table!.addColumns([{ name: "agent_id", valueSql: "'main'" }]);
      }
    } catch {
      // If check fails, try adding column anyway (idempotent)
      try {
        await this.table!.addColumns([{ name: "agent_id", valueSql: "'main'" }]);
      } catch {
        // Column already exists — safe to ignore
      }
    }
  }

  async store(entry: Omit<MemoryEntry, "id" | "createdAt">): Promise<MemoryEntry> {
    await this.ensureInitialized();

    const fullEntry: MemoryEntry = {
      ...entry,
      id: randomUUID(),
      createdAt: Date.now(),
    };

    await this.table!.add([fullEntry]);
    return fullEntry;
  }

  async search(vector: number[], limit = 5, minScore = 0.5, agentId?: string): Promise<MemorySearchResult[]> {
    await this.ensureInitialized();

    let query = this.table!.vectorSearch(vector);
    if (agentId) {
      query = query.where(`agent_id = '${agentId}'`);
    }
    const results = await query.limit(limit).toArray();

    // LanceDB uses L2 distance by default; convert to similarity score
    const mapped = results.map((row) => {
      const distance = row._distance ?? 0;
      // Use inverse for a 0-1 range: sim = 1 / (1 + d)
      const score = 1 / (1 + distance);
      return {
        entry: {
          id: row.id as string,
          text: row.text as string,
          vector: row.vector as number[],
          importance: row.importance as number,
          category: row.category as MemoryEntry["category"],
          agent_id: (row.agent_id as string) ?? "main",
          createdAt: row.createdAt as number,
        },
        score,
      };
    });

    return mapped.filter((r) => r.score >= minScore);
  }

  async delete(id: string): Promise<boolean> {
    await this.ensureInitialized();
    // Validate UUID format to prevent injection
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(id)) {
      throw new Error(`Invalid memory ID format: ${id}`);
    }
    await this.table!.delete(`id = '${id}'`);
    return true;
  }

  async listByCategory(
    category: string,
    limit = 50,
    minImportance = 0,
    agentId?: string,
  ): Promise<MemoryEntry[]> {
    await this.ensureInitialized();
    const conditions: string[] = [`category = '${category}'`];
    if (minImportance > 0) {
      conditions.push(`importance >= ${minImportance}`);
    }
    if (agentId) {
      conditions.push(`agent_id = '${agentId}'`);
    }
    const filter = conditions.join(" AND ");
    const results = await this.table!.query().where(filter).limit(limit).toArray();
    return results.map((row) => ({
      id: row.id as string,
      text: row.text as string,
      vector: row.vector as number[],
      importance: row.importance as number,
      category: row.category as MemoryEntry["category"],
      agent_id: (row.agent_id as string) ?? "main",
      createdAt: row.createdAt as number,
    }));
  }

  async count(agentId?: string): Promise<number> {
    await this.ensureInitialized();
    if (agentId) {
      const rows = await this.table!.query().where(`agent_id = '${agentId}'`).toArray();
      return rows.length;
    }
    return this.table!.countRows();
  }
}

// ============================================================================
// OpenAI Embeddings
// ============================================================================

class Embeddings {
  private client: OpenAI;

  constructor(
    apiKey: string,
    private model: string,
  ) {
    this.client = new OpenAI({ apiKey });
  }

  async embed(text: string): Promise<number[]> {
    const response = await this.client.embeddings.create({
      model: this.model,
      input: text,
    });
    return response.data[0].embedding;
  }
}

// ============================================================================
// LLM-based memory extraction
// ============================================================================

const EXTRACTION_PROMPT = `You are a memory extraction system for a personal AI assistant. Extract durable knowledge worth remembering across sessions — things useful weeks or months from now.

Be selective. Most exchanges contain nothing new worth storing. Return [] when there's nothing.

EXTRACT:
- Personal facts: names, birthdays, addresses, family, relationships, preferences
- Contact info: phone numbers, emails, addresses
- Decisions and agreements: what was decided, chosen, or approved
- Work outcomes: what was built, fixed, configured, deployed (the WHAT, not the HOW)
- Business info: clients, contracts, deals, deadlines, new contacts
- New people/organizations with identifying details
- Lessons learned: gotchas, pitfalls, things that broke and why

DO NOT EXTRACT:
- Step-by-step process details (commands run, files read, debugging steps)
- Conversation mechanics ("let me check", "here's what I found", "on it!")
- Raw tool/command output or data dumps
- Transient status ("working on X", "downloading...", "almost done")
- Greetings, acknowledgments, small talk
- Information that merely REPEATS what's already in the conversation context
- Implementation minutiae (variable names, line numbers, exact code changes)

DISTILLATION RULE: When technical work was done, capture the OUTCOME in one clean sentence, not the process. Example: "Implemented LLM-based auto-capture for memory plugin using Gemini Flash via OpenRouter" — NOT "Changed line 540 in index.ts to call OpenAI API with extraction prompt".

For each memory:
- text: Clean, distilled statement. 30-250 chars. Third person for user facts, neutral for work outcomes.
- category: preference | fact | decision | entity | other
- importance: 0.5-1.0 (0.9+ critical personal info, 0.8 decisions/outcomes, 0.7 useful facts, 0.5 nice-to-know)

Respond with ONLY a JSON array. Empty array [] if nothing worth storing.`;

type ExtractedMemory = {
  text: string;
  category: MemoryCategory;
  importance: number;
};

class MemoryExtractor {
  private client: OpenAI;
  private model: string;

  constructor(config: AutoCaptureConfig, fallbackApiKey?: string) {
    const provider = config.provider ?? "openrouter";
    const apiKey = config.apiKey ?? fallbackApiKey;
    if (!apiKey) {
      throw new Error("autoCapture requires an API key (set autoCapture.apiKey or use OpenRouter provider config)");
    }

    const baseURL =
      config.baseUrl ??
      (provider === "openrouter"
        ? "https://openrouter.ai/api/v1"
        : "https://api.openai.com/v1");

    this.model = config.model ?? "google/gemini-2.0-flash-001";
    this.client = new OpenAI({ apiKey, baseURL });
  }

  async extract(messages: Array<{ role: string; content: string }>): Promise<ExtractedMemory[]> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: "system", content: EXTRACTION_PROMPT },
        ...messages.map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
        {
          role: "user",
          content:
            "Based on the conversation above, extract any memories worth storing. Respond with ONLY a JSON array (no markdown, no explanation).",
        },
      ],
      temperature: 0,
      max_tokens: 1024,
    });

    const raw = response.choices?.[0]?.message?.content?.trim();
    if (!raw) return [];

    try {
      // Strip markdown code fences if present
      const cleaned = raw.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");
      const parsed = JSON.parse(cleaned);
      if (!Array.isArray(parsed)) return [];

      // Validate and normalize each entry
      return parsed
        .filter(
          (m: unknown): m is ExtractedMemory =>
            !!m &&
            typeof m === "object" &&
            typeof (m as Record<string, unknown>).text === "string" &&
            (m as Record<string, unknown>).text !== "",
        )
        .map((m) => ({
          text: String(m.text).slice(0, 500),
          category: MEMORY_CATEGORIES.includes(m.category as MemoryCategory)
            ? (m.category as MemoryCategory)
            : ("fact" as MemoryCategory),
          importance: typeof m.importance === "number" ? Math.min(1, Math.max(0, m.importance)) : 0.7,
        }))
        .slice(0, 5); // Max 5 memories per turn
    } catch {
      return [];
    }
  }
}

// ============================================================================
// Plugin Definition
// ============================================================================

const memoryPlugin = {
  id: "memory-lancedb",
  name: "Memory (LanceDB)",
  description: "LanceDB-backed long-term memory with auto-recall/capture",
  kind: "memory" as const,
  configSchema: memoryConfigSchema,

  register(api: OpenClawPluginApi) {
    const cfg = memoryConfigSchema.parse(api.pluginConfig);
    const resolvedDbPath = api.resolvePath(cfg.dbPath!);
    const vectorDim = vectorDimsForModel(cfg.embedding.model ?? "text-embedding-3-small");
    const db = new MemoryDB(resolvedDbPath, vectorDim);
    const embeddings = new Embeddings(cfg.embedding.apiKey, cfg.embedding.model!);

    // Resolve autoCapture config
    const autoCaptureConfig: AutoCaptureConfig | false =
      cfg.autoCapture === false
        ? false
        : cfg.autoCapture === true
          ? { enabled: true }
          : (cfg.autoCapture as AutoCaptureConfig);

    // Initialize LLM extractor for auto-capture
    let extractor: MemoryExtractor | null = null;
    if (autoCaptureConfig && autoCaptureConfig.enabled) {
      try {
        // Try to get OpenRouter API key from provider config as fallback
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const orKey = (api.config as any)?.models?.providers?.openrouter?.apiKey as
          | string
          | undefined;

        extractor = new MemoryExtractor(autoCaptureConfig, orKey);
        api.logger.info(
          `memory-lancedb: LLM extractor initialized (model: ${autoCaptureConfig.model ?? "google/gemini-2.0-flash-001"})`,
        );
      } catch (err) {
        api.logger.warn(`memory-lancedb: LLM extractor init failed: ${String(err)}`);
        api.logger.warn("memory-lancedb: auto-capture disabled (no LLM available)");
      }
    }

    api.logger.info(`memory-lancedb: plugin registered (db: ${resolvedDbPath}, lazy init)`);

    // ========================================================================
    // Tools
    // ========================================================================

    api.registerTool(
      (ctx) => ({
        name: "memory_recall",
        label: "Memory Recall",
        description:
          "Search through long-term memories. Use when you need context about user preferences, past decisions, or previously discussed topics.",
        parameters: Type.Object({
          query: Type.String({ description: "Search query" }),
          limit: Type.Optional(Type.Number({ description: "Max results (default: 5)" })),
        }),
        async execute(_toolCallId, params) {
          const agentId = ctx.agentId ?? "main";
          const { query, limit = 5 } = params as { query: string; limit?: number };

          const vector = await embeddings.embed(query);
          const results = await db.search(vector, limit, 0.1, agentId);

          if (results.length === 0) {
            return {
              content: [{ type: "text", text: "No relevant memories found." }],
              details: { count: 0 },
            };
          }

          const text = results
            .map(
              (r, i) =>
                `${i + 1}. [${r.entry.category}] ${r.entry.text} (${(r.score * 100).toFixed(0)}%)`,
            )
            .join("\n");

          // Strip vector data for serialization (typed arrays can't be cloned)
          const sanitizedResults = results.map((r) => ({
            id: r.entry.id,
            text: r.entry.text,
            category: r.entry.category,
            importance: r.entry.importance,
            score: r.score,
          }));

          return {
            content: [{ type: "text", text: `Found ${results.length} memories:\n\n${text}` }],
            details: { count: results.length, memories: sanitizedResults },
          };
        },
      }),
      { name: "memory_recall" },
    );

    api.registerTool(
      (ctx) => ({
        name: "memory_store",
        label: "Memory Store",
        description:
          "Save important information in long-term memory. Use for preferences, facts, decisions. Use category 'core' for persistent essential context loaded at every session start (replaces MEMORY.md).",
        parameters: Type.Object({
          text: Type.String({ description: "Information to remember" }),
          importance: Type.Optional(Type.Number({ description: "Importance 0-1 (default: 0.7)" })),
          category: Type.Optional(stringEnum(MEMORY_CATEGORIES)),
        }),
        async execute(_toolCallId, params) {
          const agentId = ctx.agentId ?? "main";
          const {
            text,
            importance = 0.7,
            category = "other",
          } = params as {
            text: string;
            importance?: number;
            category?: MemoryEntry["category"];
          };

          const vector = await embeddings.embed(text);

          // Check for duplicates within the same agent's namespace
          const existing = await db.search(vector, 1, 0.95, agentId);
          if (existing.length > 0) {
            return {
              content: [
                {
                  type: "text",
                  text: `Similar memory already exists: "${existing[0].entry.text}"`,
                },
              ],
              details: {
                action: "duplicate",
                existingId: existing[0].entry.id,
                existingText: existing[0].entry.text,
              },
            };
          }

          const entry = await db.store({
            text,
            vector,
            importance,
            category,
            agent_id: agentId,
          });

          return {
            content: [{ type: "text", text: `Stored: "${text.slice(0, 100)}..."` }],
            details: { action: "created", id: entry.id },
          };
        },
      }),
      { name: "memory_store" },
    );

    api.registerTool(
      (ctx) => ({
        name: "memory_forget",
        label: "Memory Forget",
        description: "Delete specific memories. GDPR-compliant.",
        parameters: Type.Object({
          query: Type.Optional(Type.String({ description: "Search to find memory" })),
          memoryId: Type.Optional(Type.String({ description: "Specific memory ID" })),
        }),
        async execute(_toolCallId, params) {
          const agentId = ctx.agentId ?? "main";
          const { query, memoryId } = params as { query?: string; memoryId?: string };

          if (memoryId) {
            await db.delete(memoryId);
            return {
              content: [{ type: "text", text: `Memory ${memoryId} forgotten.` }],
              details: { action: "deleted", id: memoryId },
            };
          }

          if (query) {
            const vector = await embeddings.embed(query);
            const results = await db.search(vector, 5, 0.7, agentId);

            if (results.length === 0) {
              return {
                content: [{ type: "text", text: "No matching memories found." }],
                details: { found: 0 },
              };
            }

            if (results.length === 1 && results[0].score > 0.9) {
              await db.delete(results[0].entry.id);
              return {
                content: [{ type: "text", text: `Forgotten: "${results[0].entry.text}"` }],
                details: { action: "deleted", id: results[0].entry.id },
              };
            }

            const list = results
              .map((r) => `- [${r.entry.id.slice(0, 8)}] ${r.entry.text.slice(0, 60)}...`)
              .join("\n");

            // Strip vector data for serialization
            const sanitizedCandidates = results.map((r) => ({
              id: r.entry.id,
              text: r.entry.text,
              category: r.entry.category,
              score: r.score,
            }));

            return {
              content: [
                {
                  type: "text",
                  text: `Found ${results.length} candidates. Specify memoryId:\n${list}`,
                },
              ],
              details: { action: "candidates", candidates: sanitizedCandidates },
            };
          }

          return {
            content: [{ type: "text", text: "Provide query or memoryId." }],
            details: { error: "missing_param" },
          };
        },
      }),
      { name: "memory_forget" },
    );

    // ========================================================================
    // CLI Commands
    // ========================================================================

    api.registerCli(
      ({ program }) => {
        const memory = program.command("ltm").description("LanceDB memory plugin commands");

        memory
          .command("list")
          .description("List memories")
          .action(async () => {
            const count = await db.count();
            console.log(`Total memories: ${count}`);
          });

        memory
          .command("search")
          .description("Search memories")
          .argument("<query>", "Search query")
          .option("--limit <n>", "Max results", "5")
          .action(async (query, opts) => {
            const vector = await embeddings.embed(query);
            const results = await db.search(vector, parseInt(opts.limit), 0.3);
            // Strip vectors for output
            const output = results.map((r) => ({
              id: r.entry.id,
              text: r.entry.text,
              category: r.entry.category,
              importance: r.entry.importance,
              score: r.score,
            }));
            console.log(JSON.stringify(output, null, 2));
          });

        memory
          .command("stats")
          .description("Show memory statistics")
          .action(async () => {
            const count = await db.count();
            console.log(`Total memories: ${count}`);
          });
      },
      { commands: ["ltm"] },
    );

    // ========================================================================
    // Lifecycle Hooks
    // ========================================================================

    // Auto-recall: inject relevant memories before agent starts (scoped by agentId)
    if (cfg.autoRecall) {
      api.on("before_agent_start", async (event, ctx) => {
        if (!event.prompt || event.prompt.length < 5) {
          return;
        }

        try {
          const agentId = ctx.agentId ?? "main";
          const vector = await embeddings.embed(event.prompt);
          const results = await db.search(vector, 3, 0.3, agentId);

          if (results.length === 0) {
            return;
          }

          const memoryContext = results
            .map((r) => `- [${r.entry.category}] ${r.entry.text}`)
            .join("\n");

          api.logger.info?.(`memory-lancedb: injecting ${results.length} memories for agent=${agentId}`);

          return {
            prependContext: `<relevant-memories>\nThe following memories may be relevant to this conversation:\n${memoryContext}\n</relevant-memories>`,
          };
        } catch (err) {
          api.logger.warn(`memory-lancedb: recall failed: ${String(err)}`);
        }
      });
    }

    // Auto-capture: LLM-based memory extraction after agent ends (scoped by agentId)
    if (extractor) {
      const maxMessages = (autoCaptureConfig && typeof autoCaptureConfig === "object" && autoCaptureConfig.maxMessages) || 10;

      api.on("agent_end", async (event, ctx) => {
        if (!event.success || !event.messages || event.messages.length === 0) {
          return;
        }
        const agentId = ctx.agentId ?? "main";

        try {
          // Extract text content from messages into role/content pairs
          const chatMessages: Array<{ role: string; content: string }> = [];
          for (const msg of event.messages) {
            if (!msg || typeof msg !== "object") continue;
            const msgObj = msg as Record<string, unknown>;
            const role = msgObj.role;
            if (role !== "user" && role !== "assistant") continue;

            let text = "";
            const content = msgObj.content;
            if (typeof content === "string") {
              text = content;
            } else if (Array.isArray(content)) {
              const parts: string[] = [];
              for (const block of content) {
                if (
                  block &&
                  typeof block === "object" &&
                  "type" in block &&
                  (block as Record<string, unknown>).type === "text" &&
                  "text" in block &&
                  typeof (block as Record<string, unknown>).text === "string"
                ) {
                  parts.push((block as Record<string, unknown>).text as string);
                }
              }
              text = parts.join("\n");
            }

            if (!text || text.length < 2) continue;

            // Strip injected memory context from user messages
            text = text.replace(/<relevant-memories>[\s\S]*?<\/relevant-memories>\s*/g, "").trim();
            if (!text) continue;

            chatMessages.push({ role: String(role), content: text });
          }

          // Take only the last N messages to limit token usage
          const recent = chatMessages.slice(-maxMessages);
          if (recent.length === 0) return;

          // Call LLM to extract memories
          const extracted = await extractor!.extract(recent);
          if (extracted.length === 0) return;

          // Store each extracted memory with dedup check
          let stored = 0;
          for (const memory of extracted) {
            const vector = await embeddings.embed(memory.text);

            // Check for duplicates within this agent's namespace (0.92 cosine = very similar)
            const existing = await db.search(vector, 1, 0.92, agentId);
            if (existing.length > 0) {
              api.logger.info?.(
                `memory-lancedb: skipping duplicate "${memory.text.slice(0, 60)}..." (similar to "${existing[0].entry.text.slice(0, 60)}...")`,
              );
              continue;
            }

            await db.store({
              text: memory.text,
              vector,
              importance: memory.importance,
              category: memory.category,
              agent_id: agentId,
            });
            stored++;
          }

          if (stored > 0) {
            api.logger.info(`memory-lancedb: auto-captured ${stored} memories via LLM extraction`);
          }
        } catch (err) {
          api.logger.warn(`memory-lancedb: capture failed: ${String(err)}`);
        }
      });
    }

    // ========================================================================
    // Core Memory Hook
    // ========================================================================

    // Inject core memories as virtual MEMORY.md at bootstrap time (scoped by agentId)
    if (cfg.coreMemory?.enabled) {
      api.on("agent_bootstrap", async (event, ctx) => {
        try {
          const agentId = ctx.agentId ?? "main";
          const maxEntries = cfg.coreMemory?.maxEntries ?? 50;
          const minImportance = cfg.coreMemory?.minImportance ?? 0.5;

          // Use category-based query for reliable core memory retrieval, scoped to this agent
          const coreMemories = await db.listByCategory("core", maxEntries, minImportance, agentId);

          if (coreMemories.length === 0) {
            return;
          }

          // Format core memories into a MEMORY.md-style document
          let content = "# Core Memory\n\n";
          content += "*Persistent context loaded from long-term memory*\n\n";
          for (const mem of coreMemories) {
            content += `- ${mem.text}\n`;
          }

          // Find and replace MEMORY.md in the files list, or add it
          const files = [...event.files];
          const memoryIndex = files.findIndex(
            (f) => f.name === "MEMORY.md" || f.name === "memory.md",
          );

          const virtualFile = {
            name: "MEMORY.md" as const,
            path: "memory://lancedb/core-memory",
            content,
            missing: false,
          };

          if (memoryIndex >= 0) {
            files[memoryIndex] = virtualFile;
          } else {
            files.push(virtualFile);
          }

          api.logger.info?.(
            `memory-lancedb: injected ${coreMemories.length} core memories for agent=${agentId}`,
          );

          return { files };
        } catch (err) {
          api.logger.warn(`memory-lancedb: core memory injection failed: ${String(err)}`);
        }
      });
    }

    // ========================================================================
    // Service
    // ========================================================================

    api.registerService({
      id: "memory-lancedb",
      start: () => {
        api.logger.info(
          `memory-lancedb: initialized (db: ${resolvedDbPath}, model: ${cfg.embedding.model})`,
        );
      },
      stop: () => {
        api.logger.info("memory-lancedb: stopped");
      },
    });
  },
};

export default memoryPlugin;
