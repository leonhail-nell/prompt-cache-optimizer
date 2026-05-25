# Changelog

## 0.4.0

Headline feature — multi-provider support. Fully backwards compatible with v0.3.

- **`CachedOpenAI`** — drop-in wrapper around the `openai` SDK. Same `cacheInfo` shape on every response, same `client.stats()` / `client.stability()` / `client.resetStats()` surface. OpenAI's cache is automatic so there is no `autoCache` option, but `autoReorder: true` still alphabetizes the tools array to keep the automatic cache hitting across shuffled calls.
- **`CachedGemini`** — drop-in wrapper around `@google/genai`. Supports both implicit caching (Gemini 2.5+ automatic) and explicit caching (via `client.caches.create/get/delete/list/update` pass-throughs, and `config.cachedContent: name` on `generateContent`). `autoReorder: true` alphabetizes each tool entry's `functionDeclarations[]` by name.
- **OpenAI + Gemini pricing tables** built in. Override per-instance with `pricingOverride`. Last verified against `openai.com/api/pricing` and `ai.google.dev/pricing` on May 25, 2026.
- **New warning codes**: `prompt-too-small-for-cache` (OpenAI: prompt below the 1024-token automatic-cache minimum) and `gemini-cache-applied` (Gemini: an explicit CachedContent was created or referenced on a request).
- **New public helpers exported**: `CachedOpenAI`, `CachedGemini`, `CachedOpenAIOptions`, `CachedGeminiOptions`, `OpenAIUsage`, `GeminiUsageMetadata`, `computeOpenAICacheInfo`, `computeGeminiCacheInfo`, `lookupOpenAIPricing`, `lookupGeminiPricing`, `KNOWN_OPENAI_MODELS`, `KNOWN_GEMINI_MODELS`, `OPENAI_CACHE_MIN_TOKENS`.
- **Peer dependencies**: `openai` and `@google/genai` are added as OPTIONAL peer dependencies (via `peerDependenciesMeta`). You only need to install the SDK for the provider you use; `CachedAnthropic` users carry no new install footprint.
- **Lazy SDK loading**: the OpenAI and Gemini SDKs are dynamically imported on the first call to `chat.completions.create` / `models.generateContent`. Simply importing `prompt-cache-optimizer` doesn't require either to be installed.
- **Streaming**: still non-streaming only across all three providers (consistent with v0.1–0.3). Streaming wrappers planned for v0.5.
- **Auto-managed Gemini explicit caching** (wrapper creates/refreshes/deletes `CachedContent` objects on its own when prefixes are stable) is deferred to v0.5 — explicit cache lifecycle management deserves its own focused release.
- New examples: `examples/openai-chatbot.ts` and `examples/gemini-rag.ts`.

## 0.3.0

Headline feature — opt-in, fully backwards compatible with v0.2.

- **Auto-reorder**: pass `autoReorder: true` and the wrapper canonicalizes order-insensitive parts of the request before sending so a "slightly shuffled" payload still hits the cache. Specifically:
  - Tools are alphabetized by `name` (most common cause of silent cache misses — different tool order across calls).
  - Within a single message, consecutive runs of same-type reorderable blocks (`document`, `image`) are sorted by content fingerprint. Text, `tool_use`, `tool_result`, and `thinking` blocks are never moved.
  - A leading run of context-only user messages (the classic RAG pattern: user messages whose content is purely `document`/`image` blocks) is sorted by content fingerprint. The scan stops at the first message that breaks the pattern.
- **Safety invariants**: never reorders any segment that already carries a `cache_control` marker (explicit intent always wins), never moves text or `tool_use`/`tool_result`/`thinking` blocks, never touches assistant messages, never mutates input.
- New `auto-reorder-applied` info-level warning event listing exactly what got moved and why.
- New public helpers exported: `applyAutoReorder`, `canonicalizeTools`, `canonicalizeMessageContent`, `canonicalizeMessagePrefix`.
- New public type: `ReorderDiagnostic`.
- Pipeline order in the client: auto-reorder runs FIRST, then stability tracking observes the canonical form, then auto-placement decides what to cache — so per-segment stability scores reflect what was actually sent over the wire.
- Zero new runtime dependencies (still just `@anthropic-ai/sdk` as peer dep).

## 0.2.1

- Refreshed the README screenshot and caption to show the actual v0.2 output (auto-placement, cache-miss diagnostic with prefix diff, and per-segment stability score). No code changes.

## 0.2.0

Headline features — all opt-in, all backwards compatible with v0.1.

- **Auto-placement**: pass `autoCache: true` and the wrapper observes which segments of your request (system, tools, message history) are stable across calls and places `cache_control` markers automatically. No more `placeBreakpoints()` boilerplate. Activates only when you have not placed any markers yourself — explicit intent is always respected.
- **Cache-miss diagnostic**: pass `diagnoseMisses: true` and every `cache-write-without-read` warning gets a human-readable diff explaining what changed (`"system prompt changed at character 1240: ...[Tuesday|Wednesday]..."`, `"tool order changed at indices [2, 4]"`, etc.).
- **`client.stability()`**: per-segment stability report so you can debug which part of your prompt is drifting before it costs you money.
- New `autoCacheMinObservations` option (default 2) — how many times a segment must be seen unchanged before auto-placement marks it cacheable.
- New `auto-placement-applied` info-level warning event so you can see what the wrapper did.
- New public helpers exported: `autoPlaceBreakpoints`, `StabilityTracker`, `snapshotRequest`, `fingerprint`, `approxTokenCount`, `diffSnapshots`.
- New public types: `PrefixDiff`, `StabilityEntry`, `StabilityReport`, `RequestSnapshot`.
- Zero new runtime dependencies (still just `@anthropic-ai/sdk` as peer dep; fingerprinting uses Node's built-in `node:crypto`).

## 0.1.3

- Added real screenshot of `client.stats()` output to the README (5 calls, 80% hit rate, 46% cost reduction)
- Added "Star this repo" call-to-action at the bottom of the README

## 0.1.2

- Added `funding` field to `package.json` so the npm package page shows a Sponsor link
- Added "Support this project" section to the README with Buy Me a Coffee button
- Added `.github/FUNDING.yml` for the GitHub "Sponsor" button
- Updated pricing table against live anthropic.com/pricing (Opus 4.7, corrected Opus 4.6 and Haiku 4.5 rates)
- Added repository, bugs, and homepage metadata to `package.json`
- Added GitHub Actions CI (typecheck + tests + build on Node 18/20/22 via bun)
- Added issue templates (bug report, feature request)
- Added CONTRIBUTING.md

## 0.1.1

- README updated to use the correct package name (`prompt-cache-optimizer`, previously referenced an old name)

## 0.1.0 — MVP

Initial release.

- `CachedAnthropic` client that wraps `@anthropic-ai/sdk` with no behavioral changes
- `cacheInfo` attached to every response (hit, cachedTokens, uncachedTokens, dollarsSaved, dollarsSpent)
- `stats()` for aggregate cache hit rate, total tokens saved, total dollars saved
- `placeBreakpoints()` helper with three strategies: `after-system`, `after-last-assistant`, `system-and-history`
- Built-in pricing table for Claude 3.x, 4, 4.5, and 4.6 model families (override per instance)
- Passive runtime warnings: `low-hit-rate`, `unknown-model`, `no-cache-control-found`, `cache-write-without-read`
- Zero runtime dependencies (`@anthropic-ai/sdk` is a peer dep)

## Unreleased / planned

- v0.5: streaming wrappers for all three providers; auto-managed Gemini explicit caching (`CachedContent` lifecycle)
- v1.0: persistent stats adapter (write hit-rate to disk / Redis), middleware mode for Express/Fastify
