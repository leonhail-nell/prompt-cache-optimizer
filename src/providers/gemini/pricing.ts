/**
 * Gemini per-model pricing in USD per million tokens.
 *
 * IMPORTANT: pricing changes. Verify against
 * https://ai.google.dev/pricing before relying on these in production,
 * or pass `pricingOverride` to the client constructor.
 *
 * Gemini prompt caching:
 *   - IMPLICIT caching: automatic for Gemini 2.5 models. Cache hits show
 *     up in `usageMetadata.cachedContentTokenCount`. No setup required.
 *   - EXPLICIT caching (CachedContent API): you POST `caches.create()`
 *     with the prefix you want cached, get back a cache resource with a
 *     name, then pass `config.cachedContent: name` on subsequent calls.
 *     You're billed for cache storage by time (per million tokens per
 *     hour), separately from per-token costs.
 *   - Cached input tokens are billed at ~25% of the standard input rate
 *     (75% discount) for 2.5 Flash/Pro. Older models vary.
 *
 * Last verified against ai.google.dev/pricing: May 25, 2026.
 */

import type { ModelPricing } from "../../types.js";

/**
 * Helper that builds a Gemini pricing entry. Gemini doesn't bill a
 * separate "cache write" rate the way Anthropic does — the first call
 * that populates the cache just pays the standard input rate (the same
 * shape we use for OpenAI).
 */
function withCachedRate(
  input: number,
  output: number,
  cacheReadMultiplier: number,
): ModelPricing {
  return {
    input,
    output,
    cacheWrite: input,
    cacheRead: input * cacheReadMultiplier,
  };
}

/** Gemini 2.5 family cached-input is ~25% of input (75% discount). */
const QUARTER = 0.25;

/**
 * Known Gemini model pricing. Matched as prefixes — so
 * "gemini-2.5-flash-001" still maps to "gemini-2.5-flash". Longer
 * prefixes win.
 *
 * The "gemini-2.5-flash" tier prices below assume the standard text/short
 * context. Long-context tier (above 128k input tokens) is sometimes
 * billed at a different rate — override per-instance if you regularly
 * exceed that window.
 */
export const KNOWN_GEMINI_MODELS: Record<string, ModelPricing> = {
  // 2.5 family (active May 2026)
  "gemini-2.5-pro": withCachedRate(1.25, 10, QUARTER),
  "gemini-2.5-flash": withCachedRate(0.1, 0.4, QUARTER),
  "gemini-2.5-flash-lite": withCachedRate(0.075, 0.3, QUARTER),
  // 2.0 family (legacy, still callable)
  "gemini-2.0-flash": withCachedRate(0.1, 0.4, QUARTER),
  "gemini-2.0-flash-lite": withCachedRate(0.075, 0.3, QUARTER),
  // 1.5 family
  "gemini-1.5-pro": withCachedRate(1.25, 5, QUARTER),
  "gemini-1.5-flash": withCachedRate(0.075, 0.3, QUARTER),
};

/**
 * Look up Gemini pricing for a model id. Accepts the bare model id
 * ("gemini-2.5-flash") or the full resource form
 * ("models/gemini-2.5-flash" / "publishers/google/models/...").
 *
 * Resolution order:
 *   1. Exact match in overrides
 *   2. Longest prefix match in KNOWN_GEMINI_MODELS
 *   3. Longest prefix match in overrides
 */
export function lookupGeminiPricing(
  modelId: string,
  overrides?: Partial<Record<string, ModelPricing>>,
): ModelPricing | undefined {
  // Strip resource-name prefixes so the prefix match works regardless.
  const normalized = modelId
    .replace(/^models\//, "")
    .replace(/^publishers\/[^/]+\/models\//, "");

  if (overrides?.[modelId]) return overrides[modelId];
  if (overrides?.[normalized]) return overrides[normalized];

  const candidates = Object.keys(KNOWN_GEMINI_MODELS)
    .filter((prefix) => normalized.startsWith(prefix))
    .sort((a, b) => b.length - a.length);
  if (candidates.length > 0) {
    const key = candidates[0]!;
    return KNOWN_GEMINI_MODELS[key];
  }

  if (overrides) {
    const overrideCandidates = Object.keys(overrides)
      .filter((prefix) => normalized.startsWith(prefix))
      .sort((a, b) => b.length - a.length);
    if (overrideCandidates.length > 0) {
      const key = overrideCandidates[0]!;
      return overrides[key];
    }
  }

  return undefined;
}
