/**
 * Public types for cachet.
 *
 * These mirror the relevant shapes from @anthropic-ai/sdk without taking a
 * hard runtime dependency. We keep the surface narrow on purpose — only what
 * the wrapper actually touches.
 */

/** Supported Anthropic model identifiers (kept loose — pass any string). */
export type ModelId = string;

/**
 * The relevant subset of the Anthropic usage object returned on every
 * messages.create response. We only read the fields we need.
 */
export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/** Per-call cache information attached to responses by the wrapper. */
export interface CacheInfo {
  /** Whether any portion of this call was served from cache. */
  hit: boolean;
  /** Tokens served from cache (priced at ~10% of input). */
  cachedTokens: number;
  /** Tokens that had to be processed fresh. */
  uncachedTokens: number;
  /** Tokens written to the cache on this call (priced at ~125% of input). */
  cacheWriteTokens: number;
  /** Estimated dollars saved on this call vs. an uncached call. */
  dollarsSaved: number;
  /** What this call actually cost in dollars (input + cached + output). */
  dollarsSpent: number;
}

/** Aggregate stats across all calls made through this client. */
export interface CacheStats {
  totalCalls: number;
  cacheHits: number;
  /** cacheHits / totalCalls. 0 when totalCalls is 0. */
  hitRate: number;
  totalCachedTokens: number;
  totalUncachedTokens: number;
  totalCacheWriteTokens: number;
  /** Cumulative dollars saved vs. an uncached baseline. */
  dollarsSaved: number;
  /** Cumulative dollars spent through this client. */
  dollarsSpent: number;
}

/** A warning event emitted at runtime. Passive — never throws or blocks. */
export interface WarningEvent {
  code:
    | "low-hit-rate"
    | "unknown-model"
    | "no-cache-control-found"
    | "cache-write-without-read";
  message: string;
  /** Optional structured detail. */
  detail?: Record<string, unknown>;
}

/** Options for constructing a CachedAnthropic client. */
export interface CachedAnthropicOptions {
  apiKey?: string;
  /** Base URL override (passed through to the underlying SDK). */
  baseURL?: string;
  /**
   * Emit a `low-hit-rate` warning when the rolling hit rate (over the last
   * `hitRateWindow` calls) drops below this value. Set to 0 to disable.
   * Defaults to 0 (disabled) so quickstart usage is silent.
   */
  warnIfHitRateBelow?: number;
  /** How many recent calls to consider for the rolling hit rate. Default 20. */
  hitRateWindow?: number;
  /** Override pricing for one or more models. Useful when pricing changes. */
  pricingOverride?: Partial<Record<string, ModelPricing>>;
  /** Receive warning events. Default: emits to console.warn. */
  onWarning?: (event: WarningEvent) => void;
  /** Pass through any additional options to the underlying Anthropic SDK. */
  anthropicClientOptions?: Record<string, unknown>;
}

/** Per-million-token pricing in USD. */
export interface ModelPricing {
  /** USD per million standard input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
  /** USD per million tokens written to cache (typically ~125% of input). */
  cacheWrite: number;
  /** USD per million tokens read from cache (typically ~10% of input). */
  cacheRead: number;
}
