/**
 * Compute per-call CacheInfo from a Gemini generateContent response.
 *
 * Gemini's usageMetadata shape:
 *   {
 *     promptTokenCount: 8732,        // TOTAL prompt tokens (incl. cached)
 *     candidatesTokenCount: 480,     // output tokens
 *     cachedContentTokenCount: 8420, // cached subset of promptTokenCount
 *     totalTokenCount: 9212,
 *   }
 *
 * Like OpenAI: `promptTokenCount` ALREADY INCLUDES the cached portion.
 * Subtract to get the un-cached portion.
 *
 * Gemini doesn't bill a separate per-token "cache write" charge — the
 * first call that populates the cache is billed at the standard input
 * rate. (Explicit CachedContent has a separate per-hour storage cost,
 * which this wrapper does not model — track it on your Google Cloud
 * billing instead.)
 */

import type { CacheInfo, ModelPricing } from "../../types.js";

const PER_MILLION = 1_000_000;

/** Minimal shape of Gemini's usageMetadata we actually read. */
export interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
  totalTokenCount?: number;
}

export function computeGeminiCacheInfo(
  usage: GeminiUsageMetadata | undefined,
  pricing: ModelPricing | undefined,
): CacheInfo {
  const u = usage ?? {};
  const cachedTokens = u.cachedContentTokenCount ?? 0;
  const totalPromptTokens = u.promptTokenCount ?? 0;
  const uncachedTokens = Math.max(0, totalPromptTokens - cachedTokens);
  const outputTokens = u.candidatesTokenCount ?? 0;

  const hit = cachedTokens > 0;

  if (!pricing) {
    return {
      hit,
      cachedTokens,
      uncachedTokens,
      cacheWriteTokens: 0,
      dollarsSaved: 0,
      dollarsSpent: 0,
    };
  }

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
