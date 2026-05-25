# prompt-cache-optimizer

[![npm version](https://img.shields.io/npm/v/prompt-cache-optimizer.svg)](https://www.npmjs.com/package/prompt-cache-optimizer)
[![npm downloads](https://img.shields.io/npm/dw/prompt-cache-optimizer.svg)](https://www.npmjs.com/package/prompt-cache-optimizer)
[![CI](https://github.com/leonhail-nell/prompt-cache-optimizer/actions/workflows/ci.yml/badge.svg)](https://github.com/leonhail-nell/prompt-cache-optimizer/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](tsconfig.json)

Drop-in wrappers for the Anthropic, OpenAI, and Gemini SDKs that make prompt caching effortless. Measure real cache hit rate from the response usage object, attach dollar savings to every call, canonicalize shuffled tools and RAG document order so a "slightly different" payload still hits the cache, and (for Anthropic) auto-place `cache_control` breakpoints based on observed stability.

![Real output: autoCache marks the system prompt cacheable after observing it twice, the next 3 calls hit the cache (~1569 cached tokens each, $0.0042 saved per call), and a deliberate drift triggers the cache-miss diagnostic showing the exact characters that changed.](assets/stats-screenshot.png)

> Real output from `bun run example`. Six calls — autoCache marks the system prompt cacheable after observing it twice, calls 3–5 hit the cache (~1569 cached tokens each), and a final deliberate drift triggers the diagnostic showing the exact characters that changed. `client.stability()` reports `system score=0.80` cumulative across the run.

> Status: v0.4 — adds drop-in wrappers for OpenAI and Gemini alongside Anthropic. One library, three providers, one consistent `cacheInfo`/`stats()`/`stability()` surface. Backwards compatible with v0.1–0.3.

## Why this exists

All three frontier providers now offer prompt caching:

- **Anthropic** — 90% discount on the cached portion. Marker-based (`cache_control: { type: "ephemeral" }`), positional, 4-breakpoint budget, 5-minute TTL.
- **OpenAI** — 50% discount on the cached portion (75% for o-series). Automatic for prompts ≥ 1024 tokens, no markers — but silently doesn't trigger below the threshold or when your tools array shuffles.
- **Gemini** — 75% discount on the cached portion. Two modes: implicit (automatic for 2.5+) and explicit (`CachedContent` API with manual lifecycle).

All three are fragile in similar ways: a misplaced byte, a reshuffled tools array, a TTL expiry, an upstream service that reorders retrieved documents — and your prompt cache silently degrades to a full-price call. The only way to know it's working is to dig into the response usage object yourself.

`prompt-cache-optimizer` handles all of that for you, with the same surface for every provider.

## Install

```bash
# Pick the provider(s) you actually use. OpenAI and Gemini SDKs are
# optional peer deps — install only what you need.
npm install prompt-cache-optimizer @anthropic-ai/sdk
npm install prompt-cache-optimizer openai
npm install prompt-cache-optimizer @google/genai
```

## Quick start: Anthropic (auto-placement + auto-reorder)

```ts
import { CachedAnthropic } from "prompt-cache-optimizer";

const client = new CachedAnthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  autoCache: true,           // ← let the wrapper place cache_control for you
  autoReorder: true,         // ← canonicalize shuffled tools / RAG docs (v0.3)
  diagnoseMisses: true,      // ← explain what changed when the cache misses
  warnIfHitRateBelow: 0.6,
});

// Use the SDK exactly like normal. No placeBreakpoints() needed.
const response = await client.messages.create({
  model: "claude-sonnet-4-6",
  max_tokens: 1024,
  system: longSystemPrompt,
  messages: conversation,
});

console.log(response.cacheInfo);
// { hit: true, cachedTokens: 8420, uncachedTokens: 312, dollarsSaved: 0.024, ... }

console.log(client.stats());
// { totalCalls: 1, hitRate: 1, totalCachedTokens: 8420, dollarsSaved: 0.024, ... }

console.log(client.stability());
// { entries: [{ segment: 'system', stabilityScore: 1, approxTokens: 2103, ... }], ... }
```

The first call always misses (that's when the cache is written). Once the wrapper has seen the system prompt twice unchanged, it auto-marks it cacheable and subsequent calls hit. No code changes needed when your prompt shape evolves — auto-placement re-evaluates each call.

## Quick start: OpenAI

```ts
import { CachedOpenAI } from "prompt-cache-optimizer";

const client = new CachedOpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
  autoReorder: true,         // ← alphabetize tools so shuffled lists still hit cache
  diagnoseMisses: true,
  warnIfHitRateBelow: 0.5,
  // warnIfPromptTooSmall is on by default — surfaces calls below OpenAI's
  // 1024-token automatic-cache minimum so you know why no caching happens.
});

const response = await client.chat.completions.create({
  model: "gpt-4o",
  messages: [
    { role: "system", content: longSystemPrompt },
    { role: "user", content: question },
  ],
  tools: [...],
});

console.log(response.cacheInfo);
// { hit: true, cachedTokens: 7420, uncachedTokens: 312, dollarsSaved: 0.0093, ... }

console.log(client.stats());
// { totalCalls: 5, hitRate: 0.8, totalCachedTokens: 29680, dollarsSaved: 0.037, ... }
```

OpenAI's cache is automatic for prompts ≥ 1024 tokens — there is no `autoCache` to enable (and no `cache_control` markers to place). The wrapper measures from `usage.prompt_tokens_details.cached_tokens`, attaches per-call savings, accumulates rolling stats, and (with `autoReorder: true`) canonicalizes the tools array so a shuffled list still hits.

## Quick start: Gemini

```ts
import { CachedGemini } from "prompt-cache-optimizer";

const client = new CachedGemini({
  apiKey: process.env.GOOGLE_API_KEY!,
  autoReorder: true,
  diagnoseMisses: true,
});

// Implicit caching (Gemini 2.5+ automatic): just call it.
const response = await client.models.generateContent({
  model: "gemini-2.5-flash",
  contents: [{ role: "user", parts: [{ text: question }] }],
  config: { systemInstruction: longSystemInstruction },
});
console.log(response.cacheInfo);
// { hit: true, cachedTokens: 4800, uncachedTokens: 500, dollarsSaved: 0.00045, ... }

// Explicit caching: create a CachedContent and reference it by name.
const cache = await client.caches.create({
  model: "gemini-2.5-flash",
  config: {
    contents: [{ role: "user", parts: [{ text: longContext }] }],
    ttl: "300s",
  },
});

const cached = await client.models.generateContent({
  model: "gemini-2.5-flash",
  contents: [{ role: "user", parts: [{ text: question }] }],
  config: { cachedContent: cache.name },
});
console.log(cached.cacheInfo);
// → hit: true, cachedTokens: (all of longContext)

await client.caches.delete({ name: cache.name }); // clean up when done
```

Gemini exposes the SDK's `caches.create/get/delete/list/update` pass-through so you can manage `CachedContent` lifecycles through the same client. Auto-managed explicit caching (the wrapper creates and refreshes `CachedContent` objects on its own when prefixes are stable) is on the v0.5 roadmap.

## What you get with every provider

Regardless of provider, every wrapped client exposes the same surface:

- `response.cacheInfo` — `{ hit, cachedTokens, uncachedTokens, cacheWriteTokens, dollarsSaved, dollarsSpent }` on every call.
- `client.stats()` — rolling aggregate: `totalCalls`, `hitRate`, `totalCachedTokens`, `dollarsSaved`, etc.
- `client.stability()` — per-segment stability report so you can debug which part of your prompt is drifting before it costs money.
- `client.resetStats()` — clears stats and stability history.
- `autoReorder` — canonicalizes order-insensitive parts of the request so shuffled inputs still hit the cache.
- `diagnoseMisses` — when the cache misses, attach a human-readable diff explaining what changed in the prefix.
- Built-in pricing tables — override per-instance with `pricingOverride`.
- Passive warning events via `onWarning` — never throws, never blocks a request.

## How Anthropic auto-placement decides what to cache

(Anthropic only — OpenAI's cache is automatic and has no markers, and Gemini's explicit `CachedContent` is managed by you.)

On every call the wrapper:

1. Fingerprints each candidate segment — `system`, `tools`, and every cumulative `messages[0..N]` prefix — using SHA-256 over a canonical form (cache_control markers stripped so they don't affect the hash).
2. Tracks the fingerprint history per segment.
3. Once a segment has been seen unchanged for at least `autoCacheMinObservations` consecutive calls (default `2`), it qualifies for auto-placement.
4. Picks the highest-value placements within Anthropic's 4-breakpoint budget: system first, then tools, then the longest stable message prefix.

You can inspect this state live with `client.stability()`.

## Manual breakpoint placement (still supported)

If you want explicit control, `placeBreakpoints` from v0.1 still works exactly as before. Auto-placement is a no-op whenever you've already marked anything cacheable yourself — your intent is always respected.

```ts
import { placeBreakpoints } from "prompt-cache-optimizer";

const { system, messages } = placeBreakpoints({
  system: longSystemPrompt,
  messages: conversation,
  strategy: "after-system",
});

await client.messages.create({ model, max_tokens, system, messages });
```

Three strategies are available:

- `after-system` — cache the system prompt (best for RAG and long instructions)
- `after-last-assistant` — cache the conversation history (best for chat)
- `system-and-history` — cache both (uses 2 of your 4 breakpoints)

## Stats

```ts
client.stats();
// {
//   totalCalls: 142,
//   cacheHits: 124,
//   hitRate: 0.873,
//   totalCachedTokens: 1_240_000,
//   totalUncachedTokens: 52_400,
//   totalCacheWriteTokens: 21_000,
//   dollarsSaved: 3.72,
//   dollarsSpent: 1.41,
// }
```

## Cache-miss diagnostics

Enable `diagnoseMisses: true` and every `cache-write-without-read` warning gets a structured diff explaining what changed. Example:

```ts
new CachedAnthropic({
  apiKey,
  diagnoseMisses: true,
  onWarning: (event) => {
    if (event.code === "cache-write-without-read") {
      console.error(event.message);
      // → "...Detected: system prompt changed at character 1240: ...the docs as of [Tuesday|Wednesday]..."
      console.error(event.detail?.diff);
      // → [{ segment: 'system', summary: '...', detail: { changeIndex: 1240, ... } }]
    }
  },
});
```

Common things it catches:

- system prompt drift (inserted timestamps, dynamic context)
- tool order changes (v0.3's `autoReorder` fixes this one automatically)
- retrieved-document reordering (v0.3's `autoReorder` fixes this one automatically too)
- TTL expiration (cache was fine, then nobody called within 5 minutes)

## Auto-reorder (v0.3)

The fastest way to silently break Anthropic's prompt cache is to send the same logical content in a different order. Examples:

- Your tool definitions are pulled from an object — JS preserves insertion order, but two different code paths assemble them differently.
- Your RAG retriever returns the same five documents but ranked differently call to call.
- A user message contains multiple `document` content blocks shuffled by an upstream service.

Each of those silently degrades to a full-price cache write. Set `autoReorder: true` and the wrapper canonicalizes the order-insensitive parts of the request before sending:

```ts
const client = new CachedAnthropic({
  apiKey,
  autoReorder: true,
  // commonly paired with autoCache so the canonicalized payload also
  // gets cache_control placed on it automatically:
  autoCache: true,
});
```

What gets reordered:

- **Tools** — alphabetized by `name`. Tool order is semantically irrelevant to the model, so this is always safe.
- **Content blocks within a message** — consecutive runs of same-type "reorderable" blocks (`document`, `image`) are sorted by content fingerprint. Text, `tool_use`, `tool_result`, and `thinking` blocks are never moved — they're order-sensitive.
- **Leading user-context messages** — a leading run of user messages whose content is purely `document`/`image` blocks (the classic RAG pattern) is sorted by content fingerprint. The scan stops at the first message that breaks the pattern.

Safety invariants:

- Never reorders any segment that already carries a `cache_control` marker. Explicit intent always wins.
- Never moves text, `tool_use`, `tool_result`, or `thinking` blocks.
- Never touches assistant messages.
- Never mutates the input you passed.

Every time the wrapper actually moves something, it emits an `auto-reorder-applied` info-level warning so you can see what it did:

```ts
new CachedAnthropic({
  apiKey,
  autoReorder: true,
  onWarning: (event) => {
    if (event.code === "auto-reorder-applied") {
      console.info(event.message);
      // → "Auto-reorder canonicalized order-insensitive parts of the request
      //    to preserve the cache prefix: tools alphabetized by name
      //    (3 of 5 moved)"
    }
  },
});
```

## Warnings

The client emits passive warnings (never throws, never blocks a request):

- `no-cache-control-found` — (Anthropic) you forgot to mark anything cacheable AND auto-cache hasn't activated yet
- `cache-write-without-read` — your prefix changed call-over-call; cache is broken (carries a diff when `diagnoseMisses: true`)
- `low-hit-rate` — rolling hit rate fell below your threshold
- `unknown-model` — pricing unknown, so dollar accounting is skipped
- `auto-placement-applied` — info-level (Anthropic): the wrapper just placed cache_control on a newly-stable segment
- `auto-reorder-applied` — info-level: the wrapper canonicalized order-insensitive parts of the request so the cache prefix would still match
- `prompt-too-small-for-cache` — (OpenAI, v0.4) the prompt is below OpenAI's 1024-token automatic-cache minimum
- `gemini-cache-applied` — info-level (Gemini, v0.4): an explicit `CachedContent` was created or referenced on this call

Route them anywhere:

```ts
new CachedAnthropic({
  apiKey,
  onWarning: (event) => logger.warn(event),
});
```

## Roadmap

- ~~**v0.2** — auto-placement of `cache_control` breakpoints based on observed prompt stability~~ ✅ shipped
- ~~**v0.3** — safe message and tool reordering to maximize the stable prefix~~ ✅ shipped
- ~~**v0.4** — OpenAI and Gemini prompt caching support~~ ✅ shipped
- **v0.5** — streaming wrappers; auto-managed Gemini `CachedContent` lifecycle
- **v1.0** — persistent stats adapter, middleware mode

## Zero runtime dependencies

`prompt-cache-optimizer` itself has zero runtime deps and uses Node's built-in `node:crypto` for fingerprinting. The provider SDKs are peer dependencies:

- `@anthropic-ai/sdk` — required for `CachedAnthropic`
- `openai` — optional peer dep, required only if you use `CachedOpenAI`
- `@google/genai` — optional peer dep, required only if you use `CachedGemini`

The OpenAI and Gemini SDKs are dynamically imported on first call — simply importing `prompt-cache-optimizer` doesn't require either to be installed.

## Contributing

PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## Support this project

If this package saved you money on your Anthropic bill, consider buying me a coffee. This project is MIT-licensed and free forever; sponsorship just helps me spend more time on it.

<a href="https://buymeacoffee.com/leonhail" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" height="41" width="174"></a>

[![GitHub Sponsors](https://img.shields.io/badge/Sponsor-%E2%9D%A4-pink?logo=github)](https://github.com/sponsors/leonhail-nell)

## License

[MIT](LICENSE) © Leonhail Paypa

---

⭐ **If this package saved you money on your Anthropic bill, please star the repo.** It's the single biggest signal that helps other developers find it.
