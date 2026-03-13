import type { ExtractionConfig } from "./config.js";
import { sanitizeMemoryText, stripCodeFences } from "./extractor.js";
import { callLlm } from "./llm-client.js";

export type TaskSignal = {
  kind: "new_task" | "task_update" | "task_complete";
  title: string;
  details?: string;
  currentStep?: string;
  completedTaskId?: string;
};

export type DetectTaskSignalsResult = {
  signals: TaskSignal[];
  skipped: boolean;
};

const TASK_DETECTION_SYSTEM = `You detect task-tracking signals from assistant replies for TASKS.md.

Return JSON only:
{
  "signals": [
    {
      "kind": "new_task" | "task_update" | "task_complete",
      "title": "short task title",
      "details": "optional detail",
      "currentStep": "optional current step",
      "completedTaskId": "optional TASK-NNN when explicitly mentioned"
    }
  ]
}

Rules:
- new_task: the assistant commits to doing something new or starts a new work item
- task_update: the assistant reports progress on existing work
- task_complete: the assistant says the work is completed and delivers the result
- Return {"signals": []} for heartbeat messages, NO_REPLY, greetings, acknowledgements, simple factual answers, or anything that should not create/update a task
- Titles must be action-oriented, short, and under 60 characters
- details and currentStep should be concise summaries
- Only emit task_complete when completion is clear, not just "almost done"
- Prefer zero signals when uncertain`;

const ACK_PATTERN =
  /^(ok|okay|sure|thanks|thank you|got it|on it|will do|sounds good|done|noted|yep|nope|cool|great)[.!?]*$/i;
const GREETING_PATTERN = /^(hi|hello|hey|good morning|good afternoon|good evening)[.!?]*$/i;
const SYSTEM_MARKUP_PATTERN = /^(HEARTBEAT_OK|NO_REPLY)$/im;

function shouldSkipTaskDetection(text: string): boolean {
  const trimmed = text.trim();
  // Skip short texts — task signals require enough context for meaningful detection
  if (!trimmed || trimmed.length < 100) {
    return true;
  }
  if (SYSTEM_MARKUP_PATTERN.test(trimmed)) {
    return true;
  }

  const lines = trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length !== 1) {
    return false;
  }

  return ACK_PATTERN.test(lines[0]) || GREETING_PATTERN.test(lines[0]);
}

function normalizeTaskSignal(raw: unknown): TaskSignal | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const signal = raw as Record<string, unknown>;
  const kind = signal.kind;
  const title = typeof signal.title === "string" ? signal.title.trim().slice(0, 60) : "";

  if (
    (kind !== "new_task" && kind !== "task_update" && kind !== "task_complete") ||
    title.length === 0
  ) {
    return null;
  }

  return {
    kind,
    title,
    details: typeof signal.details === "string" ? signal.details.trim() : undefined,
    currentStep: typeof signal.currentStep === "string" ? signal.currentStep.trim() : undefined,
    completedTaskId:
      typeof signal.completedTaskId === "string" ? signal.completedTaskId.trim() : undefined,
  };
}

export async function detectTaskSignals(
  assistantText: string,
  config: ExtractionConfig,
  signal?: AbortSignal,
): Promise<DetectTaskSignalsResult> {
  if (!config.enabled || shouldSkipTaskDetection(assistantText)) {
    return { signals: [], skipped: true };
  }

  try {
    const content = await callLlm(
      config,
      [
        { role: "system", content: TASK_DETECTION_SYSTEM },
        { role: "user", content: sanitizeMemoryText(assistantText) },
      ],
      signal,
    );
    if (!content) {
      return { signals: [], skipped: false };
    }

    const parsed = JSON.parse(stripCodeFences(content)) as { signals?: unknown };
    const signals = Array.isArray(parsed.signals)
      ? parsed.signals
          .map(normalizeTaskSignal)
          .filter((entry): entry is TaskSignal => entry !== null)
      : [];
    return { signals, skipped: false };
  } catch {
    return { signals: [], skipped: false };
  }
}
