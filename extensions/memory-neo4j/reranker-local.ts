/**
 * Local ONNX cross-encoder reranker via @huggingface/transformers (OP-130).
 *
 * Loads `cross-encoder/ms-marco-MiniLM-L-6-v2` (22 MB ONNX) on first use,
 * then keeps the pipeline as a process-scoped singleton.
 * Downloads to ~/.cache/huggingface/ automatically; subsequent calls are instant.
 *
 * ~50-150ms per batch on CPU — acceptable alongside existing 2-5s LLM calls.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TransformersPipeline = any; // Transformers.js pipeline — genuinely dynamic, no stable public types

const DEFAULT_MODEL = "cross-encoder/ms-marco-MiniLM-L-6-v2";

/** Process-scoped pipeline singleton — loaded once, reused across all calls. */
let _pipe: TransformersPipeline | null = null;

/** Load (or return cached) the text-classification pipeline for the given model. */
async function getPipeline(model: string): Promise<TransformersPipeline> {
  if (!_pipe) {
    // Dynamic import keeps @huggingface/transformers out of the critical-path
    // module graph. The module is only loaded when the reranker is first used.
    const { pipeline } = await import("@huggingface/transformers");
    // dtype "q8" = int8 quantized — ~4× smaller, faster, minimal quality loss
    _pipe = await pipeline("text-classification", model, { dtype: "q8" });
  }
  return _pipe;
}

/** Apply sigmoid to convert a raw logit to [0, 1]. */
function sigmoid(logit: number): number {
  return 1 / (1 + Math.exp(-logit));
}

/** Result item returned by localRerank, sorted descending by relevanceScore. */
export interface LocalRerankResult {
  /** Original index in the `documents` array. */
  index: number;
  /** Relevance score in [0, 1]. */
  relevanceScore: number;
}

/**
 * Rerank `documents` against `query` using a local ONNX cross-encoder.
 *
 * @param query - The search query.
 * @param documents - Candidate document texts to score.
 * @param model - HuggingFace model name. Defaults to ms-marco-MiniLM-L-6-v2.
 * @param signal - Optional AbortSignal to cancel before the pipeline call.
 * @returns Results sorted descending by relevanceScore.
 */
export async function localRerank(
  query: string,
  documents: string[],
  model: string = DEFAULT_MODEL,
  signal?: AbortSignal,
): Promise<LocalRerankResult[]> {
  if (documents.length === 0) return [];

  if (signal?.aborted) {
    throw new Error("localRerank: aborted before pipeline call");
  }

  const pipe = await getPipeline(model);

  if (signal?.aborted) {
    throw new Error("localRerank: aborted after pipeline load");
  }

  // Build (query, document) pairs — cross-encoder input format
  const pairs: [string, string][] = documents.map((doc) => [query, doc]);

  // function_to_apply: "none" returns raw logits so we can apply sigmoid ourselves
  const rawOutput: unknown = await pipe(pairs, { truncation: true, function_to_apply: "none" });

  // Normalise to array (single-doc input may return a bare object)
  const outputArray: unknown[] = Array.isArray(rawOutput) ? rawOutput : [rawOutput];

  const scored: LocalRerankResult[] = outputArray.map((result, index) => {
    const r = result as { score?: number };
    const logit = typeof r.score === "number" ? r.score : 0;
    return { index, relevanceScore: sigmoid(logit) };
  });

  // Sort descending: most relevant first
  scored.sort((a, b) => b.relevanceScore - a.relevanceScore);
  return scored;
}

/**
 * Reset the pipeline singleton. Intended for use in tests only.
 * @internal
 */
export function _resetPipelineForTests(): void {
  _pipe = null;
}
