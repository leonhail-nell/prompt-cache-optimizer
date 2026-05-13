/**
 * Per-model pricing in USD per million tokens.
 *
 * IMPORTANT: pricing changes. Verify against
 * https://www.anthropic.com/pricing before relying on these in production,
 * or pass `pricingOverride` to the client constructor.
 *
 * Caching multipliers (Anthropic, 5-minute TTL):
 *   - cacheWrite ≈ 1.25× input
 *   - cacheRead  ≈ 0.10× input
 *
 * Extended 1-hour cache TTL has different pricing — not modeled here.
 * See https://platform.claude.com/docs/en/build-with-claude/prompt-caching
 *
 * Last verified against anthropic.com/pricing: May 13, 2026.
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
 * to the "claude-sonnet-4-6" entry. Longer prefixes win, so version-specific
 * entries take precedence over family entries.
 */
export const KNOWN_MODELS: Record<string, ModelPricing> = {
  // Active flagship (May 2026)
  "claude-opus-4-7": withCache(5, 25),
  "claude-sonnet-4-6": withCache(3, 15),
  "claude-haiku-4-5": withCache(1, 5),

  // Legacy — still callable, listed on pricing page
  "claude-opus-4-6": withCache(5, 25),
  "claude-opus-4-5": withCache(5, 25),
  "claude-sonnet-4-5": withCache(3, 15),
  "claude-opus-4-1": withCache(15, 75),
  "claude-opus-4": withCache(15, 75),
  "claude-sonnet-4": withCache(3, 15),
};

/**
 * Look up pricing for a model id. Returns undefined if the model is unknown
 * — caller can surface a warning and skip dollar accounting for that call.
 *
 * Resolution order:
 *   1. Exact match in overrides
 *   2. Longest prefix match in KNOWN_MODELS
 *   3. Longest prefix match in overrides
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
