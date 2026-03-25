/**
 * LongMemEval dataset adapter for the eval harness.
 *
 * Downloads and converts the LongMemEval dataset from HuggingFace into
 * the eval harness TestCase format. Each chat session becomes a batch of
 * memories, and each Q&A pair becomes a test case.
 *
 * Dataset: https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned
 *
 * NOTE: This is a stub implementation for Phase 2. The adapter downloads
 * the dataset on first use and caches it locally at ~/.openclaw/eval-cache/.
 */

import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { MemoryAbility, TestCase } from "../types.js";

const DATASET_URL =
  "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json";

const CACHE_DIR = join(homedir(), ".openclaw", "eval-cache");
const CACHE_FILE = join(CACHE_DIR, "longmemeval_s_cleaned.json");

export type LongMemEvalOptions = {
  ability?: MemoryAbility;
  /** Max test cases to load. Default: 500 (all). */
  limit?: number;
  /** If true, force re-download even if cached. */
  forceDownload?: boolean;
};

/** Raw LongMemEval record structure. */
type LongMemEvalRecord = {
  question_id?: string;
  question?: string;
  answer?: string;
  ability?: string;
  sessions?: Array<{
    session_id?: string;
    turns?: Array<{
      role?: string;
      content?: string;
      timestamp?: string;
    }>;
  }>;
};

/**
 * Load LongMemEval dataset, downloading from HuggingFace if not cached.
 *
 * Converts each Q&A record into a TestCase with:
 * - memories: all assistant/user turns across sessions as individual memories
 * - question: the benchmark question
 * - golden_answer: the benchmark answer
 * - gold_memory_ids: empty (LongMemEval doesn't provide gold memory IDs;
 *   context completeness via LLM judge is used instead)
 */
export async function loadLongMemEvalDataset(opts: LongMemEvalOptions = {}): Promise<TestCase[]> {
  const raw = await ensureDatasetCached(opts.forceDownload);
  const records = parseDataset(raw);
  const cases = convertToCases(records, opts.ability);

  if (opts.limit && opts.limit > 0) {
    return cases.slice(0, opts.limit);
  }
  return cases;
}

/** Download and cache the dataset, returning raw JSON string. */
async function ensureDatasetCached(force?: boolean): Promise<string> {
  if (!force && existsSync(CACHE_FILE)) {
    return readFile(CACHE_FILE, "utf-8");
  }

  mkdirSync(CACHE_DIR, { recursive: true });

  const response = await fetch(DATASET_URL, {
    signal: AbortSignal.timeout(120_000), // 2 minute download timeout
  });

  if (!response.ok) {
    throw new Error(
      `Failed to download LongMemEval dataset: HTTP ${response.status}. ` +
        `Check your internet connection or download manually to ${CACHE_FILE}`,
    );
  }

  if (!response.body) {
    throw new Error("No response body for LongMemEval dataset download");
  }

  // Stream to cache file — Node 18+ ReadableStream is compatible with pipeline
  const writeStream = createWriteStream(CACHE_FILE);
  await pipeline(response.body as unknown as NodeJS.ReadableStream, writeStream);

  return readFile(CACHE_FILE, "utf-8");
}

/** Parse the raw JSON dataset into records. */
function parseDataset(raw: string): LongMemEvalRecord[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed as LongMemEvalRecord[];
    }
    // Some HuggingFace datasets are wrapped in { data: [...] }
    if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray((parsed as Record<string, unknown>).data)
    ) {
      return (parsed as Record<string, unknown[]>).data as LongMemEvalRecord[];
    }
    throw new Error("Unexpected LongMemEval dataset format — expected array or { data: array }");
  } catch (err) {
    throw new Error(
      `Failed to parse LongMemEval dataset: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Map LongMemEval ability strings to our MemoryAbility type. */
function mapAbility(raw: string | undefined): MemoryAbility {
  const map: Record<string, MemoryAbility> = {
    "information-extraction": "extraction",
    "temporal-reasoning": "temporal",
    "knowledge-update": "updates",
    "multi-session-reasoning": "multi-session",
    abstention: "abstention",
  };
  return map[raw ?? ""] ?? "extraction";
}

/** Convert LongMemEval records to eval harness TestCase format. */
function convertToCases(records: LongMemEvalRecord[], filterAbility?: MemoryAbility): TestCase[] {
  const cases: TestCase[] = [];

  for (const record of records) {
    if (!record.question || !record.answer) {
      continue;
    }

    const ability = mapAbility(record.ability);
    if (filterAbility && ability !== filterAbility) {
      continue;
    }

    const caseId = `lme-${record.question_id ?? cases.length.toString().padStart(4, "0")}`;

    // Build memories from all session turns
    const memories = buildMemoriesFromSessions(record.sessions ?? [], caseId);

    cases.push({
      id: caseId,
      ability,
      memories,
      question: record.question,
      golden_answer: record.answer,
      // LongMemEval doesn't specify which memories are gold — use LLM judge for context completeness
      gold_memory_ids: [],
      metadata: {
        difficulty: "medium",
        notes: "LongMemEval benchmark — retrieval metrics use LLM judge only",
      },
    });
  }

  return cases;
}

/**
 * Convert session turns into individual memories.
 * Each substantive turn becomes a memory with the session key set.
 */
function buildMemoriesFromSessions(
  sessions: LongMemEvalRecord["sessions"],
  caseId: string,
): TestCase["memories"] {
  const memories: TestCase["memories"] = [];

  for (const session of sessions ?? []) {
    const sessionKey = session.session_id ?? `${caseId}-session-${memories.length}`;

    for (let i = 0; i < (session.turns ?? []).length; i++) {
      const turn = (session.turns ?? [])[i];
      const content = turn.content?.trim();

      // Skip empty turns and very short system messages
      if (!content || content.length < 20) {
        continue;
      }

      const memoryId = `${caseId}-s${session.session_id ?? "0"}-t${i}`;
      memories.push({
        id: memoryId,
        text: content,
        category: turn.role === "user" ? "fact" : "other",
        importance: 0.6,
        sessionKey,
        createdAt: turn.timestamp,
      });
    }
  }

  return memories;
}
