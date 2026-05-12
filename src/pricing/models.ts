/**
 * Per-model pricing in USD per million tokens.
 *
 * IMPORTANT: pricing changes. Verify against
 * https://www.anthropic.com/pricing before relying on these in production,
 * or pass `pricingOverride` to the client constructor.
 *
 * Caching multipliers (Anthropic):
 *   - cacheWrite ≈ 1.25× input
 *   - cacheRead  ≈ 0.10× input
 *
 * Last reviewed: May 2026.
 */

import type { ModelPricing } from "../types.js";

const cacheMultipliers = { write: 1.25, read: 0.1 } as const;

function withCache(input: number, output: number): ModelPricing {
  return {
    input,
    output,
    cacheWrite: input * cacheMultipliers.write,
    cacheRead: input * cacheMultipliers.read,
  };
}

/**
 * Known model pricing. Keys are matched as prefixes against the model id
 * passed to messages.create — so "claude-sonnet-4-6-20260101" still maps
 * to the "claude-sonnet-4-6" entry.
 */
export const KNOWN_MODELS: Record<string, ModelPricing> = {
  // Claude 4.6 family
  "claude-opus-4-6": withCache(15, 75),
  "claude-sonnet-4-6": withCache(3, 15),

  // Claude 4.5 family
  "claude-haiku-4-5": withCache(0.8, 4),

  // Claude 4 family (kept for back-compat)
  "claude-opus-4": withCache(15, 75),
  "claude-sonnet-4": withCache(3, 15),
  "claude-haiku-4": withCache(0.8, 4),

  // Claude 3.x family (legacy)
  "claude-3-5-sonnet": withCache(3, 15),
  "claude-3-5-haiku": withCache(0.8, 4),
  "claude-3-opus": withCache(15, 75),
  "claude-3-haiku": withCache(0.25, 1.25),
};

/**
 * Look up pricing for a model id. Returns undefined if the model is unknown
 * — caller can surface a warning and skip dollar accounting for that call.
 */
export function lookupPricing(
  modelId: string,
  overrides?: Partial<Record<string, ModelPricing>>,
): ModelPricing | undefined {
  // Check overrides first (exact match)
  if (overrides?.[modelId]) return overrides[modelId];

  // Then prefix-match against known models, longest prefix wins
  const candidates = Object.keys(KNOWN_MODELS)
    .filter((prefix) => modelId.startsWith(prefix))
    .sort((a, b) => b.length - a.length);

  if (candidates.length > 0) {
    const key = candidates[0]!;
    return KNOWN_MODELS[key];
  }

  // Check overrides for prefix match as a fallback
  if (overrides) {
    const overrideCandidates = Object.keys(overrides)
      .filter((prefix) => modelId.startsWith(prefix))
      .sort((a, b) => b.length - a.length);
    if (overrideCandidates.length > 0) {
      const key = overrideCandidates[0]!;
      return overrides[key];
    }
  }

  return undefined;
}
