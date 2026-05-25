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
    | "cache-write-without-read"
    /** Info-level: v0.2 auto-placement applied a breakpoint we previously hadn't. */
    | "auto-placement-applied"
    /** Info-level: v0.3 auto-reorder canonicalized something to preserve the cache prefix. */
    | "auto-reorder-applied";
  message: string;
  /** Optional structured detail. */
  detail?: Record<string, unknown>;
}

/**
 * v0.3: structured description of a single reorder action the wrapper took
 * before sending the request. Attached to the `auto-reorder-applied` warning.
 */
export interface ReorderDiagnostic {
  /**
   * Which segment was reordered:
   *   - "tools"                     — the tools array was alphabetized by name
   *   - "messages-prefix"           — a leading run of context-only user
   *                                   messages was sorted by content fingerprint
   *   - `messages[N].content`       — same-type content blocks within message N
   *                                   were sorted (only "document"/"image" runs)
   */
  segment: "tools" | "messages-prefix" | string;
  /** Short, single-line explanation suitable for logging. */
  summary: string;
  /** Number of elements that ended up at a different index after the reorder. */
  itemsMoved: number;
  /** Optional structured detail (original/new indices, etc.). */
  detail?: Record<string, unknown>;
}

/**
 * A human-readable summary of what changed in a cacheable prefix between two
 * calls. Surfaced via the `cache-write-without-read` warning when
 * `diagnoseMisses` is enabled.
 */
export interface PrefixDiff {
  /** Which segment changed: 'system', 'tools', or 'messages'. */
  segment: "system" | "tools" | "messages";
  /** Short, single-line explanation suitable for logging. */
  summary: string;
  /** Optional structured detail (indices, byte offsets, token counts). */
  detail?: Record<string, unknown>;
}

/** Per-segment stability tracking, returned by client.stability(). */
export interface StabilityEntry {
  /** Which segment: 'system', 'tools', or 'messages[0..N]'. */
  segment: string;
  /** Number of times this segment was observed across calls. */
  callsObserved: number;
  /** Number of those calls where the fingerprint matched the previous one. */
  callsStable: number;
  /** callsStable / max(1, callsObserved - 1). 1.0 = perfectly stable. */
  stabilityScore: number;
  /** Approximate token count for this segment (chars/4 heuristic). */
  approxTokens: number;
  /** Reason the most recent change happened, if known. */
  lastChangeReason?: string;
}

export interface StabilityReport {
  entries: StabilityEntry[];
  /** Total approximate tokens across all stable segments. */
  totalStableTokens: number;
  /** Total approximate tokens across all observed segments. */
  totalObservedTokens: number;
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
  /**
   * v0.2: when true, the wrapper observes which segments of your request
   * (system, tools, message history) are stable across calls and places
   * `cache_control` breakpoints automatically. Activates only when you have
   * not placed any cache_control markers yourself — never overrides explicit
   * placement. Default: false (opt-in).
   */
  autoCache?: boolean;
  /**
   * v0.2: how many times a segment must be seen unchanged before
   * auto-placement will mark it cacheable. Default: 2 (i.e. seen at least
   * twice in a row identically). Higher values are more conservative.
   */
  autoCacheMinObservations?: number;
  /**
   * v0.2: when true, the wrapper computes a human-readable prefix diff on
   * every cache-write-without-read event and attaches it to the warning
   * detail. Adds a small per-call CPU cost. Default: false (opt-in).
   */
  diagnoseMisses?: boolean;
  /**
   * v0.3: when true, the wrapper canonicalizes order-insensitive parts of the
   * request before sending it so a "slightly shuffled" payload still hits the
   * cache. Specifically:
   *   - tools are alphabetized by name
   *   - runs of same-type reorderable blocks (document/image) within a single
   *     message are sorted by content fingerprint
   *   - a leading run of context-only user messages (RAG pattern: user
   *     messages containing only document/image blocks) is sorted by content
   *     fingerprint
   * Text, tool_use, tool_result, and thinking blocks are never moved. The
   * wrapper also never reorders any segment that already carries a
   * `cache_control` marker — explicit intent always wins. Default: false (opt-in).
   */
  autoReorder?: boolean;
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
