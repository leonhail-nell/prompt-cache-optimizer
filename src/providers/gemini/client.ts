/**
 * CachedGemini — drop-in wrapper around `@google/genai` that:
 *   1) forwards generateContent calls to the underlying SDK
 *   2) parses response usageMetadata to compute CacheInfo
 *   3) attaches CacheInfo to the returned response
 *   4) updates rolling stats and emits warnings
 *
 * Gemini has two prompt-caching modes:
 *
 *   1) IMPLICIT caching — automatic for Gemini 2.5 models. You don't
 *      do anything; the wrapper just measures the cache hits from
 *      `usageMetadata.cachedContentTokenCount` and reports
 *      cacheInfo/stats/dollarsSaved.
 *
 *   2) EXPLICIT caching — you (or your application) call
 *      `client.caches.create()` to register a CachedContent, then pass
 *      its `name` in `config.cachedContent` on subsequent calls. The
 *      wrapper exposes the SDK's `caches.*` methods pass-through and
 *      attributes cache hits to the explicit cache when present.
 *
 * Auto-managed explicit caching (the wrapper creates CachedContent
 * objects automatically when prefixes are stable) is on the v0.5
 * roadmap — it requires careful lifecycle and TTL handling.
 *
 * Streaming is not yet wrapped (v0.4 ships non-streaming only).
 */

import { snapshotRequest } from "../../analyzer/fingerprint.js";
import { StabilityTracker } from "../../analyzer/stability-tracker.js";
import { CachedStream } from "../../core/cached-stream.js";
import { diffSnapshots } from "../../diagnostics/diff.js";
import { safeEmit } from "../../diagnostics/warnings.js";
import { StatsAggregator } from "../../tracking/stats.js";
import type {
  CacheInfo,
  CacheStats,
  StabilityReport,
} from "../../types.js";

import { GeminiAutoCacheManager } from "./auto-cache-manager.js";
import { lookupGeminiPricing } from "./pricing.js";
import type { CachedGeminiOptions } from "./types.js";
import {
  computeGeminiCacheInfo,
  type GeminiUsageMetadata,
} from "./usage.js";

/** Subset of the Gemini SDK we actually call. */
interface GeminiSDK {
  models: {
    generateContent: (params: Record<string, unknown>) => Promise<GeminiResponse>;
    generateContentStream: (
      params: Record<string, unknown>,
    ) => Promise<AsyncIterable<GeminiResponse>>;
  };
  caches: {
    create: (params: Record<string, unknown>) => Promise<GeminiCachedContent>;
    get: (params: Record<string, unknown>) => Promise<GeminiCachedContent>;
    delete: (params: Record<string, unknown>) => Promise<unknown>;
    list: (params?: Record<string, unknown>) => Promise<unknown>;
    update: (params: Record<string, unknown>) => Promise<GeminiCachedContent>;
  };
}

/** Shape we read off the SDK response. */
export interface GeminiResponse {
  usageMetadata?: GeminiUsageMetadata;
  text?: string;
  candidates?: unknown[];
  [k: string]: unknown;
}

export interface GeminiCachedContent {
  name?: string;
  displayName?: string;
  model?: string;
  createTime?: string;
  expireTime?: string;
  [k: string]: unknown;
}

export type CachedGeminiResponse = GeminiResponse & { cacheInfo: CacheInfo };

/**
 * The streaming-side return type of `models.generateContentStream(...)`.
 * Iterate it for partial responses; await `.final()` for cacheInfo.
 */
export type CachedGeminiStream = CachedStream<
  GeminiResponse,
  { lastUsage: GeminiUsageMetadata | undefined },
  GeminiResponse | undefined
>;

type GeminiCtor = new (opts: Record<string, unknown>) => GeminiSDK;

let _Gemini: GeminiCtor | undefined;
async function loadGemini(): Promise<GeminiCtor> {
  if (_Gemini) return _Gemini;
  try {
    const mod = (await import("@google/genai")) as unknown as {
      GoogleGenAI?: GeminiCtor;
      default?: GeminiCtor;
    };
    _Gemini = (mod.GoogleGenAI ?? mod.default ?? (mod as unknown as GeminiCtor));
    return _Gemini;
  } catch (err) {
    throw new Error(
      "CachedGemini requires the `@google/genai` package as a peer dependency. " +
        "Install it with: npm install @google/genai. " +
        `(underlying error: ${err instanceof Error ? err.message : String(err)})`,
    );
  }
}

/**
 * Minimum shape of a Gemini tool entry the wrapper inspects for reorder.
 * Each entry typically carries `functionDeclarations: [{name, ...}]`.
 */
interface GeminiToolParam {
  functionDeclarations?: Array<{ name?: string; [k: string]: unknown }>;
  [k: string]: unknown;
}

/**
 * Drop-in replacement for `new GoogleGenAI({...})`. Responses gain a
 * `.cacheInfo` field; the client exposes `.stats()`, `.stability()`,
 * `.resetStats()`, and a `.caches` pass-through for explicit caching.
 */
export class CachedGemini {
  private _raw: GeminiSDK | undefined;
  /** Override / inject a pre-constructed raw client (used by tests). */
  public set raw(instance: GeminiSDK) {
    this._raw = instance;
  }
  public get raw(): GeminiSDK | undefined {
    return this._raw;
  }

  private readonly stats_: StatsAggregator;
  private readonly tracker: StabilityTracker;
  private readonly opts: CachedGeminiOptions;
  /** v0.5: auto-managed explicit CachedContent. Null when autoCache:false. */
  private readonly autoCache: GeminiAutoCacheManager | null;

  constructor(opts: CachedGeminiOptions = {}) {
    this.opts = opts;
    this.stats_ = new StatsAggregator(opts.hitRateWindow ?? 20);
    this.tracker = new StabilityTracker();
    this.autoCache = opts.autoCache
      ? new GeminiAutoCacheManager({
          minObservations: opts.autoCacheMinObservations ?? 2,
          ttlSeconds: opts.autoCacheTtl ?? 300,
          onWarning: opts.onWarning,
        })
      : null;
  }

  /** Resolve the underlying SDK client, instantiating it on first call. */
  private async getRaw(): Promise<GeminiSDK> {
    if (this._raw) return this._raw;
    const GoogleGenAI = await loadGemini();
    this._raw = new GoogleGenAI({
      apiKey: this.opts.apiKey,
      vertexai: this.opts.vertexai,
      project: this.opts.project,
      location: this.opts.location,
      apiVersion: this.opts.apiVersion,
      ...(this.opts.geminiClientOptions ?? {}),
    });
    return this._raw;
  }

  /** Pre-construct the SDK client (optional). */
  async ready(): Promise<void> {
    await this.getRaw();
  }

  stats(): CacheStats {
    return this.stats_.snapshot();
  }

  stability(): StabilityReport {
    return this.tracker.report();
  }

  resetStats(): void {
    this.stats_.reset();
    this.tracker.reset();
    // Best-effort: also clear any auto-managed caches on the server.
    if (this.autoCache) {
      void this.getRaw().then((raw) => this.autoCache!.clear(raw.caches));
    }
  }

  /**
   * v0.5: sweep expired auto-managed CachedContents. Returns the
   * number of entries evicted. Safe to call any time; a no-op when
   * autoCache is disabled.
   */
  async gc(): Promise<number> {
    if (!this.autoCache) return 0;
    const raw = await this.getRaw();
    return this.autoCache.gc(raw.caches);
  }

  /**
   * v0.5: snapshot of currently-managed auto caches (debug helper).
   * Empty when autoCache is disabled.
   */
  managedCaches(): Array<{
    fingerprint: string;
    name: string;
    expiresInSeconds: number;
    approxTokens: number;
  }> {
    return this.autoCache?.list() ?? [];
  }

  /**
   * Shared post-response pipeline. Used by both generateContent (non-
   * streaming) and generateContentStream (streaming, after the final
   * chunk is consumed).
   */
  private _processGeminiUsage(
    model: string,
    usage: GeminiUsageMetadata | undefined,
    previousSnapshot: ReturnType<StabilityTracker["previousSnapshot"]>,
    currentSnapshot: ReturnType<typeof snapshotRequest>,
  ): CacheInfo {
    const pricing = lookupGeminiPricing(model, this.opts.pricingOverride);
    if (!pricing) {
      safeEmit(this.opts.onWarning, {
        code: "unknown-model",
        message: `Pricing unknown for Gemini model "${model}" — dollar accounting will report 0 for this call.`,
        detail: { model },
      });
    }
    const cacheInfo = computeGeminiCacheInfo(usage, pricing);

    const priorStats = this.stats_.snapshot();
    const hadPriorCacheActivity = priorStats.totalCachedTokens > 0;
    if (
      cacheInfo.cachedTokens === 0 &&
      cacheInfo.uncachedTokens > 0 &&
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
          "This Gemini call did not benefit from any cached content even though a prior call did. Your prefix likely changed, an explicit CachedContent expired, or your prompt fell below the implicit-caching minimum." +
          (detail.summary ? ` Detected: ${detail.summary as string}` : ""),
        ...(Object.keys(detail).length > 0 ? { detail } : {}),
      });
    }

    this.stats_.record(cacheInfo);

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
    return cacheInfo;
  }

  /**
   * Shared pre-send pipeline. Returns the modified outgoing params and
   * the snapshots needed by the post-response pipeline. Used by both
   * non-streaming and streaming code paths.
   */
  private _prepareGeminiOutgoing(params: Record<string, unknown>): {
    outgoing: Record<string, unknown>;
    previousSnapshot: ReturnType<StabilityTracker["previousSnapshot"]>;
    currentSnapshot: ReturnType<typeof snapshotRequest>;
  } {
    const userContents = (params.contents ?? []) as Array<{
      role?: string;
      parts?: unknown[];
      [k: string]: unknown;
    }>;
    const config = (params.config ?? {}) as {
      tools?: GeminiToolParam[];
      cachedContent?: string;
      [k: string]: unknown;
    };
    const userTools = config.tools;

    let outgoingTools = userTools;
    if (this.opts.autoReorder && userTools && userTools.length > 0) {
      const result = canonicalizeGeminiTools(userTools);
      if (result.changed) {
        outgoingTools = result.tools;
        safeEmit(this.opts.onWarning, {
          code: "auto-reorder-applied",
          message: `Auto-reorder alphabetized Gemini functionDeclarations (${result.moved} moved).`,
          detail: { moved: result.moved },
        });
      }
    }

    const previousSnapshot = this.tracker.previousSnapshot();
    const currentSnapshot = snapshotRequestForGemini(
      userContents,
      outgoingTools,
    );
    this.tracker.observe(currentSnapshot);

    if (config.cachedContent) {
      safeEmit(this.opts.onWarning, {
        code: "gemini-cache-applied",
        message: `Using explicit CachedContent: ${config.cachedContent}`,
        detail: { cachedContent: config.cachedContent },
      });
    }

    const outgoing: Record<string, unknown> = {
      ...params,
      config: {
        ...config,
        ...(outgoingTools !== undefined ? { tools: outgoingTools } : {}),
      },
    };
    return { outgoing, previousSnapshot, currentSnapshot };
  }

  /**
   * Mirror of `googleGenAI.models` with wrapped `generateContent` (non-
   * streaming) and `generateContentStream` (v0.5).
   */
  /**
   * Apply auto-managed CachedContent to an outgoing payload if eligible.
   * No-op when autoCache is disabled, no systemInstruction is present,
   * or the user already set config.cachedContent.
   */
  private async _maybeApplyAutoCache(
    outgoing: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!this.autoCache) return outgoing;
    const config = (outgoing.config ?? {}) as Record<string, unknown>;
    const systemInstruction = config.systemInstruction;
    if (typeof systemInstruction !== "string" || !systemInstruction) {
      return outgoing;
    }
    const { fingerprint: fp, count } = this.autoCache.observe(systemInstruction);
    const raw = await this.getRaw();
    const result = await this.autoCache.maybeApply(
      fp,
      count,
      systemInstruction,
      (outgoing.model as string) ?? "",
      config,
      raw.caches,
    );
    if (!result.applied) return outgoing;
    return { ...outgoing, config: result.config };
  }

  public readonly models = {
    generateContent: async (
      params: Record<string, unknown>,
    ): Promise<CachedGeminiResponse> => {
      const prepared = this._prepareGeminiOutgoing(params);
      const outgoing = await this._maybeApplyAutoCache(prepared.outgoing);
      const previousSnapshot = prepared.previousSnapshot;
      const currentSnapshot = prepared.currentSnapshot;
      const raw = await this.getRaw();
      const response = await raw.models.generateContent(outgoing);
      const model = (params.model as string) ?? "";
      const cacheInfo = this._processGeminiUsage(
        model,
        response.usageMetadata,
        previousSnapshot,
        currentSnapshot,
      );
      Object.defineProperty(response, "cacheInfo", {
        value: cacheInfo,
        enumerable: true,
        writable: false,
        configurable: false,
      });
      return response as CachedGeminiResponse;
    },
    /**
     * v0.5: streaming wrapper around `models.generateContentStream`.
     * Returns a CachedStream that yields partial `GeminiResponse` chunks
     * and exposes `.final()` resolving with `{ cacheInfo }`. Usage
     * metadata is taken from the last chunk that carries it.
     */
    generateContentStream: async (
      params: Record<string, unknown>,
    ): Promise<CachedGeminiStream> => {
      const prepared = this._prepareGeminiOutgoing(params);
      const outgoing = await this._maybeApplyAutoCache(prepared.outgoing);
      const previousSnapshot = prepared.previousSnapshot;
      const currentSnapshot = prepared.currentSnapshot;
      const raw = await this.getRaw();
      const rawStream = await raw.models.generateContentStream(outgoing);
      const model = (params.model as string) ?? "";
      return new CachedStream<
        GeminiResponse,
        { lastUsage: GeminiUsageMetadata | undefined },
        GeminiResponse | undefined
      >(rawStream, {
        initialState: { lastUsage: undefined },
        onChunk: (chunk, state) => {
          if (chunk.usageMetadata) {
            return { lastUsage: chunk.usageMetadata };
          }
          return state;
        },
        finalize: async (state) => {
          const cacheInfo = this._processGeminiUsage(
            model,
            state.lastUsage,
            previousSnapshot,
            currentSnapshot,
          );
          return { cacheInfo, raw: undefined };
        },
      });
    },
  };

  /**
   * Explicit-caching pass-through. Use these the same way you'd use
   * `googleGenAI.caches.*`. The wrapper doesn't currently add anything
   * here other than ergonomic access — auto-managed explicit caching is
   * v0.5 work.
   */
  public readonly caches = {
    create: async (params: Record<string, unknown>): Promise<GeminiCachedContent> => {
      const raw = await this.getRaw();
      const cache = await raw.caches.create(params);
      safeEmit(this.opts.onWarning, {
        code: "gemini-cache-applied",
        message: `Created Gemini CachedContent: ${cache.name ?? "(unnamed)"}`,
        detail: { name: cache.name, model: cache.model },
      });
      return cache;
    },
    get: async (params: Record<string, unknown>): Promise<GeminiCachedContent> => {
      const raw = await this.getRaw();
      return raw.caches.get(params);
    },
    delete: async (params: Record<string, unknown>): Promise<unknown> => {
      const raw = await this.getRaw();
      return raw.caches.delete(params);
    },
    list: async (params?: Record<string, unknown>): Promise<unknown> => {
      const raw = await this.getRaw();
      return raw.caches.list(params);
    },
    update: async (params: Record<string, unknown>): Promise<GeminiCachedContent> => {
      const raw = await this.getRaw();
      return raw.caches.update(params);
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Sort each Gemini tool entry's `functionDeclarations[]` by `name`.
 * Most users wrap all their functions in a single tool entry, so this
 * is the main lever. Tool entries themselves are not reordered (their
 * order rarely matters but isn't trivially stable since they don't have
 * a canonical key).
 */
function canonicalizeGeminiTools(tools: GeminiToolParam[]): {
  tools: GeminiToolParam[];
  changed: boolean;
  moved: number;
} {
  let changed = false;
  let moved = 0;
  const out: GeminiToolParam[] = tools.map((entry) => {
    const fns = entry.functionDeclarations;
    if (!fns || fns.length < 2) return entry;
    if (fns.some((f) => typeof f.name !== "string")) return entry;
    const originalIndex = new Map<typeof fns[number], number>();
    fns.forEach((f, i) => originalIndex.set(f, i));
    const sorted = [...fns].sort((a, b) =>
      (a.name as string).localeCompare(b.name as string),
    );
    let entryMoved = 0;
    for (let i = 0; i < sorted.length; i++) {
      if (originalIndex.get(sorted[i]!) !== i) entryMoved += 1;
    }
    if (entryMoved === 0) return entry;
    moved += entryMoved;
    changed = true;
    return { ...entry, functionDeclarations: sorted };
  });
  return { tools: out, changed, moved };
}

/**
 * Snapshot a Gemini request for the stability tracker. We map Gemini's
 * `contents[]` shape to the Anthropic-like `messages[]` shape the
 * snapshotter understands, treating each content as a message with the
 * given role and a JSON-stringified parts payload.
 */
function snapshotRequestForGemini(
  contents: Array<{ role?: string; parts?: unknown[]; [k: string]: unknown }>,
  tools: Array<{ [k: string]: unknown }> | undefined,
) {
  const messages = contents.map((c) => ({
    role: (c.role === "model" ? "assistant" : c.role ?? "user") as
      | "user"
      | "assistant",
    content: JSON.stringify(c.parts ?? []),
  }));
  return snapshotRequest({
    tools,
    messages,
  });
}
