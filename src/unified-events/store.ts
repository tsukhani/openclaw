/**
 * Unified Event Store — JSONL-backed per-session event persistence with
 * optional in-memory aggregation and query interface.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { EventFilter, EventPage, UnifiedEvent, UnifiedEventKind } from "./types.js";

const DEFAULT_MAX_BYTES = 5_000_000;
const DEFAULT_KEEP_LINES = 5_000;
const DEFAULT_PAGE_LIMIT = 100;

type PruneOptions = {
  maxBytes: number;
  keepLines: number;
};

// Serialized writes per file path to avoid interleaved appends.
const writesByPath = new Map<string, Promise<void>>();

async function drainPendingWrite(filePath: string): Promise<void> {
  const pending = writesByPath.get(path.resolve(filePath));
  if (pending) {
    await pending.catch(() => undefined);
  }
}

async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true, mode: 0o700 });
  await fs.chmod(dirPath, 0o700).catch(() => undefined);
}

async function setSecureFileMode(filePath: string): Promise<void> {
  await fs.chmod(filePath, 0o600).catch(() => undefined);
}

async function pruneIfNeeded(filePath: string, opts: PruneOptions): Promise<void> {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat || stat.size <= opts.maxBytes) {
    return;
  }
  const raw = await fs.readFile(filePath, "utf-8").catch(() => "");
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const kept = lines.slice(Math.max(0, lines.length - opts.keepLines));
  const { randomBytes } = await import("node:crypto");
  const tmp = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  await fs.writeFile(tmp, `${kept.join("\n")}\n`, { encoding: "utf-8", mode: 0o600 });
  await setSecureFileMode(tmp);
  await fs.rename(tmp, filePath);
  await setSecureFileMode(filePath);
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the JSONL event log path for a session.
 *
 * Layout: `<baseDir>/events/<sessionKey>.jsonl`
 *
 * The sessionKey is sanitized to a filesystem-safe form.
 */
export function resolveEventLogPath(baseDir: string, sessionKey: string): string {
  const safe = sessionKey.replace(/[^a-zA-Z0-9_:.-]/g, "_");
  if (!safe) {
    throw new Error("invalid session key for event log path");
  }
  const resolved = path.resolve(baseDir, "events", `${safe}.jsonl`);
  const eventsDir = path.resolve(baseDir, "events");
  if (!resolved.startsWith(`${eventsDir}${path.sep}`)) {
    throw new Error("invalid session key for event log path");
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/** Per-session monotonic ID counters. */
const sessionIdCounters = new Map<string, number>();

function nextEventId(sessionKey: string): number {
  const current = sessionIdCounters.get(sessionKey) ?? 0;
  const next = current + 1;
  sessionIdCounters.set(sessionKey, next);
  return next;
}

/**
 * Distributes `Omit` over each member of a union so discriminated-union
 * properties (e.g. `toolName` on `ToolCallEvent`) remain visible.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type AppendEventInput = DistributiveOmit<UnifiedEvent, "id" | "ts"> & {
  ts?: number;
};

export async function appendEvent(
  baseDir: string,
  input: AppendEventInput,
  opts?: Partial<PruneOptions>,
): Promise<UnifiedEvent> {
  const event: UnifiedEvent = {
    ...input,
    id: nextEventId(input.sessionKey),
    ts: input.ts ?? Date.now(),
  } as UnifiedEvent;

  const filePath = resolveEventLogPath(baseDir, input.sessionKey);
  const resolved = path.resolve(filePath);
  const prev = writesByPath.get(resolved) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(async () => {
      await ensureDir(path.dirname(resolved));
      await fs.appendFile(resolved, `${JSON.stringify(event)}\n`, {
        encoding: "utf-8",
        mode: 0o600,
      });
      await setSecureFileMode(resolved);
      await pruneIfNeeded(resolved, {
        maxBytes: opts?.maxBytes ?? DEFAULT_MAX_BYTES,
        keepLines: opts?.keepLines ?? DEFAULT_KEEP_LINES,
      });
    });
  writesByPath.set(resolved, next);
  try {
    await next;
  } finally {
    if (writesByPath.get(resolved) === next) {
      writesByPath.delete(resolved);
    }
  }

  // Notify listeners.
  for (const listener of eventListeners) {
    try {
      listener(event);
    } catch {
      // Best-effort.
    }
  }

  return event;
}

// ---------------------------------------------------------------------------
// Read / Query
// ---------------------------------------------------------------------------

function parseEventLine(line: string): UnifiedEvent | null {
  if (!line.trim()) {
    return null;
  }
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    if (
      typeof obj.kind !== "string" ||
      typeof obj.id !== "number" ||
      typeof obj.ts !== "number" ||
      typeof obj.sessionKey !== "string"
    ) {
      return null;
    }
    return obj as unknown as UnifiedEvent;
  } catch {
    return null;
  }
}

function matchesFilter(event: UnifiedEvent, filter: EventFilter): boolean {
  if (filter.sessionKey && event.sessionKey !== filter.sessionKey) {
    return false;
  }
  if (filter.kinds && filter.kinds.length > 0 && !filter.kinds.includes(event.kind)) {
    return false;
  }
  if (filter.fromTs !== undefined && event.ts < filter.fromTs) {
    return false;
  }
  if (filter.toTs !== undefined && event.ts > filter.toTs) {
    return false;
  }
  return true;
}

/**
 * Query events from a single session's JSONL log.
 */
export async function queryEvents(
  baseDir: string,
  sessionKey: string,
  filter?: Omit<EventFilter, "sessionKey">,
): Promise<EventPage> {
  const filePath = resolveEventLogPath(baseDir, sessionKey);
  await drainPendingWrite(filePath);

  const raw = await fs.readFile(filePath, "utf-8").catch(() => "");
  const allEvents: UnifiedEvent[] = [];
  for (const line of raw.split("\n")) {
    const event = parseEventLine(line);
    if (event) {
      allEvents.push(event);
    }
  }

  const fullFilter: EventFilter = { ...filter, sessionKey };
  const filtered = allEvents.filter((e) => matchesFilter(e, fullFilter));

  const limit = Math.max(1, Math.min(1000, Math.floor(filter?.limit ?? DEFAULT_PAGE_LIMIT)));
  const offset = Math.max(0, Math.floor(filter?.offset ?? 0));
  const total = filtered.length;
  const page = filtered.slice(offset, offset + limit);

  return {
    events: page,
    total,
    offset,
    limit,
    hasMore: offset + page.length < total,
  };
}

/**
 * Query events across all session logs in a base directory.
 */
export async function queryAllEvents(baseDir: string, filter?: EventFilter): Promise<EventPage> {
  const eventsDir = path.resolve(baseDir, "events");
  const files = await fs.readdir(eventsDir, { withFileTypes: true }).catch(() => []);
  const jsonlFiles = files
    .filter((f) => f.isFile() && f.name.endsWith(".jsonl"))
    .map((f) => path.join(eventsDir, f.name));

  await Promise.all(jsonlFiles.map((f) => drainPendingWrite(f)));

  const allEvents: UnifiedEvent[] = [];
  for (const filePath of jsonlFiles) {
    const raw = await fs.readFile(filePath, "utf-8").catch(() => "");
    for (const line of raw.split("\n")) {
      const event = parseEventLine(line);
      if (event && matchesFilter(event, filter ?? {})) {
        allEvents.push(event);
      }
    }
  }

  // Sort by timestamp ascending.
  allEvents.sort((a, b) => a.ts - b.ts);

  const limit = Math.max(1, Math.min(1000, Math.floor(filter?.limit ?? DEFAULT_PAGE_LIMIT)));
  const offset = Math.max(0, Math.floor(filter?.offset ?? 0));
  const total = allEvents.length;
  const page = allEvents.slice(offset, offset + limit);

  return {
    events: page,
    total,
    offset,
    limit,
    hasMore: offset + page.length < total,
  };
}

// ---------------------------------------------------------------------------
// Listener / integration hook
// ---------------------------------------------------------------------------

type EventListener = (event: UnifiedEvent) => void;
const eventListeners = new Set<EventListener>();

/**
 * Register a listener that is called on every appended event.
 * Returns an unsubscribe function.
 */
export function onEvent(listener: EventListener): () => void {
  eventListeners.add(listener);
  return () => {
    eventListeners.delete(listener);
  };
}

// ---------------------------------------------------------------------------
// Aggregation helpers
// ---------------------------------------------------------------------------

export type EventCountByKind = Partial<Record<UnifiedEventKind, number>>;

export function aggregateByKind(events: UnifiedEvent[]): EventCountByKind {
  const counts: EventCountByKind = {};
  for (const event of events) {
    counts[event.kind] = (counts[event.kind] ?? 0) + 1;
  }
  return counts;
}

export type ToolCallStats = {
  totalCalls: number;
  errorCount: number;
  avgDurationMs: number;
  byTool: Record<string, { count: number; errors: number; totalDurationMs: number }>;
};

export function aggregateToolCalls(events: UnifiedEvent[]): ToolCallStats {
  const stats: ToolCallStats = {
    totalCalls: 0,
    errorCount: 0,
    avgDurationMs: 0,
    byTool: {},
  };
  let totalDuration = 0;

  for (const event of events) {
    if (event.kind !== "tool-call") {
      continue;
    }
    stats.totalCalls += 1;
    totalDuration += event.durationMs;
    const isError = event.result.status === "error";
    if (isError) {
      stats.errorCount += 1;
    }
    const existing = stats.byTool[event.toolName];
    if (existing) {
      existing.count += 1;
      existing.totalDurationMs += event.durationMs;
      if (isError) {
        existing.errors += 1;
      }
    } else {
      stats.byTool[event.toolName] = {
        count: 1,
        errors: isError ? 1 : 0,
        totalDurationMs: event.durationMs,
      };
    }
  }

  stats.avgDurationMs = stats.totalCalls > 0 ? totalDuration / stats.totalCalls : 0;
  return stats;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

export function resetEventIdCountersForTests(): void {
  sessionIdCounters.clear();
}

export function getPendingEventWriteCountForTests(): number {
  return writesByPath.size;
}
