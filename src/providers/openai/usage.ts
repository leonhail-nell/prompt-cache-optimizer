/**
 * Compute per-call CacheInfo from an OpenAI chat.completions usage object.
 *
 * OpenAI's usage shape:
 *   {
 *     prompt_tokens: 8732,                    // TOTAL prompt tokens (incl. cached)
 *     completion_tokens: 480,
 *     total_tokens: 9212,
 *     prompt_tokens_details: {
 *       cached_tokens: 8420,                  // cached subset of prompt_tokens
 *     }
 *   }
 *
 * Important shape difference from Anthropic: OpenAI's `prompt_tokens` already
 * INCLUDES the cached portion. We have to subtract to get the uncached
 * fresh-processing portion.
 *
 * OpenAI does not bill a separate "cache write" rate. The first call that
 * populates the cache is billed at the standard input rate. So
 * cacheWriteTokens is always 0 from OpenAI's perspective.
 */

import type { CacheInfo, ModelPricing } from "../../types.js";

const PER_MILLION = 1_000_000;

/** Minimal shape of OpenAI's CompletionUsage we actually read. */
export interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
}

export function computeOpenAICacheInfo(
  usage: OpenAIUsage,
  pricing: ModelPricing | undefined,
): CacheInfo {
  const cachedTokens = usage.prompt_tokens_details?.cached_tokens ?? 0;
  const totalPromptTokens = usage.prompt_tokens ?? 0;
  // Uncached = total prompt minus the cached subset
  const uncachedTokens = Math.max(0, totalPromptTokens - cachedTokens);
  const outputTokens = usage.completion_tokens ?? 0;

  const hit = cachedTokens > 0;

  if (!pricing) {
    return {
      hit,
      cachedTokens,
      uncachedTokens,
      cacheWriteTokens: 0, // OpenAI has no separate write charge
      dollarsSaved: 0,
      dollarsSpent: 0,
    };
  }

  // Savings = what the cached tokens would have cost at full input rate,
  // minus what they actually cost at the cached rate.
  const wouldHaveCost = (cachedTokens * pricing.input) / PER_MILLION;
  const actuallyCost = (cachedTokens * pricing.cacheRead) / PER_MILLION;
  const dollarsSaved = wouldHaveCost - actuallyCost;

  const dollarsSpent =
    (uncachedTokens * pricing.input) / PER_MILLION +
    (cachedTokens * pricing.cacheRead) / PER_MILLION +
    (outputTokens * pricing.output) / PER_MILLION;

  return {
    hit,
    cachedTokens,
    uncachedTokens,
    cacheWriteTokens: 0,
    dollarsSaved,
    dollarsSpent,
  };
}
