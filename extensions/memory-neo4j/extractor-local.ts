/**
 * Local entity extraction pipeline (Stage 0: regex, Stage 1: GLiNER zero-shot NER).
 *
 * Runs before the LLM extraction to reduce cost and latency. Results are
 * merged with LLM output via mergeExtractionResults().
 *
 * GLiNER is a zero-shot NER model that accepts entity type labels at inference
 * time — it can extract any entity type without retraining. The preprocessing
 * and postprocessing are ported from GLiNER.js to avoid an ONNX runtime
 * version conflict (gliner npm pins onnxruntime 1.19 vs transformers.js 1.21).
 */

import type { ExtractionResult, ExtractedEntity, Logger } from "./schema.js";

// ============================================================================
// Stage 0: Regex / Heuristic Extractor
// ============================================================================

const EMAIL_RE = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g;
// Require dash/space separators (not dots) to avoid matching version numbers and IPs
const PHONE_RE = /\b(?:\+?\d{1,3}[\s-])?\(?\d{2,4}\)?[\s-]\d{3,4}[\s-]\d{3,4}\b/g;
const URL_RE = /https?:\/\/[^\s"'<>)\]]+/g;
const MENTION_RE = /@([a-zA-Z0-9_-]{2,})/g;
// Possessive subjects: "Tarun's phone number" → extract "tarun" as person
const POSSESSIVE_SUBJECT_RE = /\b([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]+){0,2})'s\b/g;

// Relationship words that indicate person entities nearby
const RELATIONSHIP_WORDS =
  "wife|husband|son|daughter|mother|father|brother|sister|cousin|nephew|niece|uncle|aunt|spouse|partner|child|parent|grandparent|grandmother|grandfather|grandson|granddaughter";

// Relationship-object patterns: extract the person AFTER a relationship word
// "Tarun's wife: Renu Sukhani" → "renu sukhani"
// "wife is Renu Sukhani" → "renu sukhani"
// "married to Renu Sukhani" → "renu sukhani"
const RELATIONSHIP_OBJECT_RE = new RegExp(
  `(?:${RELATIONSHIP_WORDS})(?:[ \\t]+(?:is|was|named))?[:, \\t]+([A-Z][a-z]{2,}(?:[ \\t]+[A-Z][a-z]+){0,2})\\b`,
  "gm",
);

// Location after spatial prepositions: "lives in Kuala Lumpur" → "kuala lumpur"
const LOCATION_RE =
  /\b(?:lives?[ \t]+in|based[ \t]+in|from|located[ \t]+in|moved[ \t]+to|born[ \t]+in|grew[ \t]+up[ \t]+in|resides?[ \t]+in|relocated[ \t]+to|stayed?[ \t]+(?:in|at))[ \t]+([A-Z][a-z]{2,}(?:[ \t]+[A-Z][a-z]+){0,3})\b/gm;

// Organization after work prepositions: "works at Abundent Academy" → "abundent academy"
const ORGANIZATION_RE =
  /\b(?:works?[ \t]+(?:at|for)|employed[ \t]+(?:at|by)|founded|co-?founded|joined|(?:CEO|CTO|COO|founder|director|manager|head|lead)[ \t]+(?:of|at))[ \t]+([A-Z][a-z]{2,}(?:[ \t]+[A-Z][a-z]+){0,3})\b/gm;

type PropertyMatch = { key: string; value: string; contextName?: string };

/** Extract structured properties (emails, phones, URLs, @mentions) from text. */
export function extractRegexProperties(text: string): {
  properties: PropertyMatch[];
  entities: ExtractedEntity[];
} {
  const properties: PropertyMatch[] = [];
  const entities: ExtractedEntity[] = [];

  for (const match of text.matchAll(EMAIL_RE)) {
    const contextName = findPrecedingName(text, match.index);
    properties.push({ key: "email", value: match[0], contextName });
  }

  for (const match of text.matchAll(PHONE_RE)) {
    const val = match[0].trim();
    if (val.replace(/\D/g, "").length < 7) {
      continue;
    }
    const contextName = findPrecedingName(text, match.index);
    properties.push({ key: "phone", value: val, contextName });
  }

  for (const match of text.matchAll(URL_RE)) {
    properties.push({ key: "url", value: match[0] });
  }

  for (const match of text.matchAll(MENTION_RE)) {
    entities.push({ name: match[1].toLowerCase(), type: "person" });
  }

  // Possessive subjects: "Tarun's preferred timezone" → extract "tarun" as person
  for (const match of text.matchAll(POSSESSIVE_SUBJECT_RE)) {
    const name = match[1].toLowerCase();
    if (!entities.some((e) => e.name === name)) {
      entities.push({ name, type: "person" });
    }
  }

  // Subject-verb subjects: "Tarun prefers MYT", "Tarun lives in KL" → extract "tarun" as person
  // Only matches capitalized proper nouns (2+ lowercase chars after capital) followed by common verbs
  const SUBJECT_VERB_RE =
    /^([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]+){0,2})\s+(?:prefers?|uses?|likes?|owns?|keeps?|sets?|schedules?|considers?|recommends?|evaluated?|switched?|posts?|engages?|writes?|runs?|installed?|configured?|chose|tried|briefly|lives?|works?|studies|teaches|manages?|founded|created|moved|born|grew|resides?|joined|left|attended|graduated|married|divorced)\b/gm;
  for (const match of text.matchAll(SUBJECT_VERB_RE)) {
    const name = match[1].toLowerCase();
    if (!entities.some((e) => e.name === name)) {
      entities.push({ name, type: "person" });
    }
  }

  // Relationship-object extraction: "wife: Renu Sukhani" → "renu sukhani" as person
  for (const match of text.matchAll(RELATIONSHIP_OBJECT_RE)) {
    const name = match[1].toLowerCase();
    if (!entities.some((e) => e.name === name)) {
      entities.push({ name, type: "person" });
    }
  }

  // Location extraction: "lives in Kuala Lumpur" → "kuala lumpur" as location
  for (const match of text.matchAll(LOCATION_RE)) {
    const name = match[1].toLowerCase();
    if (!entities.some((e) => e.name === name)) {
      entities.push({ name, type: "location" });
    }
  }

  // Organization extraction: "works at Abundent Academy" → "abundent academy" as organization
  for (const match of text.matchAll(ORGANIZATION_RE)) {
    const name = match[1].toLowerCase();
    if (!entities.some((e) => e.name === name)) {
      entities.push({ name, type: "organization" });
    }
  }

  const byEntity = new Map<string, Record<string, string>>();
  for (const prop of properties) {
    if (prop.contextName) {
      const name = prop.contextName.toLowerCase();
      const existing = byEntity.get(name) ?? {};
      existing[prop.key] = prop.value;
      byEntity.set(name, existing);
    }
  }

  for (const [name, props] of byEntity) {
    entities.push({ name, type: "person", properties: props });
  }

  return { properties, entities };
}

/** L7: Max chars to look back from a regex match when searching for a preceding entity name. */
const PRECEDING_NAME_LOOKBACK_CHARS = 80;

function findPrecedingName(text: string, matchIndex: number): string | undefined {
  const before = text.slice(Math.max(0, matchIndex - PRECEDING_NAME_LOOKBACK_CHARS), matchIndex);
  const patterns = [
    /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)'s\s+\w+\s+is\s*$/,
    /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s*:\s*$/,
    /(?:reach|contact|email|call)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+at\s*$/i,
    /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+(?:at|is)\s*$/,
  ];
  for (const pattern of patterns) {
    const m = before.match(pattern);
    if (m) {
      return m[1];
    }
  }
  return undefined;
}

// ============================================================================
// Stage 1: GLiNER Zero-Shot NER
// ============================================================================

/**
 * Entity types to extract — matches the schema types from extractor.ts prompt.
 * GLiNER accepts these at inference time (zero-shot).
 */
const GLINER_ENTITY_LABELS = [
  "person",
  "organization",
  "location",
  "event",
  "software",
  "tool",
  "product",
  "service",
];

/** Confidence threshold for GLiNER span predictions (lowered from 0.3 to improve person name recall). */
const GLINER_THRESHOLD = 0.25;

/** Max span width in words for GLiNER. */
const GLINER_MAX_WIDTH = 12;

/** Conservative char limit for GLiNER input (~384 DeBERTa tokens × 4 chars/token). */
const GLINER_MAX_CHARS = 1536;

/** Model to use for GLiNER. */
const GLINER_MODEL = "onnx-community/gliner_medium-v2.1";

/** Loose type for the dynamically-imported onnxruntime-node module. */
type OrtModule = {
  InferenceSession: {
    create(path: string | Buffer): Promise<OrtSession>;
  };
  Tensor: new (type: string, data: ArrayLike<number> | BigInt64Array, dims: number[]) => unknown;
};
type OrtSession = {
  run(
    feeds: Record<string, unknown>,
  ): Promise<Record<string, { data: Float32Array; dims: number[] }>>;
};

/** Loose type for the transformers.js tokenizer. */
type Tokenizer = {
  encode(text: string): { input_ids: { data: bigint[] }; attention_mask: { data: bigint[] } };
};

// Lazy singleton for the GLiNER pipeline
type GlinerPipeline = (text: string, labels: string[]) => Promise<GlinerEntity[]>;
type GlinerEntity = { text: string; label: string; score: number; start: number; end: number };

let glinerPromise: Promise<GlinerPipeline | null> | null = null;

/** Initialize the GLiNER pipeline lazily. Returns null on failure. */
async function getGlinerPipeline(): Promise<GlinerPipeline | null> {
  if (glinerPromise) {
    return glinerPromise;
  }

  glinerPromise = (async () => {
    try {
      const { AutoTokenizer } = await import("@huggingface/transformers");

      // Load tokenizer from the GLiNER model repo
      const tokenizer = await AutoTokenizer.from_pretrained(GLINER_MODEL);

      // Download and cache the ONNX model, then create session
      const modelBuffer = await downloadOnnxModel(GLINER_MODEL, "onnx/model_quantized.onnx");
      // onnxruntime-node is a transitive dep of @huggingface/transformers — dynamic import
      const ort: OrtModule = await import("onnxruntime-node" as string);
      const session = await ort.InferenceSession.create(modelBuffer);

      return async (text: string, labels: string[]): Promise<GlinerEntity[]> => {
        return runGlinerInference(session, tokenizer as unknown as Tokenizer, ort, text, labels);
      };
    } catch {
      glinerPromise = null;
      return null;
    }
  })();

  return glinerPromise;
}

/**
 * Download an ONNX model file from HuggingFace Hub, caching locally.
 * Returns a Buffer that onnxruntime-node can load directly.
 */
// C4: Pinned SHA-256 hash for the quantized GLiNER model binary.
// Update this hash when upgrading the model version (onnx-community/gliner_medium-v2.1).
const GLINER_MODEL_SHA256 = "3107f08ce7c5263503a23b18c0b26287b2bd49eba24635f5d44da2d27a27cbd6";

async function downloadOnnxModel(modelId: string, filename: string): Promise<Buffer> {
  const { join } = await import("node:path");
  const fs = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");

  const cacheDir = join(process.env.HOME || "/tmp", ".cache", "openclaw", "gliner");
  const safeModelId = modelId.replace(/\//g, "--");
  const cachedPath = join(cacheDir, safeModelId, filename.replace(/\//g, "--"));
  const hashPath = cachedPath + ".sha256";

  try {
    const cached = (await fs.readFile(cachedPath)) as Buffer;
    // C4: Verify cached model integrity if hash file exists
    try {
      const storedHash = (await fs.readFile(hashPath, "utf-8")).trim();
      const actualHash = createHash("sha256").update(cached).digest("hex");
      if (storedHash === actualHash) {
        return cached;
      }
      // Hash mismatch — re-download
    } catch {
      // No hash file — trust existing cache (backward compat)
      return cached;
    }
  } catch {
    // Cache miss — download from HuggingFace Hub
  }

  const url = `https://huggingface.co/${modelId}/resolve/main/${filename}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status}`);
  }

  // H4: Enforce max download size (500 MB) to prevent OOM from malicious/oversized responses
  const MAX_MODEL_BYTES = 500 * 1024 * 1024;
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_MODEL_BYTES) {
    throw new Error(`Model file too large: ${contentLength} bytes (max ${MAX_MODEL_BYTES})`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_MODEL_BYTES) {
    throw new Error(`Downloaded model too large: ${buffer.length} bytes (max ${MAX_MODEL_BYTES})`);
  }

  // C4: Compute and verify SHA-256 hash
  const hash = createHash("sha256").update(buffer).digest("hex");
  if (GLINER_MODEL_SHA256 && hash !== GLINER_MODEL_SHA256) {
    throw new Error(
      `Model integrity check failed: expected SHA-256 ${GLINER_MODEL_SHA256}, got ${hash}`,
    );
  }

  await fs.mkdir(join(cacheDir, safeModelId), { recursive: true });
  await fs.writeFile(cachedPath, buffer);
  // C4: Persist hash alongside the model for future integrity checks
  await fs.writeFile(hashPath, hash, "utf-8");

  return buffer;
}

/**
 * Run GLiNER inference: preprocess → ONNX → postprocess.
 *
 * GLiNER preprocessing:
 * 1. Prepend entity labels with special tokens: [<<ENT>> label1 <<ENT>> label2 ... <<SEP>>]
 * 2. Append text tokens
 * 3. Build span indices for all possible spans up to maxWidth
 *
 * GLiNER postprocessing:
 * 1. Sigmoid on output logits
 * 2. Filter by threshold
 * 3. Greedy non-overlapping span selection (highest score first)
 * 4. Map spans back to text positions
 */
async function runGlinerInference(
  session: OrtSession,
  tokenizer: Tokenizer,
  ort: OrtModule,
  text: string,
  labels: string[],
): Promise<GlinerEntity[]> {
  // Split text into words
  const wordPattern = /\w+(?:[-_]\w+)*|\S/g;
  const words: { text: string; start: number; end: number }[] = [];
  for (const m of text.matchAll(wordPattern)) {
    words.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  }
  if (words.length === 0) {
    return [];
  }

  // Build the combined input: [CLS] <<ENT>> label1 <<ENT>> label2 ... <<SEP>> word1 word2 ... [SEP]
  // Since GLiNER uses DeBERTa tokenizer, we construct the full text and tokenize
  const entityPrefix = labels.map((l) => `<<ENT>> ${l}`).join(" ");
  const textPart = words.map((w) => w.text).join(" ");
  const combined = `${entityPrefix} <<SEP>> ${textPart}`;

  const encoded = tokenizer.encode(combined);
  const inputIds = Array.from(encoded.input_ids.data);
  const attentionMask = Array.from(encoded.attention_mask.data);
  const seqLen = inputIds.length;

  // Find where text tokens start (after <<SEP>> token)
  // Count entity prefix tokens by tokenizing just the prefix
  const prefixEncoded = tokenizer.encode(entityPrefix + " <<SEP>>");
  const prefixLen = Array.from(prefixEncoded.input_ids.data).length;

  // Build words_mask: 1 for text word starts, 0 elsewhere
  // Approximate: map word boundaries to token positions
  const wordsMask = Array.from({ length: seqLen }, () => 0);
  const textTokenStart = prefixLen - 1; // -1 because CLS is included
  const numTextTokens = seqLen - textTokenStart - 1; // -1 for trailing SEP

  // H8: Known limitation — word-to-token mapping is approximate because GLiNER's
  // tokenizer may split words differently than whitespace boundaries. Entity span
  // extraction can be offset by a few characters. This is acceptable because
  // extracted entity names are post-validated against the source text.
  //
  // Simple heuristic: mark first token of each word region.
  // For accurate mapping we'd need character-level alignment, but this is sufficient
  // for the span decoder which operates on word indices.
  let tokenIdx = textTokenStart;
  for (let w = 0; w < words.length && tokenIdx < seqLen - 1; w++) {
    wordsMask[tokenIdx] = 1;
    // Estimate tokens per word (subword tokenization makes this variable)
    const tokensPerWord = Math.max(1, Math.ceil(numTextTokens / words.length));
    tokenIdx += tokensPerWord;
  }

  // Build span indices: all (start, end) pairs up to maxWidth
  const numWords = words.length;
  const spans: [number, number][] = [];
  for (let i = 0; i < numWords; i++) {
    for (let j = i; j < Math.min(i + GLINER_MAX_WIDTH, numWords); j++) {
      spans.push([i, j]);
    }
  }
  if (spans.length === 0) {
    return [];
  }

  // Build span_idx tensor [1, numSpans, 2]
  const spanIdx = Array.from<number>({ length: spans.length * 2 });
  for (let i = 0; i < spans.length; i++) {
    spanIdx[i * 2] = spans[i][0];
    spanIdx[i * 2 + 1] = spans[i][1];
  }

  // Build span_mask tensor [1, numSpans]
  const spanMask = Array.from({ length: spans.length }, () => 1);

  // Build text_lengths tensor [1]
  const textLengths = [numWords];

  // Create ONNX tensors
  const feeds: Record<string, unknown> = {
    input_ids: new ort.Tensor("int64", BigInt64Array.from(inputIds.map(BigInt)), [1, seqLen]),
    attention_mask: new ort.Tensor("int64", BigInt64Array.from(attentionMask.map(BigInt)), [
      1,
      seqLen,
    ]),
    words_mask: new ort.Tensor("int64", BigInt64Array.from(wordsMask.map(BigInt)), [1, seqLen]),
    text_lengths: new ort.Tensor("int64", BigInt64Array.from(textLengths.map(BigInt)), [1]),
    span_idx: new ort.Tensor("int64", BigInt64Array.from(spanIdx.map(BigInt)), [
      1,
      spans.length,
      2,
    ]),
    span_mask: new ort.Tensor("uint8", new Uint8Array(spanMask), [1, spans.length]),
  };

  // Run inference
  const output = await session.run(feeds);
  const logits = output.logits ?? output.span_logits ?? Object.values(output)[0];
  if (!logits) {
    return [];
  }

  let logitsData = logits.data;
  const numLabels = labels.length;
  const logitsDims = logits.dims;

  // H2/M8: Validate logits dimensions before indexing to prevent silent NaN scores.
  // Expected shape is [numSpans, numLabels] or [1, numSpans, numLabels] (batch dim).
  const expectedSize = spans.length * numLabels;
  if (logitsData.length !== expectedSize) {
    // Detect batch dimension [1, numSpans, numLabels] — total element count matches expectedSize
    // when dims are [1, S, L] because the batch dim doesn't add extra data.
    if (
      logitsDims.length === 3 &&
      logitsDims[0] === 1 &&
      logitsDims[1] === spans.length &&
      logitsDims[2] === numLabels
    ) {
      // Batch dim present — data layout is identical to [S, L], safe to index directly
    } else {
      // Genuine mismatch — return empty to avoid NaN-polluted results
      return [];
    }
  }

  // Decode: sigmoid → filter → greedy non-overlapping
  type Candidate = { spanStart: number; spanEnd: number; labelIdx: number; score: number };
  const candidates: Candidate[] = [];

  for (let s = 0; s < spans.length; s++) {
    for (let l = 0; l < numLabels; l++) {
      const raw = logitsData[s * numLabels + l];
      const score = 1 / (1 + Math.exp(-raw)); // sigmoid
      if (score >= GLINER_THRESHOLD) {
        candidates.push({
          spanStart: spans[s][0],
          spanEnd: spans[s][1],
          labelIdx: l,
          score,
        });
      }
    }
  }

  // Sort by score descending for greedy selection
  candidates.sort((a, b) => b.score - a.score);

  // Greedy non-overlapping selection
  const taken = new Set<number>(); // word indices already assigned
  const results: GlinerEntity[] = [];

  for (const c of candidates) {
    let overlaps = false;
    for (let w = c.spanStart; w <= c.spanEnd; w++) {
      if (taken.has(w)) {
        overlaps = true;
        break;
      }
    }
    if (overlaps) {
      continue;
    }

    // Mark words as taken
    for (let w = c.spanStart; w <= c.spanEnd; w++) {
      taken.add(w);
    }

    // Map back to text
    const startWord = words[c.spanStart];
    const endWord = words[c.spanEnd];
    if (!startWord || !endWord) {
      continue;
    }

    results.push({
      text: text.slice(startWord.start, endWord.end),
      label: labels[c.labelIdx],
      score: c.score,
      start: startWord.start,
      end: endWord.end,
    });
  }

  return results;
}

/** Run GLiNER NER extraction on text. Returns entities or empty array on failure. */
export async function extractNer(text: string, logger?: Logger): Promise<ExtractedEntity[]> {
  const pipe = await getGlinerPipeline();
  if (!pipe) {
    logger?.warn?.("memory-neo4j: GLiNER pipeline unavailable, skipping Stage 1");
    return [];
  }

  const truncated = text.length > GLINER_MAX_CHARS ? text.slice(0, GLINER_MAX_CHARS) : text;

  try {
    const entities = await pipe(truncated, GLINER_ENTITY_LABELS);
    // Deduplicate by normalized name
    const seen = new Set<string>();
    return entities
      .map((e) => ({
        name: e.text.trim().toLowerCase(),
        type: e.label,
      }))
      .filter((e) => {
        if (e.name.length === 0 || seen.has(e.name)) {
          return false;
        }
        seen.add(e.name);
        return true;
      });
  } catch (err) {
    logger?.warn?.(
      `memory-neo4j: GLiNER extraction failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

// ============================================================================
// Combined Local Extraction
// ============================================================================

/**
 * Run local extraction (Stage 0 regex + Stage 1 GLiNER zero-shot NER).
 * Returns a partial ExtractionResult with entities only (no relationships/tags/category).
 * Failures in either stage are non-fatal — returns whatever succeeded.
 */
export async function extractLocal(
  text: string,
  enabled: boolean,
  logger?: Logger,
): Promise<ExtractionResult> {
  const empty: ExtractionResult = { entities: [], relationships: [], tags: [] };
  if (!enabled) {
    return empty;
  }

  let regexEntities: ExtractedEntity[] = [];
  let nerEntities: ExtractedEntity[] = [];

  // Stage 0: Regex
  try {
    const regexResult = extractRegexProperties(text);
    regexEntities = regexResult.entities;
  } catch (err) {
    logger?.warn?.(
      `memory-neo4j: regex extraction failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Stage 1: GLiNER zero-shot NER
  try {
    nerEntities = await extractNer(text, logger);
  } catch (err) {
    logger?.warn?.(
      `memory-neo4j: GLiNER extraction failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Merge: NER entities take precedence over regex on name collision (higher accuracy),
  // but regex entities may have properties that NER doesn't produce
  const byName = new Map<string, ExtractedEntity>();
  for (const e of regexEntities) {
    byName.set(e.name, e);
  }
  for (const e of nerEntities) {
    const existing = byName.get(e.name);
    if (existing) {
      byName.set(e.name, { ...e, properties: existing.properties });
    } else {
      byName.set(e.name, e);
    }
  }

  return {
    entities: Array.from(byName.values()),
    relationships: [],
    tags: [],
  };
}

// ============================================================================
// Merge Function
// ============================================================================

/** Default confidence for local-extracted entities. */
const LOCAL_DEFAULT_CONFIDENCE = 0.8;
/** Default confidence for LLM-extracted entities when not specified. */
const LLM_DEFAULT_CONFIDENCE = 0.85;

/**
 * Merge local and LLM extraction results.
 *
 * - Entities: merge by normalized name, higher confidence wins.
 *   Properties from the losing entity are merged into the winner.
 * - Relationships, tags, category: always from LLM.
 */
export function mergeExtractionResults(
  local: ExtractionResult | null,
  llm: ExtractionResult | null,
): ExtractionResult | null {
  if (!local && !llm) {
    return null;
  }
  if (!local) {
    return llm;
  }
  if (!llm) {
    return local;
  }

  const merged = new Map<string, ExtractedEntity & { _confidence: number }>();
  for (const e of local.entities) {
    merged.set(e.name, { ...e, _confidence: LOCAL_DEFAULT_CONFIDENCE });
  }

  for (const e of llm.entities) {
    const existing = merged.get(e.name);
    if (existing) {
      // Higher-confidence source wins base fields; lower-confidence source's
      // properties are merged underneath (spread order: loser first, winner last).
      if (LLM_DEFAULT_CONFIDENCE >= existing._confidence) {
        const mergedProps =
          existing.properties || e.properties
            ? { ...existing.properties, ...e.properties }
            : undefined;
        merged.set(e.name, { ...e, properties: mergedProps, _confidence: LLM_DEFAULT_CONFIDENCE });
      } else {
        const mergedProps =
          e.properties || existing.properties
            ? { ...e.properties, ...existing.properties }
            : undefined;
        merged.set(e.name, { ...existing, properties: mergedProps });
      }
    } else {
      merged.set(e.name, { ...e, _confidence: LLM_DEFAULT_CONFIDENCE });
    }
  }

  const entities: ExtractedEntity[] = Array.from(merged.values()).map(
    ({ _confidence, ...rest }) => rest,
  );

  return {
    entities,
    relationships: llm.relationships,
    tags: llm.tags,
    category: llm.category,
  };
}

/** Reset the GLiNER singleton (for testing). */
export function _resetNerPipeline(): void {
  glinerPromise = null;
}
