# Changelog

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

- v0.2: auto-placement, cache-miss diagnostic with prefix diff
- v0.3: safe message/tool reordering
- v0.4: OpenAI + Gemini support
- v1.0: persistent stats adapter, middleware mode
