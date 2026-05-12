/**
 * Compute per-call CacheInfo from an Anthropic usage object + model pricing.
 *
 * The usage object Anthropic returns looks like:
 *   {
 *     input_tokens: 312,                  // tokens NOT served from cache
 *     output_tokens: 480,
 *     cache_creation_input_tokens: 0,     // tokens written to cache this call
 *     cache_read_input_tokens: 8420,      // tokens served from cache
 *   }
 *
 * - "hit" means cache_read_input_tokens > 0
 * - dollarsSaved = what those cached tokens would have cost at full input price,
 *   minus what they actually cost at the cache-read rate.
 * - dollarsSpent = input + cacheWrite + cacheRead + output, all priced.
 */

import type { AnthropicUsage, CacheInfo, ModelPricing } from "../types.js";

const PER_MILLION = 1_000_000;

export function computeCacheInfo(
  usage: AnthropicUsage,
  pricing: ModelPricing | undefined,
): CacheInfo {
  const cachedTokens = usage.cache_read_input_tokens ?? 0;
  const uncachedTokens = usage.input_tokens ?? 0;
  const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;

  const hit = cachedTokens > 0;

  if (!pricing) {
    return {
      hit,
      cachedTokens,
      uncachedTokens,
      cacheWriteTokens,
      dollarsSaved: 0,
      dollarsSpent: 0,
    };
  }

  // What the cached portion would have cost at full input price
  const wouldHaveCost = (cachedTokens * pricing.input) / PER_MILLION;
  // What it actually cost at the cache-read rate
  const actuallyCost = (cachedTokens * pricing.cacheRead) / PER_MILLION;
  const dollarsSaved = wouldHaveCost - actuallyCost;

  const dollarsSpent =
    (uncachedTokens * pricing.input) / PER_MILLION +
    (cacheWriteTokens * pricing.cacheWrite) / PER_MILLION +
    (cachedTokens * pricing.cacheRead) / PER_MILLION +
    (outputTokens * pricing.output) / PER_MILLION;

  return {
    hit,
    cachedTokens,
    uncachedTokens,
    cacheWriteTokens,
    dollarsSaved,
    dollarsSpent,
  };
}
