// Hardcoded last-resort defaults when no config is available at all.
// Keep this aligned with the product-level latest-model baseline.
// Prefer resolveDefaultsFromConfig() whenever a config object is in scope.
export const DEFAULT_PROVIDER = "openai";
export const DEFAULT_MODEL = "gpt-5.5";
// Conservative fallback used when model metadata is unavailable.
export const DEFAULT_CONTEXT_TOKENS = 200_000;

/**
 * Derive the default provider/model from the user's config
 * (`agents.defaults.model.primary`) instead of the hardcoded constant.
 * Falls back to DEFAULT_PROVIDER / DEFAULT_MODEL only when the config has no primary.
 */
export function resolveDefaultsFromConfig(agentsConfig?: {
  defaults?: { model?: string | { primary?: string } };
}): { provider: string; model: string } {
  const raw = agentsConfig?.defaults?.model;
  const primary =
    typeof raw === "string" ? raw.trim() : typeof raw === "object" ? raw?.primary?.trim() : "";
  if (primary && primary.includes("/")) {
    const slashIdx = primary.indexOf("/");
    return {
      provider: primary.slice(0, slashIdx),
      model: primary.slice(slashIdx + 1),
    };
  }
  return { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL };
}
