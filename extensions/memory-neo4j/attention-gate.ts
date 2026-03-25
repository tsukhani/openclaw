/**
 * Attention gate — lightweight heuristic filter (phase 1 of memory pipeline).
 *
 * Rejects obvious noise without any LLM call, analogous to how the brain's
 * sensory gating filters out irrelevant stimuli before they enter working
 * memory. Everything that passes gets stored; the sleep cycle decides what
 * matters.
 */

// Composite noise patterns — grouped by category for debuggability.
// Each category is a single regex tested once instead of N individual patterns.

/** Category 1: Conversational noise — greetings, filler, acks, deictic (full-line anchored) */
const CONVERSATIONAL_NOISE =
  /^(?:(?:hi|hey|hello|yo|sup|ok|okay|sure|thanks|thank you|thx|ty|yep|yup|nope|no|yes|yeah|cool|nice|great|got it|sounds good|perfect|alright|fine|noted|ack|kk|k)\s*[.!?]*$|(?:ok|okay|yes|yeah|yep|sure|no|nope|alright|right|fine|cool|nice|great)\s+(?:great|good|sure|thanks|please|ok|fine|cool|yeah|perfect|noted|absolutely|definitely|exactly)\s*[.!?]*$|(?:ok[,.]?\s+)?(?:i(?:'ll|'m|'d|'ve)?\s+)?(?:just\s+)?(?:need|want|got|have|let|let's|let me|give me|send|do|did|try|check|see|look at|test|take|get|go|use)\s+(?:it|that|this|those|these|them|some|one|the|a|an|me|him|her|us)\s*(?:out|up|now|then|too|again|later|first|here|there|please)?\s*[.!?]*$|(?:ok|okay|yes|yeah|yep|sure|no|nope|right|alright|fine|cool|nice|great|perfect)[,.]?\s+(?!.*TASK-\d).{0,20}$|(?:hmm+|huh|haha|ha|lol|lmao|rofl|nah|meh|idk|brb|ttyl|omg|wow|whoa|welp|oops|ooh|aah|ugh|bleh|pfft|smh|ikr|tbh|imo|fwiw|np|nvm|nm|wut|wat|wha|heh|tsk|sigh|yay|woo+|boo|dang|darn|geez|gosh|sheesh|oof)\s*[.!?]*$)/i;

/** Category 2: Structural — near-empty, XML markup (emoji needs separate `u` flag) */
const STRUCTURAL_NOISE = /(?:^\S{0,3}$|^<[a-z-]+>[\s\S]*<\/[a-z-]+>$)/i;

/** Category 2b: Pure emoji — separate due to `u` flag requirement */
const EMOJI_NOISE = /^[\p{Emoji}\s]+$/u;

/** Category 3: Imperative commands — "let's install X", "yes switch to X", "can you remove X" */
const IMPERATIVE_NOISE =
  /^(?:let'?s\s+(?:completely\s+)?(?:uninstall|install|remove|delete|set up|configure|update|change|switch|replace|move|migrate|upgrade|downgrade|enable|disable|stop|start|restart|revert|rollback|undo|redo|rebuild|refactor|rewrite|clean up|fix|patch|deploy)|(?:ok|okay|yes|yeah|yep|sure|right|alright|go ahead)[,.]?\s+(?:deliver|send|ensure|make sure|use|switch|change|update|move|enable|disable|remove|delete|install|uninstall|set up|configure)|(?:ok[,.]?\s+)?(?:can you|could you|please|go ahead and)\s+(?:completely\s+)?(?:uninstall|install|remove|delete|set up|configure|update|change|switch|replace|move|migrate|upgrade|downgrade|enable|disable|stop|start|restart)|(?:use|switch to|change to|move to|replace with|swap to|go with|try|enable|disable)\s+\S+\s+(?:instead|rather|now|from now on|going forward)?\s*[.!?]*$|A new session was started via)/i;

/** Category 4: Channel metadata — slack/telegram IDs, envelope keys */
const CHANNEL_METADATA_NOISE =
  /(?:\[(?:slack message id|message_id|telegram message id):|^Sender \(untrusted metadata\)|["']?(?:sender_id|chat_id)["']?\s*[:=])/i;

/** Category 5: System infrastructure — heartbeats, cron, gateway, compaction */
const SYSTEM_INFRA_NOISE =
  /(?:Read HEARTBEAT\.md if it exists|^Pre-compaction memory flush|^System:\s*\[|^\[cron:[0-9a-f-]+|^GatewayRestart:\s*\{|^\[\w{3}\s+\d{4}-\d{2}-\d{2}\s.*\]\s*A background task)/i;

/** Category 6: Conversation metadata + cron delivery + subagent reports */
const CRON_META_NOISE =
  /(?:^Conversation info\s*\(|^\[Queued messages|A scheduled reminder has been triggered|Summarize this naturally for the user|Please relay this reminder to the user|^\[.*\d{4}-\d{2}-\d{2}.*\]\s*A sub-?agent task|(\*\*)?🔴\s*(?:URGENT|Priority))/i;

/** Category 7: LLM meta-prompts — scaffolding instructions, not user memories */
const LLM_META_NOISE =
  /(?:^(?:based on (?:this|the) conversation,?\s+)?generate\s+(?:a\s+)?(?:short\s+)?(?:\d[\w-]*\s+)?(?:word\s+)?(?:filename|file name|slug|title|heading|summary|label|caption|tag|keyword|name)\b|^(?:reply|respond|answer|output)\s+(?:with\s+)?only\s+(?:the|a)\s+|^(?:you are|act as|pretend you'?re)\s+(?:a\s+)?(?:filename|slug|title|summary|keyword|tag)\s+generator\b)/i;

/** Category 6b: Multiline patterns (require `m` flag) */
const MULTILINE_NOISE = /(?:^Findings:\s*$|^Stats:\s*runtime\s)/im;

const NOISE_PATTERNS = [
  CONVERSATIONAL_NOISE,
  STRUCTURAL_NOISE,
  EMOJI_NOISE,
  IMPERATIVE_NOISE,
  CHANNEL_METADATA_NOISE,
  SYSTEM_INFRA_NOISE,
  CRON_META_NOISE,
  LLM_META_NOISE,
  MULTILINE_NOISE,
];

/** Maximum message length — code dumps, logs, etc. are not memories. */
const MAX_CAPTURE_CHARS = 2000;

/** Minimum message length — too short to be meaningful. */
const MIN_CAPTURE_CHARS = 30;

/** Minimum word count — short contextual phrases lack standalone meaning. */
const MIN_WORD_COUNT = 8;

/** Shared checks applied by both user and assistant attention gates. */
function failsSharedGateChecks(trimmed: string): boolean {
  // Injected context from the memory system itself
  if (trimmed.includes("<relevant-memories>") || trimmed.includes("<core-memory-refresh>")) {
    return true;
  }

  // Noise patterns
  if (NOISE_PATTERNS.some((r) => r.test(trimmed))) {
    return true;
  }

  // Excessive emoji (likely reaction, not substance)
  const emojiCount = (
    trimmed.match(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1FA00}-\u{1FAFF}]/gu) ||
    []
  ).length;
  if (emojiCount > 3) {
    return true;
  }

  return false;
}

/**
 * Returns the (possibly truncated) text if it passes the gate, or null if rejected.
 * Over-length messages are truncated to MAX_CAPTURE_CHARS instead of rejected.
 */
export function passesAttentionGate(text: string): string | null {
  let trimmed = text.trim();

  // Too short — reject
  if (trimmed.length < MIN_CAPTURE_CHARS) {
    return null;
  }

  // Too long — truncate instead of rejecting
  if (trimmed.length > MAX_CAPTURE_CHARS) {
    trimmed = trimmed.slice(0, MAX_CAPTURE_CHARS);
  }

  // Word count — short phrases ("I need those") lack context for recall
  const wordCount = trimmed.split(/\s+/).length;
  if (wordCount < MIN_WORD_COUNT) {
    return null;
  }

  if (failsSharedGateChecks(trimmed)) {
    return null;
  }

  // Passes gate — retain for short-term storage
  return trimmed;
}
