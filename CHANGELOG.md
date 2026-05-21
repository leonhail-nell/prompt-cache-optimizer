# Changelog

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

- v0.3: safe message/tool reordering (so a slightly shuffled tool array still hits cache)
- v0.4: OpenAI + Gemini prompt-caching support
- v1.0: persistent stats adapter (write hit-rate to disk / Redis), middleware mode for Express/Fastify
