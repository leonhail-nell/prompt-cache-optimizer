import { describe, expect, it, vi } from "vitest";

import { CachedAnthropic } from "../src/client.js";
import type { WarningEvent } from "../src/types.js";

/**
 * We don't hit the real Anthropic API in unit tests. Instead we stub
 * `client.raw.messages.create` after construction. The wrapper's job is
 * to parse what comes back and update stats — exactly what we test here.
 */
function withStubbedClient(
  responseUsage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  },
  opts?: ConstructorParameters<typeof CachedAnthropic>[0],
) {
  const warnings: WarningEvent[] = [];
  const client = new CachedAnthropic({
    apiKey: "test-key",
    onWarning: (w) => warnings.push(w),
    ...opts,
  });
  // @ts-expect-error overriding the bound method for testing
  client.raw.messages.create = vi.fn(async () => ({
    id: "msg_test",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    model: "claude-sonnet-4-6",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: responseUsage,
  }));
  return { client, warnings };
}

describe("CachedAnthropic", () => {
  it("attaches cacheInfo on a cache hit", async () => {
    const { client } = withStubbedClient({
      input_tokens: 50,
      output_tokens: 20,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 5000,
    });

    const res = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 100,
      system: [
        { type: "text", text: "sys", cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: "hi" }],
    });

    expect(res.cacheInfo.hit).toBe(true);
    expect(res.cacheInfo.cachedTokens).toBe(5000);
    expect(res.cacheInfo.dollarsSaved).toBeGreaterThan(0);
  });

  it("accumulates stats across calls", async () => {
    const { client } = withStubbedClient({
      input_tokens: 0,
      output_tokens: 10,
      cache_read_input_tokens: 1000,
    });

    for (let i = 0; i < 3; i++) {
      await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 100,
        system: [
          { type: "text", text: "sys", cache_control: { type: "ephemeral" } },
        ],
        messages: [{ role: "user", content: `q${i}` }],
      });
    }
    const stats = client.stats();
    expect(stats.totalCalls).toBe(3);
    expect(stats.cacheHits).toBe(3);
    expect(stats.hitRate).toBe(1);
    expect(stats.totalCachedTokens).toBe(3000);
  });

  it("emits no-cache-control-found exactly once", async () => {
    const { client, warnings } = withStubbedClient({
      input_tokens: 100,
      output_tokens: 10,
    });

    for (let i = 0; i < 3; i++) {
      await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
      });
    }
    const noCacheControlWarnings = warnings.filter(
      (w) => w.code === "no-cache-control-found",
    );
    expect(noCacheControlWarnings).toHaveLength(1);
  });

  it("emits unknown-model warning for unrecognized models", async () => {
    const { client, warnings } = withStubbedClient({
      input_tokens: 100,
      output_tokens: 10,
      cache_read_input_tokens: 0,
    });

    await client.messages.create({
      model: "totally-fake-model-9000",
      max_tokens: 100,
      system: [
        { type: "text", text: "sys", cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: "hi" }],
    });
    expect(warnings.some((w) => w.code === "unknown-model")).toBe(true);
  });

  it("resetStats clears everything", async () => {
    const { client } = withStubbedClient({
      input_tokens: 0,
      output_tokens: 10,
      cache_read_input_tokens: 1000,
    });
    await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 100,
      system: [
        { type: "text", text: "sys", cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: "hi" }],
    });
    client.resetStats();
    expect(client.stats().totalCalls).toBe(0);
  });
});
