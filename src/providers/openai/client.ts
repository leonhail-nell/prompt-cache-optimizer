/**
 * CachedOpenAI — drop-in wrapper around the official `openai` SDK that:
 *   1) forwards the call to the underlying SDK
 *   2) parses response usage to compute CacheInfo
 *   3) attaches CacheInfo to the returned response
 *   4) updates rolling stats and emits warnings
 *
 * OpenAI's prompt cache is AUTOMATIC for prompts >= 1024 tokens — there is
 * no `cache_control` marker to place. So there is no autoCache option for
 * OpenAI. What this wrapper adds:
 *
 *   - `cacheInfo` on every response (hit, cachedTokens, dollarsSaved, ...).
 *   - `client.stats()` aggregate stats across calls.
 *   - `client.stability()` per-segment stability report (so you can see
 *     which part of your prompt is drifting and breaking the cache).
 *   - `autoReorder: true` canonicalizes the tools array order so a
 *     shuffled tool list still hits the automatic cache.
 *   - `diagnoseMisses: true` produces a human-readable diff of what
 *     changed when the cache misses.
 *   - `warnIfPromptTooSmall` (default true) flags calls below OpenAI's
 *     1024-token cache-minimum so you know why no caching is happening.
 *
 * v0.5 adds streaming: pass `stream: true` to `chat.completions.create`
 * and you get back a CachedStream that yields ChatCompletionChunks AND
 * exposes `.final()` resolving with cacheInfo. The wrapper auto-sets
 * `stream_options.include_usage: true` (with a one-time info warning)
 * so the final chunk carries the usage object — without that flag,
 * OpenAI's API returns no usage at all in streaming mode and cacheInfo
 * would be permanently zero.
 *
 * The raw SDK is exposed at `.raw` for advanced use.
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
  WarningEvent,
} from "../../types.js";

import { lookupOpenAIPricing } from "./pricing.js";
import {
  OPENAI_CACHE_MIN_TOKENS,
  type CachedOpenAIOptions,
} from "./types.js";
import { computeOpenAICacheInfo, type OpenAIUsage } from "./usage.js";

/**
 * OpenAI's response shape we actually care about. We don't redeclare the
 * full ChatCompletion type — we use a structural subset and intersect
 * `.cacheInfo` so callers can keep their existing OpenAI types.
 */
export interface OpenAIChatCompletion {
  id: string;
  choices: Array<{
    message: { role: string; content: string | null; [k: string]: unknown };
    [k: string]: unknown;
  }>;
  usage?: OpenAIUsage;
  model?: string;
  [k: string]: unknown;
}

/** Minimal structural shape of an OpenAI streaming chunk. */
export interface OpenAIChatCompletionChunk {
  id?: string;
  choices?: Array<{
    delta?: { content?: string | null; role?: string; [k: string]: unknown };
    finish_reason?: string | null;
    [k: string]: unknown;
  }>;
  /** Only present on the FINAL chunk when stream_options.include_usage is true. */
  usage?: OpenAIUsage;
  model?: string;
  [k: string]: unknown;
}

/**
 * The streaming-side return type of `chat.completions.create({ stream: true })`.
 * Iterate it for chunks; await `.final()` for cacheInfo.
 */
export type CachedOpenAIChatStream = CachedStream<
  OpenAIChatCompletionChunk,
  { lastUsage: OpenAIUsage | undefined },
  OpenAIChatCompletionChunk | undefined
>;

export type CachedChatCompletion = OpenAIChatCompletion & {
  cacheInfo: CacheInfo;
};

/**
 * Lazy-loaded OpenAI SDK class. We don't import it at top-level so the
 * `openai` peer dep stays truly optional — users who only want
 * CachedAnthropic never pay the cost of even resolving `openai`.
 */
type OpenAIInstance = {
  chat: {
    completions: {
      create: (
        params: Record<string, unknown>,
      ) => Promise<OpenAIChatCompletion | AsyncIterable<OpenAIChatCompletionChunk>>;
    };
  };
};
type OpenAICtor = new (opts: Record<string, unknown>) => OpenAIInstance;

let _OpenAI: OpenAICtor | undefined;
async function loadOpenAI(): Promise<OpenAICtor> {
  if (_OpenAI) return _OpenAI;
  try {
    const mod = (await import("openai")) as unknown as {
      default?: OpenAICtor;
      OpenAI?: OpenAICtor;
    };
    _OpenAI = (mod.default ?? mod.OpenAI ?? (mod as unknown as OpenAICtor));
    return _OpenAI;
  } catch (err) {
    throw new Error(
      "CachedOpenAI requires the `openai` package as a peer dependency. " +
        "Install it with: npm install openai. " +
        `(underlying error: ${err instanceof Error ? err.message : String(err)})`,
    );
  }
}

/** Minimum shape of an OpenAI tool param (function-tool only — assistants
 * tools and other variants pass through untouched). */
interface OpenAIToolParam {
  type?: string;
  function?: { name?: string; description?: string; parameters?: unknown };
  [k: string]: unknown;
}

/**
 * Drop-in replacement for `new OpenAI({...})`. Use exactly the same way;
 * the only differences are that responses gain a `.cacheInfo` field and
 * the client exposes `.stats()` and `.stability()`.
 */
export class CachedOpenAI {
  /**
   * The underlying OpenAI SDK client. Lazily constructed on first call so
   * that simply importing this module doesn't require `openai` to be
   * installed. Pre-warm by calling `await client.ready()` if you need the
   * raw client synchronously before your first request.
   */
  private _raw: OpenAIInstance | undefined;
  /** Override / inject a pre-constructed raw client (used by tests). */
  public set raw(instance: OpenAIInstance) {
    this._raw = instance;
  }
  public get raw(): OpenAIInstance | undefined {
    return this._raw;
  }

  private readonly stats_: StatsAggregator;
  private readonly tracker: StabilityTracker;
  private readonly opts: CachedOpenAIOptions;
  /** Suppress duplicate "we auto-enabled include_usage" warnings per session. */
  private warnedAboutIncludeUsage = false;

  constructor(opts: CachedOpenAIOptions = {}) {
    this.opts = opts;
    this.stats_ = new StatsAggregator(opts.hitRateWindow ?? 20);
    this.tracker = new StabilityTracker();
  }

  /** Resolve the underlying SDK client, instantiating it on first call. */
  private async getRaw(): Promise<OpenAIInstance> {
    if (this._raw) return this._raw;
    const OpenAI = await loadOpenAI();
    this._raw = new OpenAI({
      apiKey: this.opts.apiKey,
      baseURL: this.opts.baseURL,
      organization: this.opts.organization,
      project: this.opts.project,
      ...(this.opts.openaiClientOptions ?? {}),
    });
    return this._raw;
  }

  /**
   * Pre-construct the underlying SDK client so subsequent calls don't pay
   * the dynamic-import cost. Calling this is optional.
   */
  async ready(): Promise<void> {
    await this.getRaw();
  }

  /** Aggregate stats across every call made through this client. */
  stats(): CacheStats {
    return this.stats_.snapshot();
  }

  /** Per-segment stability report. */
  stability(): StabilityReport {
    return this.tracker.report();
  }

  /** Reset accumulated stats. */
  resetStats(): void {
    this.stats_.reset();
    this.tracker.reset();
    this.warnedAboutIncludeUsage = false;
  }

  /**
   * Shared post-response pipeline: compute cacheInfo from a usage object,
   * fire diagnostics, accumulate stats. Used by both non-streaming and
   * streaming paths.
   */
  private _processOpenAIUsage(
    model: string,
    usage: OpenAIUsage,
    previousSnapshot: ReturnType<StabilityTracker["previousSnapshot"]>,
    currentSnapshot: ReturnType<typeof snapshotRequest>,
  ): CacheInfo {
    const pricing = lookupOpenAIPricing(model, this.opts.pricingOverride);
    if (!pricing) {
      safeEmit(this.opts.onWarning, {
        code: "unknown-model",
        message: `Pricing unknown for OpenAI model "${model}" — dollar accounting will report 0 for this call.`,
        detail: { model },
      });
    }
    const cacheInfo = computeOpenAICacheInfo(usage, pricing);

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
          "This call wrote to the prompt cache but read nothing — your prefix likely changed since the last call. Common causes: tools reordered, system message edited, or the cache TTL expired (OpenAI caches typically retain for 5–10 minutes)." +
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

  /** Mirror of `openai.chat.completions` with a wrapped `create`. */
  public readonly chat = {
    completions: {
      create: async (
        params: Record<string, unknown>,
      ): Promise<CachedChatCompletion | CachedOpenAIChatStream> => {
        const userMessages = (params.messages ?? []) as Array<{
          role: "system" | "user" | "assistant" | "tool";
          content: unknown;
        }>;
        const userTools = params.tools as OpenAIToolParam[] | undefined;

        // STEP 1 — auto-reorder. For OpenAI the only safe reorder is
        // sorting tools by function.name. Content blocks and message
        // prefix reordering don't really apply to the typical OpenAI
        // shape.
        let outgoingTools = userTools;
        if (this.opts.autoReorder && userTools && userTools.length > 1) {
          const sorted = canonicalizeOpenAITools(userTools);
          if (sorted.changed) {
            outgoingTools = sorted.tools;
            safeEmit(this.opts.onWarning, {
              code: "auto-reorder-applied",
              message: `Auto-reorder alphabetized tools by function.name (${sorted.moved} moved).`,
              detail: {
                order: sorted.tools.map((t) => t.function?.name),
              },
            });
          }
        }

        // STEP 2 — snapshot canonical form for stability tracking.
        const previousSnapshot = this.tracker.previousSnapshot();
        const currentSnapshot = snapshotRequestForOpenAI(
          userMessages,
          outgoingTools as Array<{ [k: string]: unknown }> | undefined,
        );
        this.tracker.observe(currentSnapshot);

        // STEP 3 — preflight: warn if the prompt is below OpenAI's
        // automatic-caching minimum.
        const warnIfTooSmall =
          this.opts.warnIfPromptTooSmall ?? true;
        if (warnIfTooSmall !== false) {
          const threshold =
            typeof warnIfTooSmall === "number"
              ? warnIfTooSmall
              : OPENAI_CACHE_MIN_TOKENS;
          const approxTokens = approxPromptTokens(userMessages, outgoingTools);
          if (approxTokens < threshold) {
            safeEmit(this.opts.onWarning, {
              code: "prompt-too-small-for-cache",
              message:
                `Estimated prompt size (${approxTokens} tokens) is below ` +
                `OpenAI's automatic-caching minimum of ${threshold} tokens. ` +
                "No portion of this call will be cached regardless of repetition.",
              detail: { approxTokens, threshold },
            });
          }
        }

        const isStreaming = params.stream === true;

        // For streaming, OpenAI only returns usage in the final chunk
        // when stream_options.include_usage is true. Auto-set it (and
        // warn once) so cacheInfo isn't permanently zero.
        let outgoing: Record<string, unknown> = {
          ...params,
          ...(outgoingTools !== undefined ? { tools: outgoingTools } : {}),
        };
        if (isStreaming) {
          const streamOpts =
            (outgoing.stream_options as Record<string, unknown> | undefined) ?? {};
          if (streamOpts.include_usage !== true) {
            outgoing = {
              ...outgoing,
              stream_options: { ...streamOpts, include_usage: true },
            };
            if (!this.warnedAboutIncludeUsage) {
              this.warnedAboutIncludeUsage = true;
              safeEmit(this.opts.onWarning, {
                code: "auto-reorder-applied",
                message:
                  "Auto-enabled stream_options.include_usage=true so cacheInfo can be computed from the final chunk's usage object.",
                detail: { reason: "openai-include-usage-auto-on" },
              });
            }
          }
        }

        const raw = await this.getRaw();
        const model = (params.model as string) ?? "";

        if (isStreaming) {
          // Streaming path — return a CachedStream the caller can iterate.
          const rawStream = (await raw.chat.completions.create(
            outgoing,
          )) as AsyncIterable<OpenAIChatCompletionChunk>;
          return new CachedStream<
            OpenAIChatCompletionChunk,
            { lastUsage: OpenAIUsage | undefined },
            OpenAIChatCompletionChunk | undefined
          >(rawStream, {
            initialState: { lastUsage: undefined },
            onChunk: (chunk, state) => {
              // The final chunk carries usage (when include_usage:true).
              // Intermediate chunks won't have it.
              if (chunk.usage) {
                return { lastUsage: chunk.usage };
              }
              return state;
            },
            finalize: async (state) => {
              const usage = state.lastUsage ?? {
                prompt_tokens: 0,
                completion_tokens: 0,
              };
              const cacheInfo = this._processOpenAIUsage(
                model,
                usage,
                previousSnapshot,
                currentSnapshot,
              );
              return { cacheInfo, raw: undefined };
            },
          }) as CachedOpenAIChatStream;
        }

        // Non-streaming path — original behavior.
        const response = (await raw.chat.completions.create(
          outgoing,
        )) as OpenAIChatCompletion;

        const usage = response.usage ?? {
          prompt_tokens: 0,
          completion_tokens: 0,
        };
        const cacheInfo = this._processOpenAIUsage(
          model,
          usage,
          previousSnapshot,
          currentSnapshot,
        );

        Object.defineProperty(response, "cacheInfo", {
          value: cacheInfo,
          enumerable: true,
          writable: false,
          configurable: false,
        });
        return response as CachedChatCompletion;
      },
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Sort OpenAI tools alphabetically by `function.name`. No-op when fewer
 * than two tools, when any tool is non-function shape, or when already
 * sorted.
 */
function canonicalizeOpenAITools(tools: OpenAIToolParam[]): {
  tools: OpenAIToolParam[];
  changed: boolean;
  moved: number;
} {
  if (tools.length < 2) return { tools, changed: false, moved: 0 };
  // Refuse to reorder if any tool isn't a named function tool — we can't
  // give it a deterministic key.
  for (const t of tools) {
    if (typeof t.function?.name !== "string") {
      return { tools, changed: false, moved: 0 };
    }
  }
  const originalIndex = new Map<OpenAIToolParam, number>();
  tools.forEach((t, i) => originalIndex.set(t, i));
  const sorted = [...tools].sort((a, b) =>
    (a.function!.name as string).localeCompare(b.function!.name as string),
  );
  let moved = 0;
  for (let i = 0; i < sorted.length; i++) {
    if (originalIndex.get(sorted[i]!) !== i) moved += 1;
  }
  if (moved === 0) return { tools, changed: false, moved: 0 };
  return { tools: sorted, changed: true, moved };
}

/**
 * Snapshot an OpenAI request for the stability tracker. We adapt the
 * Anthropic-shape snapshotter to OpenAI by passing the tools as-is and
 * the messages with their content normalized to a string-or-array of
 * blocks. Stability is byte-equality of the canonical JSON — works fine
 * regardless of the exact shape.
 */
function snapshotRequestForOpenAI(
  messages: Array<{ role: string; content: unknown }>,
  tools: Array<{ [k: string]: unknown }> | undefined,
) {
  // Normalize for the snapshot. We don't try to identify the "system" as a
  // separate segment for OpenAI — it's just messages[0] when present.
  const normalized = messages.map((m) => ({
    role: m.role as "user" | "assistant",
    content:
      typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? (m.content as Array<{ type: string; [k: string]: unknown }>)
          : JSON.stringify(m.content),
  }));
  return snapshotRequest({
    tools,
    messages: normalized as Array<{
      role: "user" | "assistant";
      content: string | Array<{ type: string; [k: string]: unknown }>;
    }>,
  });
}

/**
 * Rough heuristic for prompt token count — we estimate ~4 chars per
 * token across the JSON serialization of messages + tools. Used only to
 * decide whether to fire the "too small for cache" warning, never for
 * billing.
 */
function approxPromptTokens(
  messages: unknown[],
  tools: unknown[] | undefined,
): number {
  const json =
    JSON.stringify(messages ?? []) + JSON.stringify(tools ?? []);
  return Math.ceil(json.length / 4);
}
