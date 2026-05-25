/**
 * Options for the CachedOpenAI wrapper.
 *
 * Mirrors the v0.1-0.3 CachedAnthropicOptions surface where the semantics
 * carry over, and adds one OpenAI-specific option (warnIfPromptTooSmall)
 * for the case OpenAI's automatic cache won't trigger.
 */

import type { ModelPricing, WarningEvent } from "../../types.js";

export interface CachedOpenAIOptions {
  apiKey?: string;
  /** Base URL override (passed through to the underlying SDK). */
  baseURL?: string;
  /** Organization id (passed through to the OpenAI SDK). */
  organization?: string;
  /** Project id (passed through to the OpenAI SDK). */
  project?: string;
  /**
   * Emit a `low-hit-rate` warning when the rolling hit rate drops below
   * this value. Set to 0 to disable. Default 0.
   */
  warnIfHitRateBelow?: number;
  /** Rolling window size. Default 20. */
  hitRateWindow?: number;
  /** Override per-model pricing. */
  pricingOverride?: Partial<Record<string, ModelPricing>>;
  /** Receive warning events. Default: emits to console.warn. */
  onWarning?: (event: WarningEvent) => void;
  /** Pass through additional options to the underlying OpenAI SDK. */
  openaiClientOptions?: Record<string, unknown>;
  /**
   * v0.3-style auto-reorder. For OpenAI we sort the `tools` array by
   * `function.name` so a shuffled tools list still hits the automatic
   * prompt cache. Default false (opt-in).
   */
  autoReorder?: boolean;
  /**
   * v0.2-style cache-miss diagnostic: when the cache misses on a call that
   * had cache activity earlier in the session, compute a human-readable
   * diff of what changed in the request prefix. Default false (opt-in).
   */
  diagnoseMisses?: boolean;
  /**
   * Emit a `prompt-too-small-for-cache` warning when the prompt is below
   * OpenAI's automatic cache threshold (1024 tokens by default — the cache
   * cannot trigger no matter what you do). Default true. Set to false to
   * silence; set to a number to override the threshold.
   */
  warnIfPromptTooSmall?: boolean | number;
}

/** OpenAI's documented automatic-caching minimum prompt size, in tokens. */
export const OPENAI_CACHE_MIN_TOKENS = 1024;
