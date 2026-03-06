/**
 * Local cross-encoder reranker via HTTP microservice (OP-130).
 *
 * Calls the Python reranker service running at http://localhost:4124.
 * Service uses sentence-transformers CrossEncoder with cross-encoder/ms-marco-MiniLM-L-6-v2.
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
