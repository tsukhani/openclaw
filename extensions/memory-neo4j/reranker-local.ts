/**
 * Local cross-encoder reranker via HTTP microservice (OP-130).
 *
 * Calls the Python reranker service running at http://localhost:4124.
 * Service uses sentence-transformers CrossEncoder with BAAI/bge-reranker-v2-m3.
 *
 * Start service: systemctl --user start reranker.service
 * Health check: curl http://localhost:4124/health
 */

const DEFAULT_SERVICE_URL = "http://localhost:4124";

/** Result item returned by localRerank, sorted descending by relevanceScore. */
export interface LocalRerankResult {
  /** Original index in the `documents` array. */
  index: number;
  /** Relevance score in [0, 1] after sigmoid normalisation. */
  relevanceScore: number;
}

interface RerankApiResponse {
  results: Array<{ index: number; relevance_score: number }>;
  model: string;
}

/**
 * Rerank `documents` against `query` using the local Python reranker service.
 *
 * @param query - The search query.
 * @param documents - Candidate document texts to score.
 * @param model - Unused (model set on the service). Kept for API compatibility.
 * @param signal - Optional AbortSignal to cancel the HTTP request.
 * @param serviceUrl - Reranker service base URL. Defaults to http://localhost:4124.
 * @returns Results sorted descending by relevanceScore.
 */
export async function localRerank(
  query: string,
  documents: string[],
  model?: string,
  signal?: AbortSignal,
  serviceUrl: string = DEFAULT_SERVICE_URL,
): Promise<LocalRerankResult[]> {
  if (documents.length === 0) return [];

  const response = await fetch(`${serviceUrl}/rerank`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, documents }),
    signal,
  });

  if (!response.ok) {
    throw new Error(`Reranker service error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as RerankApiResponse;

  return data.results.map((r) => ({
    index: r.index,
    relevanceScore: r.relevance_score,
  }));
}

/**
 * Check if the local reranker service is available.
 * Returns false if the service is not running (used for graceful degradation).
 */
export async function isRerankServiceAvailable(
  serviceUrl: string = DEFAULT_SERVICE_URL,
): Promise<boolean> {
  try {
    const res = await fetch(`${serviceUrl}/health`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Extraction-optimised reranking path (OP-138).
 *
 * For extraction queries ("what did X say about Y?"), factual precision matters more
 * than recency. This variant rewrites the query into a declarative assertion form that
 * cross-encoders score more reliably.
 *
 * Falls back to `localRerank` with the rewritten (or original) query.
 *
 * @param query - Original extraction query string.
 * @param documents - Candidate document texts to score.
 * @param signal - Optional AbortSignal.
 * @param serviceUrl - Reranker service base URL.
 * @returns Results sorted descending by relevanceScore.
 */
export async function localRerankExtraction(
  query: string,
  documents: string[],
  signal?: AbortSignal,
  serviceUrl: string = DEFAULT_SERVICE_URL,
): Promise<LocalRerankResult[]> {
  if (documents.length === 0) return [];

  // Rewrite question to declarative assertion form for better cross-encoder scoring.
  // Cross-encoders trained on passage retrieval score (query, passage) pairs better
  // when the query resembles the passage style (declarative), not Q&A format.
  const rewrittenQuery = rewriteExtractionQuery(query);
  const effectiveQuery = rewrittenQuery.length > 0 ? rewrittenQuery : query;

  return localRerank(effectiveQuery, documents, undefined, signal, serviceUrl);
}

/**
 * Rewrite an extraction question into declarative assertion form (OP-138).
 *
 * Examples:
 *   "what did Ada say about her voice?" → "Ada said about her voice"
 *   "how did Tarun describe the project?" → "Tarun describe the project"
 *   "what does Ada prefer for TTS?" → "Ada prefers for TTS"
 *   "what did X mention about Y?" → "X mentioned about Y"
 */
export function rewriteExtractionQuery(query: string): string {
  const q = query.trim();

  // Pattern: "what did <subject> <verb> about/..." → "<subject> <past-verb> ..."
  const whatDidMatch = q.match(
    /^what did\s+(.+?)\s+(say|mention|tell|describe|explain|state|note|report|express|opine|think|feel|prefer|like|want)\s*(.*)$/i,
  );
  if (whatDidMatch) {
    const [, subject, verb, rest] = whatDidMatch;
    const pastVerb = toPastTense(verb);
    return `${subject} ${pastVerb} ${rest}`.replace(/\?\s*$/, "").trim();
  }

  // Pattern: "what does/is <subject> <verb>..." → "<subject> <verb>s ..."
  const whatDoesMatch = q.match(
    /^what (?:does|is)\s+(.+?)\s+(say|think|feel|prefer|like|want|believe)\s*(.*)$/i,
  );
  if (whatDoesMatch) {
    const [, subject, verb, rest] = whatDoesMatch;
    return `${subject} ${verb}s ${rest}`.replace(/\?\s*$/, "").trim();
  }

  // Pattern: "how did <subject> ..." → "<subject> ..."
  const howDidMatch = q.match(/^how did\s+(.+?)(?:\?|$)/i);
  if (howDidMatch) {
    const [, rest] = howDidMatch;
    return rest.replace(/\?\s*$/, "").trim();
  }

  // Fallback: strip leading WH-question phrase
  return q
    .replace(/^(what did|what does|what is|how did|how does|who did|where did|why did)\s+/i, "")
    .replace(/\?\s*$/, "")
    .trim();
}

/** Map common verbs to their simple past tense form. */
function toPastTense(verb: string): string {
  const irregular: Record<string, string> = {
    say: "said",
    tell: "told",
    think: "thought",
    feel: "felt",
    go: "went",
  };
  const lower = verb.toLowerCase();
  if (irregular[lower]) {
    return irregular[lower];
  }
  // Regular: add -ed (covers most cases for extraction queries)
  if (lower.endsWith("e")) {
    return `${lower}d`;
  }
  return `${lower}ed`;
}
