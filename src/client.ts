/**
 * CachedAnthropic — thin wrapper around @anthropic-ai/sdk that:
 *   1) passes the call straight through to the underlying SDK
 *   2) parses the response usage to compute CacheInfo
 *   3) attaches CacheInfo to the returned response
 *   4) updates rolling stats and emits warnings
 *
 * v0.2 additions (all opt-in):
 *   - autoCache:        observe stability across calls and place cache_control
 *                       breakpoints automatically.
 *   - diagnoseMisses:   when the cache misses, compute a human-readable diff
 *                       of what changed in the cacheable prefix.
 *   - client.stability(): inspect per-segment stability.
 *
 * The wrapper is intentionally non-invasive. If you remove the import,
 * your code still works — you just lose visibility.
 */

import Anthropic from "@anthropic-ai/sdk";

import { autoPlaceBreakpoints } from "./analyzer/auto-placer.js";
import { hasAnyCacheControl } from "./analyzer/breakpoint-placer.js";
import { snapshotRequest } from "./analyzer/fingerprint.js";
import { StabilityTracker } from "./analyzer/stability-tracker.js";
import { diffSnapshots } from "./diagnostics/diff.js";
import { safeEmit } from "./diagnostics/warnings.js";
import { lookupPricing } from "./pricing/models.js";
import { computeCacheInfo } from "./tracking/hit-rate.js";
import { StatsAggregator } from "./tracking/stats.js";
import type {
  AnthropicUsage,
  CacheInfo,
  CachedAnthropicOptions,
  CacheStats,
  StabilityReport,
} from "./types.js";

/**
 * Response type augmented with cacheInfo. We don't redeclare the full
 * Anthropic.Message type — we intersect it so all existing fields flow through.
 */
export type CachedMessage = Anthropic.Message & { cacheInfo: CacheInfo };

/**
 * Drop-in replacement for `new Anthropic({...})`. Use exactly the same way;
 * the only difference is that responses gain a `.cacheInfo` field and the
 * client exposes `.stats()`.
 */
export class CachedAnthropic {
  /**
   * The underlying Anthropic SDK client. Exposed for advanced use
   * (e.g. accessing beta endpoints we haven't wrapped).
   */
  public readonly raw: Anthropic;

  private readonly stats_: StatsAggregator;
  private readonly tracker: StabilityTracker;
  private readonly opts: CachedAnthropicOptions;
  private warnedAboutNoCacheControl = false;

  constructor(opts: CachedAnthropicOptions = {}) {
    this.opts = opts;
    this.raw = new Anthropic({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
      ...(opts.anthropicClientOptions ?? {}),
    });
    this.stats_ = new StatsAggregator(opts.hitRateWindow ?? 20);
    this.tracker = new StabilityTracker();
  }

  /** Aggregate stats across every call made through this client. */
  stats(): CacheStats {
    return this.stats_.snapshot();
  }

  /**
   * v0.2: per-segment stability report. Useful for debugging which part of
   * your prompt is drifting before it costs you money.
   */
  stability(): StabilityReport {
    return this.tracker.report();
  }

  /** Reset accumulated stats (useful in tests / between sessions). */
  resetStats(): void {
    this.stats_.reset();
    this.tracker.reset();
    this.warnedAboutNoCacheControl = false;
  }

  /**
   * Mirror of `anthropic.messages` with a wrapped `create`. We expose only
   * `create` for v0.1; streaming arrives in a later version.
   */
  public readonly messages = {
    create: async (
      params: Anthropic.MessageCreateParamsNonStreaming,
    ): Promise<CachedMessage> => {
      // Take a snapshot of what the USER sent (pre-modification) so the
      // stability tracker and diff engine see the original payload.
      const userSystem = params.system as
        | string
        | Array<{ type: "text"; text: string }>
        | undefined;
      const userTools = params.tools as
        | Array<{ [k: string]: unknown }>
        | undefined;
      const userMessages = params.messages as Array<{
        role: "user" | "assistant";
        content: string | Array<{ type: string; [k: string]: unknown }>;
      }>;

      const previousSnapshot = this.tracker.previousSnapshot();
      const currentSnapshot = snapshotRequest({
        system: userSystem,
        tools: userTools,
        messages: userMessages,
      });
      this.tracker.observe(currentSnapshot);

      // Decide what to actually send: maybe auto-place breakpoints.
      let outgoing: Anthropic.MessageCreateParamsNonStreaming = params;
      const userMarkedCache = hasAnyCacheControl({
        system: userSystem,
        messages: userMessages,
        tools: userTools,
      });

      if (this.opts.autoCache && !userMarkedCache) {
        const placed = autoPlaceBreakpoints({
          system: userSystem,
          tools: userTools,
          messages: userMessages,
          tracker: this.tracker,
          minObservations: this.opts.autoCacheMinObservations ?? 2,
        });
        if (placed.placements.length > 0) {
          outgoing = {
            ...params,
            ...(placed.system !== undefined
              ? { system: placed.system as unknown as Anthropic.MessageCreateParamsNonStreaming["system"] }
              : {}),
            ...(placed.tools !== undefined
              ? { tools: placed.tools as unknown as Anthropic.MessageCreateParamsNonStreaming["tools"] }
              : {}),
            messages: placed.messages as unknown as Anthropic.MessageCreateParamsNonStreaming["messages"],
          };
          safeEmit(this.opts.onWarning, {
            code: "auto-placement-applied",
            message: `Auto-placement added ${placed.placements.length} cache_control breakpoint(s) based on observed stability.`,
            detail: { placements: placed.placements },
          });
        }
      }

      // One-time check: did the user mark anything cacheable at all (and
      // auto-cache didn't fix it for them)?
      const finalHasCache =
        userMarkedCache ||
        hasAnyCacheControl({
          system: (outgoing.system as
            | string
            | Array<{ type: "text"; text: string }>
            | undefined) ?? undefined,
          messages: outgoing.messages as Array<{
            role: "user" | "assistant";
            content: string | Array<{ type: string; [k: string]: unknown }>;
          }>,
          tools: outgoing.tools as
            | Array<{ [k: string]: unknown }>
            | undefined,
        });

      if (!this.warnedAboutNoCacheControl && !finalHasCache) {
        this.warnedAboutNoCacheControl = true;
        safeEmit(this.opts.onWarning, {
          code: "no-cache-control-found",
          message:
            "No cache_control markers found in this request. prompt-cache-optimizer has nothing to optimize until you mark something cacheable. See `placeBreakpoints()` or set `autoCache: true`.",
        });
      }

      const response = await this.raw.messages.create(outgoing);

      const pricing = lookupPricing(
        params.model,
        this.opts.pricingOverride,
      );

      if (!pricing) {
        safeEmit(this.opts.onWarning, {
          code: "unknown-model",
          message: `Pricing unknown for model "${params.model}" — dollar accounting will report 0 for this call.`,
          detail: { model: params.model },
        });
      }

      const usage = response.usage as AnthropicUsage;
      const cacheInfo = computeCacheInfo(usage, pricing);

      // Cache write but no read suggests prefix changed call-over-call
      if (
        cacheInfo.cacheWriteTokens > 0 &&
        cacheInfo.cachedTokens === 0 &&
        this.stats_.snapshot().totalCalls > 0
      ) {
        const detail: Record<string, unknown> = {};
        if (this.opts.diagnoseMisses && previousSnapshot) {
          const diffs = diffSnapshots(previousSnapshot, currentSnapshot);
          if (diffs.length > 0) {
            detail.diff = diffs;
            detail.summary = diffs.map((d) => d.summary).join("; ");
          }
        }
        safeEmit(this.opts.onWarning, {
          code: "cache-write-without-read",
          message:
            "This call wrote to the cache but read nothing — your cacheable prefix likely changed since the last call. Common causes: tools reordered, retrieved docs shuffled, or the cache TTL (default 5 min) expired." +
            (detail.summary ? ` Detected: ${detail.summary as string}` : ""),
          ...(Object.keys(detail).length > 0 ? { detail } : {}),
        });
      }

      this.stats_.record(cacheInfo);

      // Rolling hit-rate alert
      const threshold = this.opts.warnIfHitRateBelow ?? 0;
      const window = this.opts.hitRateWindow ?? 20;
      if (
        threshold > 0 &&
        this.stats_.rollingSampleCount() >= window &&
        this.stats_.rollingHitRate() < threshold
      ) {
        safeEmit(this.opts.onWarning, {
          code: "low-hit-rate",
          message: `Rolling cache hit rate (${(
            this.stats_.rollingHitRate() * 100
          ).toFixed(1)}%) over the last ${window} calls is below your threshold of ${(threshold * 100).toFixed(1)}%.`,
          detail: {
            rollingHitRate: this.stats_.rollingHitRate(),
            threshold,
            window,
          },
        });
      }

      // Augment response (use defineProperty so we don't clobber the SDK's type)
      Object.defineProperty(response, "cacheInfo", {
        value: cacheInfo,
        enumerable: true,
        writable: false,
        configurable: false,
      });

      return response as CachedMessage;
    },
  };
}
