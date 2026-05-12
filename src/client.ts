/**
 * CachedAnthropic — thin wrapper around @anthropic-ai/sdk that:
 *   1) passes the call straight through to the underlying SDK
 *   2) parses the response usage to compute CacheInfo
 *   3) attaches CacheInfo to the returned response
 *   4) updates rolling stats and emits warnings
 *
 * The wrapper is intentionally non-invasive. If you remove the import,
 * your code still works — you just lose visibility.
 */

import Anthropic from "@anthropic-ai/sdk";

import { hasAnyCacheControl } from "./analyzer/breakpoint-placer.js";
import { safeEmit } from "./diagnostics/warnings.js";
import { lookupPricing } from "./pricing/models.js";
import { computeCacheInfo } from "./tracking/hit-rate.js";
import { StatsAggregator } from "./tracking/stats.js";
import type {
  AnthropicUsage,
  CacheInfo,
  CachedAnthropicOptions,
  CacheStats,
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
  }

  /** Aggregate stats across every call made through this client. */
  stats(): CacheStats {
    return this.stats_.snapshot();
  }

  /** Reset accumulated stats (useful in tests / between sessions). */
  resetStats(): void {
    this.stats_.reset();
    this.warnedAboutNoCacheControl = false;
  }

  /**
   * Mirror of `anthropic.messages` with a wrapped `create`. We expose only
   * `create` for v0.1; streaming arrives in v0.2.
   */
  public readonly messages = {
    create: async (
      params: Anthropic.MessageCreateParamsNonStreaming,
    ): Promise<CachedMessage> => {
      // One-time check: did the user mark anything cacheable at all?
      if (
        !this.warnedAboutNoCacheControl &&
        !hasAnyCacheControl({
          system: params.system as
            | string
            | Array<{ type: "text"; text: string }>
            | undefined,
          messages: params.messages as Array<{
            role: "user" | "assistant";
            content: string | Array<{ type: string; [k: string]: unknown }>;
          }>,
          tools: params.tools as Array<{ [k: string]: unknown }> | undefined,
        })
      ) {
        this.warnedAboutNoCacheControl = true;
        safeEmit(this.opts.onWarning, {
          code: "no-cache-control-found",
          message:
            "No cache_control markers found in this request. cachet has nothing to optimize until you mark something cacheable. See `placeBreakpoints()` for a quick start.",
        });
      }

      const response = await this.raw.messages.create(params);

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
        safeEmit(this.opts.onWarning, {
          code: "cache-write-without-read",
          message:
            "This call wrote to the cache but read nothing — your cacheable prefix likely changed since the last call. Common causes: tools reordered, retrieved docs shuffled, or the cache TTL (default 5 min) expired.",
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
