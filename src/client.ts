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
 * v0.3 additions (all opt-in):
 *   - autoReorder:      canonicalize order-insensitive parts of the request
 *                       (tools, runs of document/image content blocks,
 *                       leading user-context message prefix) before sending,
 *                       so a shuffled payload still hits the cache.
 *
 * The wrapper is intentionally non-invasive. If you remove the import,
 * your code still works — you just lose visibility.
 */

import Anthropic from "@anthropic-ai/sdk";

import { autoPlaceBreakpoints } from "./analyzer/auto-placer.js";
import { hasAnyCacheControl } from "./analyzer/breakpoint-placer.js";
import { snapshotRequest } from "./analyzer/fingerprint.js";
import { applyAutoReorder } from "./analyzer/reorderer.js";
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
  /**
   * Signature of the last placement set we emitted an auto-placement-applied
   * event for. We only re-emit when this CHANGES so the warning isn't
   * triggered on every call once a steady-state placement is reached.
   */
  private lastAnnouncedPlacements: string | undefined;

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
    this.lastAnnouncedPlacements = undefined;
  }

  /**
   * Mirror of `anthropic.messages` with a wrapped `create`. We expose only
   * `create` for v0.1; streaming arrives in a later version.
   */
  public readonly messages = {
    create: async (
      params: Anthropic.MessageCreateParamsNonStreaming,
    ): Promise<CachedMessage> => {
      // Take a typed view of what the USER sent. We may rewrite this below
      // (auto-reorder, auto-place) before forwarding to the SDK.
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

      // STEP 1 — auto-reorder. We do this FIRST so that the stability
      // tracker, the auto-placer, and the cache-miss diagnostic all see the
      // canonicalized form (i.e. what actually goes over the wire).
      let workingSystem = userSystem;
      let workingTools = userTools;
      let workingMessages = userMessages;
      if (this.opts.autoReorder) {
        const reordered = applyAutoReorder({
          system: workingSystem,
          tools: workingTools,
          messages: workingMessages,
        });
        workingSystem = reordered.system;
        workingTools = reordered.tools;
        workingMessages = reordered.messages as typeof workingMessages;
        if (reordered.diagnostics.length > 0) {
          safeEmit(this.opts.onWarning, {
            code: "auto-reorder-applied",
            message:
              "Auto-reorder canonicalized order-insensitive parts of the request to preserve the cache prefix: " +
              reordered.diagnostics.map((d) => d.summary).join("; "),
            detail: { diagnostics: reordered.diagnostics },
          });
        }
      }

      // STEP 2 — snapshot the canonical form so the tracker reflects what
      // actually went over the wire.
      const previousSnapshot = this.tracker.previousSnapshot();
      const currentSnapshot = snapshotRequest({
        system: workingSystem,
        tools: workingTools,
        messages: workingMessages,
      });
      this.tracker.observe(currentSnapshot);

      // STEP 3 — decide what to actually send: maybe auto-place breakpoints.
      // Start from a shallow copy of the input but with the canonicalized
      // segments swapped in.
      let outgoing: Anthropic.MessageCreateParamsNonStreaming = {
        ...params,
        ...(workingSystem !== undefined
          ? { system: workingSystem as unknown as Anthropic.MessageCreateParamsNonStreaming["system"] }
          : {}),
        ...(workingTools !== undefined
          ? { tools: workingTools as unknown as Anthropic.MessageCreateParamsNonStreaming["tools"] }
          : {}),
        messages: workingMessages as unknown as Anthropic.MessageCreateParamsNonStreaming["messages"],
      };
      const userMarkedCache = hasAnyCacheControl({
        system: workingSystem,
        messages: workingMessages,
        tools: workingTools,
      });

      if (this.opts.autoCache && !userMarkedCache) {
        const placed = autoPlaceBreakpoints({
          system: workingSystem,
          tools: workingTools,
          messages: workingMessages,
          tracker: this.tracker,
          minObservations: this.opts.autoCacheMinObservations ?? 2,
        });
        if (placed.placements.length > 0) {
          outgoing = {
            ...outgoing,
            ...(placed.system !== undefined
              ? { system: placed.system as unknown as Anthropic.MessageCreateParamsNonStreaming["system"] }
              : {}),
            ...(placed.tools !== undefined
              ? { tools: placed.tools as unknown as Anthropic.MessageCreateParamsNonStreaming["tools"] }
              : {}),
            messages: placed.messages as unknown as Anthropic.MessageCreateParamsNonStreaming["messages"],
          };
          // Only announce when the SET of placements changes — once we hit a
          // steady-state ("system is cached"), repeating that on every call
          // is noise.
          const signature = placed.placements
            .map((p) => p.position)
            .sort()
            .join(",");
          if (signature !== this.lastAnnouncedPlacements) {
            this.lastAnnouncedPlacements = signature;
            safeEmit(this.opts.onWarning, {
              code: "auto-placement-applied",
              message: `Auto-placement set: ${placed.placements
                .map((p) => p.position)
                .join(", ")} (based on observed stability).`,
              detail: { placements: placed.placements },
            });
          }
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

      // Suppress this warning when autoCache is on — the user opted into the
      // auto path, and the wrapper just needs more observations before it
      // can place anything. Firing this warning in that mode is contradictory.
      if (
        !this.warnedAboutNoCacheControl &&
        !finalHasCache &&
        !this.opts.autoCache
      ) {
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

      // Cache write but no read suggests prefix changed call-over-call.
      // Only fire when we've already had cache activity on a PRIOR call —
      // otherwise the very first cache write trips a misleading "prefix
      // changed" warning when in fact the cache was just initialized.
      const priorStats = this.stats_.snapshot();
      const hadPriorCacheActivity =
        priorStats.totalCachedTokens > 0 ||
        priorStats.totalCacheWriteTokens > 0;
      if (
        cacheInfo.cacheWriteTokens > 0 &&
        cacheInfo.cachedTokens === 0 &&
        hadPriorCacheActivity
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
