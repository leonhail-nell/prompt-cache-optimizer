/**
 * OpenAI per-model pricing in USD per million tokens.
 *
 * IMPORTANT: pricing changes. Verify against
 * https://openai.com/api/pricing before relying on these in production,
 * or pass `pricingOverride` to the client constructor.
 *
 * OpenAI prompt caching:
 *   - Caching is AUTOMATIC for prompts >= 1024 tokens — there is no
 *     `cache_control` marker to place. The API maintains a cache prefix
 *     in 128-token segments, longest match wins.
 *   - `cached_tokens` are billed at the "cached input" rate, which is
 *     typically 50% of the standard input rate (gpt-4o family, gpt-4-turbo)
 *     or 25% for newer reasoning models (o3, o4-mini, o1).
 *   - There is no separate "cache write" charge — the first call that
 *     populates the cache is just billed at the standard input rate.
 *
 * Last verified against openai.com/api/pricing: May 25, 2026.
 */

import type { ModelPricing } from "../../types.js";

/**
 * Helper for OpenAI where there is no cache-write multiplier — the first
 * call pays the standard input rate, subsequent reads pay the cached rate.
 * We set cacheWrite to the input rate so dollar accounting balances when
 * the wrapper records a "miss" call (it bills the prompt at input rate
 * regardless of whether OpenAI internally allocated a cache slot for it).
 */
function withCachedRate(
  input: number,
  output: number,
  cacheReadMultiplier: number,
): ModelPricing {
  return {
    input,
    output,
    cacheWrite: input, // OpenAI doesn't charge extra for cache writes
    cacheRead: input * cacheReadMultiplier,
  };
}

/** OpenAI's standard cached-input discount for GPT-4-class models is 50%. */
const HALF = 0.5;
/** OpenAI's reasoning models (o-series) discount cached input by 75%. */
const QUARTER = 0.25;

/**
 * Known model pricing. Keys are matched as prefixes against the model id
 * passed to chat.completions.create — so "gpt-4o-2024-08-06" still maps to
 * the "gpt-4o" entry. Longer prefixes win, so version-specific entries
 * take precedence over family entries.
 */
export const KNOWN_OPENAI_MODELS: Record<string, ModelPricing> = {
  // GPT-4o family (cached_input is 50% of input)
  "gpt-4o-mini": withCachedRate(0.15, 0.6, HALF),
  "gpt-4o": withCachedRate(2.5, 10, HALF),
  // GPT-4.1 family (introduced 2025; same 50% cached discount)
  "gpt-4.1-nano": withCachedRate(0.1, 0.4, HALF),
  "gpt-4.1-mini": withCachedRate(0.4, 1.6, HALF),
  "gpt-4.1": withCachedRate(2, 8, HALF),
  // GPT-4 turbo
  "gpt-4-turbo": withCachedRate(10, 30, HALF),
  // Reasoning / o-series (75% cached discount)
  "o1-mini": withCachedRate(1.1, 4.4, HALF),
  "o1-preview": withCachedRate(15, 60, HALF),
  "o1": withCachedRate(15, 60, HALF),
  "o3-mini": withCachedRate(1.1, 4.4, QUARTER),
  "o3": withCachedRate(2, 8, QUARTER),
  "o4-mini": withCachedRate(1.1, 4.4, QUARTER),
};

/**
 * Look up OpenAI pricing for a model id. Returns undefined if the model is
 * unknown — caller can surface a warning and skip dollar accounting.
 *
 * Resolution order:
 *   1. Exact match in overrides
 *   2. Longest prefix match in KNOWN_OPENAI_MODELS
 *   3. Longest prefix match in overrides
 */
export function lookupOpenAIPricing(
  modelId: string,
  overrides?: Partial<Record<string, ModelPricing>>,
): ModelPricing | undefined {
  if (overrides?.[modelId]) return overrides[modelId];

  const candidates = Object.keys(KNOWN_OPENAI_MODELS)
    .filter((prefix) => modelId.startsWith(prefix))
    .sort((a, b) => b.length - a.length);
  if (candidates.length > 0) {
    const key = candidates[0]!;
    return KNOWN_OPENAI_MODELS[key];
  }

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
