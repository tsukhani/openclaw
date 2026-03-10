/**
 * LoCoMo dataset adapter for the eval harness.
 *
 * Downloads and converts the LoCoMo benchmark (locomo10.json) into
 * the eval harness TestCase format. Each conversation provides a
 * 300–450-turn haystack; each QA pair becomes one test case.
 *
 * Dataset: https://github.com/snap-research/locomo
 *
 * Category → ability mapping:
 *   cat1 → extraction  (single-turn fact retrieval)
 *   cat2 → temporal    (time-anchored questions)
 *   cat3 → skip        (requires external knowledge)
 *   cat4 → graph       (multi-hop entity traversal)
 *   cat5 → abstention  (adversarial; answer not in conversation)
 *
 * Evidence format: "D<session>:<turn>" (1-indexed) maps to the turn
 * whose dia_id field equals that string.
 *
 * Memory IDs: locomo-<sample_id>-turn-<global_idx>
 * Timestamps: turns distributed across 35 weeks from 2024-01-01,
 *             one session per week.
 */

import { existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MemoryAbility, TestCase, TestMemory } from "../types.js";

const DATASET_URL =
  "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json";

const CACHE_DIR = join(homedir(), ".openclaw", "eval-cache");
const CACHE_FILE = join(CACHE_DIR, "locomo10.json");

/** Maps LoCoMo category numbers to eval harness abilities. null = skip. */
const CAT_TO_ABILITY: Record<number, MemoryAbility | null> = {
  1: "extraction",
  2: "temporal",
  3: null, // requires external knowledge — not a memory-retrieval task
  4: "graph",
  5: "abstention",
};

// ── Raw LoCoMo types ──────────────────────────────────────────────────────────

type LoCoMoTurn = {
  speaker: string;
  dia_id: string; // e.g. "D2:5"
  text: string;
};

type LoCoMoQA = {
  question: string;
  answer: string;
  evidence: string[]; // e.g. ["D2:5"] or ["D1:3", "D3:7"]
  category: number;
};

type LoCoMoSample = {
  sample_id: string;
  qa: LoCoMoQA[];
  conversation: Record<string, unknown>;
};

// ── Public API ────────────────────────────────────────────────────────────────

export type LoCoMoOptions = {
  /** Filter to a specific memory ability. */
  ability?: MemoryAbility;
  /** Max test cases to load. */
  limit?: number;
  /** If true, force re-download even if cached. */
  forceDownload?: boolean;
};

/**
 * Load LoCoMo dataset, downloading from GitHub if not cached.
 *
 * Returns one TestCase per QA pair (skipping cat3). Each case shares
 * the full conversation turn list as its memory haystack, giving
 * 300–450 distractor memories per test case for hard retrieval.
 */
export async function loadLoCoMoDataset(opts: LoCoMoOptions = {}): Promise<TestCase[]> {
  const raw = await ensureCached(opts.forceDownload);
  const samples = JSON.parse(raw) as LoCoMoSample[];
  const cases: TestCase[] = [];

  for (const sample of samples) {
    const sampleCases = convertSampleToCases(sample, opts.ability);
    cases.push(...sampleCases);
  }

  if (opts.limit && opts.limit > 0) {
    return cases.slice(0, opts.limit);
  }
  return cases;
}

// ── Conversion helpers ────────────────────────────────────────────────────────

function convertSampleToCases(sample: LoCoMoSample, filterAbility?: MemoryAbility): TestCase[] {
  const conv = sample.conversation as Record<string, unknown>;

  // Collect sessions that have actual turn data (some sessions only have a date entry).
  const sessionKeys = Object.keys(conv)
    .filter((k) => k.startsWith("session_") && !k.endsWith("_date_time") && Array.isArray(conv[k]))
    .sort((a, b) => {
      const na = parseInt(a.replace("session_", ""), 10);
      const nb = parseInt(b.replace("session_", ""), 10);
      return na - nb;
    });

  // Build a flat ordered list of all turns + dia_id→globalIdx lookup map.
  const allTurns: Array<{ turn: LoCoMoTurn; sessionIdx: number; globalIdx: number }> = [];
  const diaToGlobal = new Map<string, number>();

  let globalIdx = 0;
  for (let si = 0; si < sessionKeys.length; si++) {
    const turns = conv[sessionKeys[si]] as LoCoMoTurn[];
    for (const turn of turns) {
      allTurns.push({ turn, sessionIdx: si, globalIdx });
      diaToGlobal.set(turn.dia_id, globalIdx);
      globalIdx++;
    }
  }

  // Build memories once — shared haystack for all QA cases in this sample.
  const memories = buildMemories(sample.sample_id, allTurns, sessionKeys.length);

  const cases: TestCase[] = [];

  for (let qi = 0; qi < sample.qa.length; qi++) {
    const qa = sample.qa[qi];
    const ability = CAT_TO_ABILITY[qa.category];
    if (ability === null) continue; // skip cat3
    if (filterAbility && ability !== filterAbility) continue;

    // For abstention cases the model must recognise the answer is absent.
    const goldMemoryIds: string[] =
      ability === "abstention"
        ? []
        : qa.evidence
            .map((ev) => {
              const idx = diaToGlobal.get(ev);
              return idx !== undefined ? `locomo-${sample.sample_id}-turn-${idx}` : null;
            })
            .filter((id): id is string => id !== null);

    cases.push({
      id: `locomo-${sample.sample_id}-qa-${qi}`,
      ability,
      memories,
      question: qa.question,
      golden_answer: qa.answer,
      gold_memory_ids: goldMemoryIds,
      metadata: {
        difficulty: "hard",
        notes: `LoCoMo cat${qa.category}, evidence=${qa.evidence.join(",")}`,
      },
    });
  }

  return cases;
}

/**
 * Convert the flat turn list into TestMemory entries.
 *
 * Timestamps are spread across 35 weeks from 2024-01-01,
 * one session per week, to produce realistic temporal variance.
 */
function buildMemories(
  sampleId: string,
  allTurns: Array<{ turn: LoCoMoTurn; sessionIdx: number; globalIdx: number }>,
  _sessionCount: number,
): TestMemory[] {
  const baseMs = new Date("2024-01-01T00:00:00Z").getTime();
  const weekMs = 7 * 24 * 60 * 60 * 1000;

  return allTurns.map(({ turn, sessionIdx, globalIdx }) => ({
    id: `locomo-${sampleId}-turn-${globalIdx}`,
    text: `${turn.speaker}: ${turn.text}`,
    category: "fact",
    importance: 0.6,
    sessionKey: `${sampleId}-session-${sessionIdx + 1}`,
    createdAt: new Date(baseMs + sessionIdx * weekMs).toISOString(),
  }));
}

// ── Cache helpers ─────────────────────────────────────────────────────────────

async function ensureCached(force?: boolean): Promise<string> {
  if (!force && existsSync(CACHE_FILE)) {
    return readFile(CACHE_FILE, "utf-8");
  }

  mkdirSync(CACHE_DIR, { recursive: true });

  const response = await fetch(DATASET_URL, {
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to download LoCoMo dataset: HTTP ${response.status}. ` +
        `Check your internet connection or download manually to ${CACHE_FILE}`,
    );
  }

  const raw = await response.text();
  await writeFile(CACHE_FILE, raw, "utf-8");
  return raw;
}
