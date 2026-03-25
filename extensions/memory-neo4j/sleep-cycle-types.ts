/**
 * Shared types, interfaces, and credential-detection utilities for the sleep cycle.
 *
 * Extracted from sleep-cycle.ts so that neo4j-client.ts and test files can
 * import CREDENTIAL_PATTERNS / detectCredential without pulling in the full
 * orchestrator and all phase modules.
 */

// ============================================================================
// Result & Options types
// ============================================================================

/**
 * Sleep Cycle Result - aggregated stats from all phases.
 */
export type SleepCycleResult = {
  // Phase 1: Deduplication
  dedup: {
    clustersFound: number;
    memoriesMerged: number;
  };
  // Phase 1b: Conflict Detection
  conflict: {
    pairsFound: number;
    resolved: number;
    invalidated: number;
  };
  // Phase 1c: Semantic Deduplication
  semanticDedup: {
    pairsChecked: number;
    duplicatesMerged: number;
  };
  // Phase 1d: Entity Deduplication
  entityDedup: {
    pairsFound: number;
    merged: number;
  };
  // Phase 2: Entity Extraction
  extraction: {
    total: number;
    processed: number;
    succeeded: number;
    failed: number;
  };
  // Phase 2b: Retroactive Tagging
  retroactiveTagging: {
    total: number;
    tagged: number;
    failed: number;
  };
  // Phase 3: Decay & Pruning
  decay: {
    memoriesPruned: number;
  };
  // Phase 3b: Temporal Staleness
  temporalStaleness: {
    memoriesChecked: number;
    memoriesRemoved: number;
  };
  // Phase 3c: Retroactive Conflict Scan
  retroactiveConflictScan: {
    memoriesScanned: number;
    memoriesSuperseded: number;
  };
  // Phase 3d: Pending Conflict Retry (OP-125)
  pendingConflictRetry: {
    pairsRetried: number;
    resolved: number;
    permanentlySkipped: number;
  };
  // Phase 4: Orphan Cleanup
  cleanup: {
    entitiesRemoved: number;
    tagsRemoved: number;
    singleUseTagsRemoved: number;
  };
  // Phase 5b: Credential Scanning
  credentialScan: {
    memoriesScanned: number;
    credentialsFound: number;
    memoriesRemoved: number;
  };
  // Phase 6: Tip Generation
  tipGeneration: {
    sessionsScanned: number;
    failurePatternsFound: number;
    tipsGenerated: number;
    tipsStored: number;
  };
  // Phase 9: Entity Reclassification
  entityReclassification: {
    entitiesEvaluated: number;
    entitiesReclassified: number;
    failed: number;
  };
  // Phase 9b: Relationship Reclassification
  relationshipReclassification: {
    relationshipsEvaluated: number;
    relationshipsReclassified: number;
    failed: number;
  };
  // Phase 10: Link Creation (OP-182, OP-188)
  linkCreation: {
    semanticLinksCreated: number;
    temporalLinksCreated: number;
    /** CAUSED_BY causal edges created (OP-188). */
    causalLinksCreated: number;
  };
  // Phase 11: Observation Generation (OP-183)
  observationGeneration: {
    entitiesProcessed: number;
    observationsCreated: number;
    observationsUpdated: number;
  };
  // Phase 12: Reflection / Opinion Generation (OP-186, OP-188)
  reflection: {
    entitiesReflected: number;
    opinionsCreated: number;
    opinionsUpdated: number;
    opinionsArchived: number;
    /** Cross-entity generalized opinions (OP-188). */
    opinionsGeneralized: number;
  };
  // Overall
  durationMs: number;
  aborted: boolean;
};

export type SleepCycleOptions = {
  // Common
  agentId?: string;
  abortSignal?: AbortSignal;

  // Phase 1: Deduplication
  dedupThreshold?: number; // Vector similarity threshold (default: 0.95)
  skipSemanticDedup?: boolean; // Skip LLM-based semantic dedup (Phase 1b) and conflict detection (Phase 1c)

  // Phase 1b: Semantic Dedup
  maxSemanticDedupPairs?: number; // Max LLM-checked pairs (default: 500)

  // Phase 1c: Conflict Detection
  conflictDetectionBatchSize?: number; // Max conflict pairs per sleep cycle (default: 50)

  // Concurrency
  llmConcurrency?: number; // Parallel LLM calls (default: 8, match OLLAMA_NUM_PARALLEL)

  // Phase 2: Extraction
  extractionBatchSize?: number; // Memories per batch (default: 50)
  extractionDelayMs?: number; // Delay between batches (default: 1000)

  // Phase 2b: Retroactive Tagging
  skipRetroactiveTagging?: boolean; // Skip retroactive tagging (default: false)
  retroactiveTagBatchSize?: number; // Memories per batch (default: 50)

  // Phase 4: Cleanup
  singleUseTagMinAgeDays?: number; // Min age before single-use tag pruning (default: 14)

  // Phase 3b: Temporal Staleness
  skipTemporalStaleness?: boolean; // Skip temporal staleness detection (default: false)
  temporalStalenessMinAgeDays?: number; // Only check memories older than this (default: 7)

  // Phase 3c: Retroactive Conflict Scan
  skipRetroactiveConflictScan?: boolean; // Skip Phase 3c (default: false)
  retroactiveConflictBatchSize?: number; // Max memories to scan per run (default: 20)
  conflictSimilarityThreshold?: number; // Cosine threshold for candidate selection (default: 0.82)
  conflictMaxCandidates?: number; // Max candidates per memory (default: 5)

  // Phase 3d: Pending Conflict Retry (OP-125)
  skipPendingConflictRetry?: boolean; // Skip Phase 3d (default: false)
  pendingConflictMaxRetries?: number; // Max retry attempts before permanently skipping (default: 3)

  // Phase 3: Decay
  decayRetentionThreshold?: number; // Below this, memory is pruned (default: 0.1)
  decayBaseHalfLifeDays?: number; // Base half-life in days (default: 30)
  decayImportanceMultiplier?: number; // How much importance extends half-life (default: 2)
  decayCurves?: Record<string, { halfLifeDays: number }>; // Per-category decay curve overrides

  // Phase 6: Tip Generation
  skipTipGeneration?: boolean; // Skip tip generation (default: false)
  tipGenMaxSessionAgeDays?: number; // Only scan sessions from last N days (default: 7)
  tipGenMaxFailures?: number; // Max failure patterns to analyze (default: 50)

  // Phase 2c: Community Detection
  communityDetectionConfig?: import("./config.js").MemoryNeo4jConfig["communityDetection"];

  // Phase 4b: Episode Retention Cleanup
  episodicMemoryConfig?: import("./config.js").MemoryNeo4jConfig["episodicMemory"];

  // Phase 9: Entity/Relationship Reclassification
  skipEntityReclassification?: boolean; // Skip entity type reclassification (default: false)
  skipRelationshipReclassification?: boolean; // Skip RELATED_TO reclassification (default: false)
  reclassificationBatchSize?: number; // Entities/rels per LLM call (default: 20)

  // Phase 10: Link Creation (OP-182)
  skipLinkCreation?: boolean; // Skip semantic + temporal link creation (default: false)

  // Phase 11: Observation Generation (OP-183)
  skipObservationGeneration?: boolean; // Skip per-entity observation summaries (default: false)
  observationMaxEntities?: number; // Max entities per sleep run (default: 20)

  // Phase 12: Reflection / Opinion Generation (OP-186)
  skipReflection?: boolean; // Skip opinion/belief synthesis (default: false)
  reflectionMaxEntities?: number; // Max entities per sleep run (default: 15)

  // Progress callback
  onPhaseStart?: (
    phase:
      | "dedup"
      | "conflict"
      | "semanticDedup"
      | "entityDedup"
      | "decay"
      | "temporalStaleness"
      | "retroactiveConflictScan"
      | "pendingConflictRetry"
      | "extraction"
      | "retroactiveTagging"
      | "cleanup"
      | "noiseCleanup"
      | "credentialScan"
      | "tipGeneration"
      | "communityDetection"
      | "episodeCleanup"
      | "entityReclassification"
      | "relationshipReclassification"
      | "linkCreation"
      | "observationGeneration"
      | "reflection",
  ) => void;
  onProgress?: (phase: string, message: string) => void;
};

// ============================================================================
// Credential Detection Patterns
// ============================================================================

/**
 * Regex patterns that match credential-like content in memory text.
 * Used by the credential scanning phase to find and remove memories
 * that accidentally stored secrets, passwords, API keys, or tokens.
 *
 * These are JavaScript RegExp patterns (case-insensitive).
 */
export const CREDENTIAL_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  // API keys: sk-..., api_key_..., api_key_live_..., apikey-..., etc.
  { pattern: /\b(?:sk|api[_-]?key(?:[_-]\w+)?)[_-][a-z0-9]{16,}/i, label: "API key" },

  // Bearer tokens
  { pattern: /bearer\s+[a-z0-9_\-.]{20,}/i, label: "Bearer token" },

  // JWT tokens (three base64 segments separated by dots) — check before generic token pattern
  { pattern: /\beyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}/i, label: "JWT" },

  // Generic long tokens/secrets (hex or base64, 32+ chars)
  {
    pattern: /\b(?:token|secret|key)\s*[:=]\s*["']?[a-z0-9+/=_\-]{32,}["']?/i,
    label: "Token/secret",
  },

  // Password patterns: password: X, password=X, password X, passwd=X, pwd=X
  {
    pattern: /\b(?:password|passwd|pwd)\s*[:=]\s*["']?\S{4,}["']?/i,
    label: "Password assignment",
  },

  // Credentials in "creds user/pass" format: "login with X creds user/pass"
  { pattern: /\bcreds?\s+\S+[/\\]\S+/i, label: "Credentials (user/pass)" },

  // URL-embedded credentials: https://user:pass@host
  { pattern: /\/\/[^/\s:]+:[^/\s@]+@/i, label: "URL credentials" },

  // Private keys
  { pattern: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/i, label: "Private key" },

  // AWS-style keys
  { pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/, label: "AWS key" },

  // GitHub/GitLab tokens
  { pattern: /\b(?:ghp|gho|ghu|ghs|ghr|glpat)[_-][a-zA-Z0-9]{16,}/i, label: "GitHub/GitLab token" },

  // Anthropic API keys
  { pattern: /\bsk-ant-api\d+-[A-Za-z0-9_-]{20,}/i, label: "Anthropic API key" },

  // OpenAI project keys
  { pattern: /\bsk-proj-[A-Za-z0-9_-]{20,}/i, label: "OpenAI project key" },

  // HuggingFace Access Tokens
  { pattern: /\bhf_[a-zA-Z0-9]{34,}/i, label: "HuggingFace token" },

  // Stripe API keys
  { pattern: /\bsk_(?:live|test)_[a-zA-Z0-9]{20,}/i, label: "Stripe API key" },

  // Twilio Account SIDs
  { pattern: /\bAC[0-9a-f]{32}\b/i, label: "Twilio account SID" },
];

/**
 * Check if a text contains credential-like content.
 * Returns the first matching pattern label, or null if clean.
 */
export function detectCredential(text: string): string | null {
  for (const { pattern, label } of CREDENTIAL_PATTERNS) {
    if (pattern.test(text)) {
      return label;
    }
  }
  return null;
}
