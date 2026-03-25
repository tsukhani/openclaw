## Why

Temporal retrieval scores 60.2% MRR — good but missing 40% of cases. The primary failure modes are: (1) relative date expressions ("last Tuesday", "a few months ago", "recently") not resolved to timestamps at store time, making temporal ranking unreliable, and (2) queries about a time period (e.g. "March") not expanding to retrieve memories from the surrounding window (late Feb – early Apr).

## What Changes

### Date Normalisation at Store Time

- During memory capture, run a date-normalisation pass on the memory text
- Detect relative date expressions using a regex + LLM fallback
- Resolve to an ISO timestamp anchored to `capturedAt` and store as `normalizedDates: string[]` on the memory node
- Index `normalizedDates` for range queries

### Temporal Window Expansion at Query Time

- When a query contains a date reference, expand it to a ±14-day window by default
- Expose `search.temporal.windowDays` config (default: 14)
- Apply window expansion only for `temporal`-type queries (not extraction/graph)

### Recency Calibration

- Add per-query-type freshness weight overrides in config
- Temporal queries: higher freshness weight; extraction queries: lower (facts don't decay)

## Capabilities

### New Capabilities

- `date-normalisation`: Resolve relative dates to ISO timestamps at memory store time

### Modified Capabilities

- `temporal-search`: Window expansion + per-type freshness weight calibration

## Impact

- **Files:** `neo4j-client.ts` (normalisation on store), `neo4j-client-search.ts` (window expansion), new `date-normaliser.ts`
- **Risk:** Low–Medium — normalisation is additive (new field, existing queries unaffected)
- **Expected gain:** +3–5pp temporal MRR
- **Eval target:** ≥70% temporal MRR after fix
