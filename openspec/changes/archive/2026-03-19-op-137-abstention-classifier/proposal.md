## Why

LoCoMo eval shows 0% MRR across 446 abstention cases — the memory system never correctly returns empty when it should. The current fixed threshold (0.95) is too blunt: it either blocks everything (auto-recall) or allows irrelevant matches through (explicit search). A proper abstention classifier would learn _whether a query has an answer in the memory store at all_, rather than relying on a single confidence cutoff.

## What Changes

- Train a lightweight binary classifier (logistic regression or small MLP on top of embedding similarity features) that predicts: "does this query have a retrievable answer in the current memory store?"
- Replace the fixed `abstractionThreshold` scalar with a classifier inference call at retrieval time
- Add a config option `abstention.mode: "threshold" | "classifier"` for gradual rollout
- Fallback gracefully: if classifier fails, fall back to threshold mode
- Add labelled abstention examples from LoCoMo to the eval fixtures for regression testing

## Capabilities

### New Capabilities

- `abstention-classifier`: Binary ML classifier for query answerability detection

### Modified Capabilities

- `retrieval-abstention`: Switch from fixed threshold to classifier-based decision

## Impact

- **Files:** `neo4j-client-search.ts` (abstention check), new `abstention-classifier.ts`
- **Risk:** Medium — new ML component; fallback to threshold mode ensures no regression
- **Expected gain:** +15–20pp overall MRR (446 abstention cases currently scoring 0%)
- **Eval target:** ≥60% abstention MRR after fix
