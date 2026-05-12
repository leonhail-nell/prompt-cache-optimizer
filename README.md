# cachet

Drop-in wrapper for the Anthropic SDK that makes prompt caching effortless. Places `cache_control` breakpoints, measures real cache hit rate from the response usage object, and warns when your cache silently breaks.

> Status: v0.1 — measurement and explicit helpers. Auto-placement lands in v0.2.

## Why this exists

Anthropic prompt caching gives you a 90% discount on the cached portion of your prompt. But the API is finicky:

- A misplaced `cache_control` breakpoint silently degrades to a full-price call
- You only get 4 breakpoints per request — they have to be spent well
- Cache prefixes break if message order shifts even slightly
- The default TTL recently dropped from 1 hour to 5 minutes; lots of setups silently regressed
- The only way to know it's working is to parse `cache_read_input_tokens` yourself

`cachet` handles all of that for you.

## Install

```bash
npm install cachet @anthropic-ai/sdk
```

## Quick start

```ts
import { CachedAnthropic } from "cachet";

const client = new CachedAnthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  warnIfHitRateBelow: 0.6,
});

const response = await client.messages.create({
  model: "claude-sonnet-4-6",
  max_tokens: 1024,
  system: longSystemPrompt,
  messages: conversation,
});

console.log(response.cacheInfo);
// { hit: true, cachedTokens: 8420, uncachedTokens: 312, dollarsSaved: 0.024 }

console.log(client.stats());
// { totalCalls: 1, hitRate: 1, tokensSaved: 8420, dollarsSaved: 0.024 }
```

## Manual breakpoint placement

For v0.1, auto-placement is opt-in via the `placeBreakpoints` helper:

```ts
import { placeBreakpoints } from "cachet";

const { system, messages } = placeBreakpoints({
  system: longSystemPrompt,
  messages: conversation,
  strategy: "after-system",
});

await client.messages.create({ model, max_tokens, system, messages });
```

## Stats

```ts
client.stats();
// {
//   totalCalls: 142,
//   cacheHits: 124,
//   hitRate: 0.873,
//   tokensSaved: 1_240_000,
//   dollarsSaved: 3.72,
// }
```

## Zero runtime dependencies

`@anthropic-ai/sdk` is a peer dependency. `cachet` itself has zero runtime deps.

## License

MIT
