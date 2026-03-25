# Configuration Schema

## New Config Block: `contextualRetrieval`

Added to the existing plugin config in `extensions/memory-neo4j/config.ts` using TypeBox (consistent with existing config schema).

```typescript
interface ContextualRetrievalConfig {
  /** Enable contextual retrieval pipeline. Default: false */
  enabled: boolean;

  /** LLM provider for context generation */
  contextProvider?: "anthropic" | "openrouter" | "ollama";

  /** API key for context generation (falls back to extraction.apiKey) */
  contextApiKey?: string;

  /** Base URL for context generation API (falls back to extraction.baseUrl) */
  contextBaseUrl?: string;

  /** Model for context generation. Default: "claude-haiku-4-5-20251001" */
  contextModel?: string;

  /** Minimum context length in estimated tokens. Default: 20 */
  minContextLength?: number;

  /** Maximum context length in estimated tokens. Default: 150 */
  maxContextLength?: number;

  /** Concurrency for parallel context generation. Default: 4 */
  contextConcurrency?: number;

  /** Source document caching for prompt caching efficiency */
  documentCache?: {
    /** Enable prompt caching for source documents. Default: true */
    enabled?: boolean;
    /** TTL in milliseconds. Default: 3600000 (1 hour) */
    ttl?: number;
  };

  /** Context result cache capacity (LRU). Default: 1000 */
  resultCacheCapacity?: number;

  /** Weight of contextual signals vs original in blending (0-1). Default: 0.7 */
  signalWeight?: number;

  /** Per-query-type signal weight overrides */
  signalWeightOverrides?: {
    short?: number;
    entity?: number;
    long?: number;
    updates?: number;
    extraction?: number;
    causal?: number;
  };
}
```

## TypeBox Schema Definition

```typescript
const ContextualRetrievalSchema = Type.Object({
  enabled: Type.Optional(Type.Boolean({ default: false })),
  contextProvider: Type.Optional(
    Type.Union([Type.Literal("anthropic"), Type.Literal("openrouter"), Type.Literal("ollama")]),
  ),
  contextApiKey: Type.Optional(Type.String()),
  contextBaseUrl: Type.Optional(Type.String()),
  contextModel: Type.Optional(Type.String({ default: "claude-haiku-4-5-20251001" })),
  minContextLength: Type.Optional(Type.Number({ minimum: 1, maximum: 500, default: 20 })),
  maxContextLength: Type.Optional(Type.Number({ minimum: 10, maximum: 1000, default: 150 })),
  contextConcurrency: Type.Optional(Type.Number({ minimum: 1, maximum: 32, default: 4 })),
  documentCache: Type.Optional(
    Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: true })),
      ttl: Type.Optional(Type.Number({ minimum: 60000, default: 3600000 })),
    }),
  ),
  resultCacheCapacity: Type.Optional(Type.Number({ minimum: 10, maximum: 10000, default: 1000 })),
  signalWeight: Type.Optional(Type.Number({ minimum: 0, maximum: 1, default: 0.7 })),
  signalWeightOverrides: Type.Optional(Type.Record(Type.String(), Type.Number())),
});
```

## Full Config Example

```json
{
  "neo4j": {
    "uri": "bolt://localhost:7687",
    "user": "neo4j",
    "password": "password"
  },
  "embedding": {
    "provider": "openai",
    "apiKey": "sk-...",
    "model": "text-embedding-3-small"
  },
  "extraction": {
    "apiKey": "sk-or-v1-...",
    "model": "google/gemini-2.0-flash-001",
    "baseUrl": "https://openrouter.ai/api/v1"
  },
  "contextualRetrieval": {
    "enabled": true,
    "contextProvider": "anthropic",
    "contextApiKey": "sk-ant-...",
    "contextModel": "claude-haiku-4-5-20251001",
    "minContextLength": 20,
    "maxContextLength": 150,
    "contextConcurrency": 4,
    "documentCache": {
      "enabled": true,
      "ttl": 3600000
    },
    "resultCacheCapacity": 1000,
    "signalWeight": 0.7
  },
  "reranker": {
    "enabled": true,
    "provider": "local",
    "topK": 10,
    "topJ": 5
  }
}
```

## Minimal Config (Quick Start)

```json
{
  "contextualRetrieval": {
    "enabled": true,
    "contextProvider": "ollama",
    "contextModel": "llama3.2:3b"
  }
}
```

Uses local Ollama for context generation (no API key needed), falls back to existing embedding and extraction configs.

## Config Validation Rules

```typescript
function validateContextualRetrievalConfig(config: ContextualRetrievalConfig): string[] {
  const errors: string[] = [];

  if (config.enabled) {
    // Must have a context generation provider configured
    const hasApiKey = config.contextApiKey || config.extraction?.apiKey;
    const isLocal = config.contextProvider === "ollama";
    if (!hasApiKey && !isLocal) {
      errors.push(
        "contextualRetrieval requires contextApiKey or extraction.apiKey when using API providers",
      );
    }

    // Signal weight must be 0-1
    if (config.signalWeight !== undefined && (config.signalWeight < 0 || config.signalWeight > 1)) {
      errors.push("contextualRetrieval.signalWeight must be between 0 and 1");
    }

    // Context length bounds
    if (config.minContextLength !== undefined && config.maxContextLength !== undefined) {
      if (config.minContextLength > config.maxContextLength) {
        errors.push("contextualRetrieval.minContextLength must be <= maxContextLength");
      }
    }

    // Concurrency bounds
    if (config.contextConcurrency !== undefined) {
      if (config.contextConcurrency < 1 || config.contextConcurrency > 32) {
        errors.push("contextualRetrieval.contextConcurrency must be between 1 and 32");
      }
    }

    // Validate signal weight overrides
    if (config.signalWeightOverrides) {
      for (const [key, value] of Object.entries(config.signalWeightOverrides)) {
        if (value < 0 || value > 1) {
          errors.push(`contextualRetrieval.signalWeightOverrides.${key} must be between 0 and 1`);
        }
      }
    }
  }

  return errors;
}
```

## Environment Variable Overrides

For deployments where config file changes are impractical:

| Env Var                          | Config Path                           | Type    |
| -------------------------------- | ------------------------------------- | ------- |
| `OPENCLAW_CONTEXTUAL_RETRIEVAL`  | `contextualRetrieval.enabled`         | boolean |
| `OPENCLAW_CONTEXT_MODEL`         | `contextualRetrieval.contextModel`    | string  |
| `OPENCLAW_CONTEXT_API_KEY`       | `contextualRetrieval.contextApiKey`   | string  |
| `OPENCLAW_CONTEXT_PROVIDER`      | `contextualRetrieval.contextProvider` | string  |
| `OPENCLAW_CONTEXT_SIGNAL_WEIGHT` | `contextualRetrieval.signalWeight`    | number  |

These follow the same env var resolution pattern used by existing config fields in `config.ts`.

## CLI Integration

### Status Command

`openclaw memory status` reports contextual retrieval state:

```
Memory Neo4j Status
  Memories: 12,450
  With context: 8,230 (66.1%)
  Contextual indexes: active
  Context model: claude-haiku-4-5-20251001
  Signal weight: 0.7
```

### Migration Command

```
openclaw memory migrate-contextual --agent <id>
  [--batch-size 50]
  [--concurrency 4]
  [--dry-run]
  [--force]
  [--category core,fact,preference]
  [--min-importance 0.3]
  [--phase indexes|migrate|validate]
```

See [migration-plan.md](./migration-plan.md) for full details.

## Backward Compatibility

- `contextualRetrieval.enabled` defaults to `false` -- zero behavior change for existing users
- When disabled, no contextual fields are written and no contextual indexes are created/queried
- Enabling the feature is additive -- existing memories continue to work, new memories get context
- The `signalWeight` parameter allows gradual rollout (e.g., start at 0.3, increase to 0.7)
- Disabling after enabling leaves contextual data in place (harmless) but stops querying it
- No changes to existing config fields -- all new config is in the `contextualRetrieval` block
