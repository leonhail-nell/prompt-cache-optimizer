# prompt-cache-optimizer

[![npm version](https://img.shields.io/npm/v/prompt-cache-optimizer.svg)](https://www.npmjs.com/package/prompt-cache-optimizer)
[![npm downloads](https://img.shields.io/npm/dw/prompt-cache-optimizer.svg)](https://www.npmjs.com/package/prompt-cache-optimizer)
[![CI](https://github.com/leonhail-nell/prompt-cache-optimizer/actions/workflows/ci.yml/badge.svg)](https://github.com/leonhail-nell/prompt-cache-optimizer/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](tsconfig.json)

Drop-in wrapper for the Anthropic SDK that makes prompt caching effortless. Auto-places `cache_control` breakpoints based on observed prompt stability, canonicalizes shuffled tools and RAG document order so a "slightly different" payload still hits the cache, measures real cache hit rate from the response usage object, and explains exactly what changed when your cache silently breaks.

![Real output: autoCache marks the system prompt cacheable after observing it twice, the next 3 calls hit the cache (~1569 cached tokens each, $0.0042 saved per call), and a deliberate drift triggers the cache-miss diagnostic showing the exact characters that changed.](assets/stats-screenshot.png)

> Real output from `bun run example`. Six calls — autoCache marks the system prompt cacheable after observing it twice, calls 3–5 hit the cache (~1569 cached tokens each), and a final deliberate drift triggers the diagnostic showing the exact characters that changed. `client.stability()` reports `system score=0.80` cumulative across the run.

> Status: v0.3 — adds safe auto-reorder of shuffled tools, RAG document blocks, and leading user-context message prefixes. Backwards compatible with v0.1 and v0.2.

## Why this exists

Anthropic prompt caching gives you a 90% discount on the cached portion of your prompt. But the API is finicky:

- A misplaced `cache_control` breakpoint silently degrades to a full-price call
- You only get 4 breakpoints per request — they have to be spent well
- Cache prefixes break if message order shifts even slightly (tools array reordered, RAG retriever returns the same documents in a different order, etc.)
- The default TTL is 5 minutes; lots of setups silently regress when calls come in slower than that
- The only way to know it's working is to parse `cache_read_input_tokens` yourself

`prompt-cache-optimizer` handles all of that for you.

## Install

```bash
npm install prompt-cache-optimizer @anthropic-ai/sdk
# or
bun add prompt-cache-optimizer @anthropic-ai/sdk
```

## Quick start (v0.3 — auto-placement + auto-reorder)

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

## How auto-placement decides what to cache

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

- `no-cache-control-found` — you forgot to mark anything cacheable AND auto-cache hasn't activated yet
- `cache-write-without-read` — your prefix changed call-over-call; cache is broken (carries a diff when `diagnoseMisses: true`)
- `low-hit-rate` — rolling hit rate fell below your threshold
- `unknown-model` — pricing unknown, so dollar accounting is skipped
- `auto-placement-applied` — info-level: the wrapper just placed cache_control on a newly-stable segment
- `auto-reorder-applied` — info-level (v0.3): the wrapper canonicalized order-insensitive parts of the request so the cache prefix would still match

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
- **v0.4** — OpenAI and Gemini prompt caching support
- **v1.0** — persistent stats adapter, middleware mode

## Zero runtime dependencies

`@anthropic-ai/sdk` is a peer dependency. `prompt-cache-optimizer` itself has zero runtime deps. v0.2 uses Node's built-in `node:crypto` for fingerprinting.

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
