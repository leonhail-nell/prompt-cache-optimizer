import { describe, expect, it, vi } from "vitest";

import { CachedAnthropic } from "../src/client.js";

/**
 * Build a fake MessageStream-like object: it's async-iterable and has a
 * finalMessage() method, matching the surface our wrapper consumes.
 */
function fakeMessageStream(opts: {
  events: unknown[];
  finalMessage: {
    id: string;
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
}) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const ev of opts.events) {
        yield ev;
      }
    },
    finalMessage: vi.fn(async () => opts.finalMessage),
  };
}

describe("CachedAnthropic.messages.stream", () => {
  it("yields events and resolves cacheInfo via final()", async () => {
    const client = new CachedAnthropic({ apiKey: "test-key" });
    const fake = fakeMessageStream({
      events: [
        { type: "message_start" },
        { type: "content_block_delta", delta: { text: "Hi" } },
        { type: "message_stop" },
      ],
      finalMessage: {
        id: "msg_streamed",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 5000,
        },
      },
    });
    // @ts-expect-error stubbing raw for testing
    client.raw.messages.stream = vi.fn(() => fake);

    const stream = client.messages.stream({
      model: "claude-sonnet-4-6",
      max_tokens: 100,
      system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "hi" }],
    });

    const events: unknown[] = [];
    for await (const ev of stream) {
      events.push(ev);
    }
    expect(events).toHaveLength(3);

    const { cacheInfo, raw } = await stream.final();
    expect(cacheInfo.hit).toBe(true);
    expect(cacheInfo.cachedTokens).toBe(5000);
    expect(raw?.id).toBe("msg_streamed");
  });

  it("updates client.stats() with streamed usage", async () => {
    const client = new CachedAnthropic({ apiKey: "test-key" });
    const fake = fakeMessageStream({
      events: [],
      finalMessage: {
        id: "msg",
        usage: {
          input_tokens: 50,
          output_tokens: 10,
          cache_read_input_tokens: 3000,
        },
      },
    });
    // @ts-expect-error stubbing raw for testing
    client.raw.messages.stream = vi.fn(() => fake);

    const stream = client.messages.stream({
      model: "claude-sonnet-4-6",
      max_tokens: 100,
      system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "hi" }],
    });
    await stream.final();

    const stats = client.stats();
    expect(stats.totalCalls).toBe(1);
    expect(stats.cacheHits).toBe(1);
    expect(stats.totalCachedTokens).toBe(3000);
  });

  it("supports skip-iteration: final() drains the stream itself", async () => {
    const client = new CachedAnthropic({ apiKey: "test-key" });
    const fake = fakeMessageStream({
      events: [{ type: "x" }, { type: "y" }],
      finalMessage: {
        id: "msg",
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 100,
        },
      },
    });
    // @ts-expect-error stubbing raw for testing
    client.raw.messages.stream = vi.fn(() => fake);

    const stream = client.messages.stream({
      model: "claude-sonnet-4-6",
      max_tokens: 50,
      system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "hi" }],
    });
    const { cacheInfo } = await stream.final();
    expect(cacheInfo.cachedTokens).toBe(100);
    expect(fake.finalMessage).toHaveBeenCalled();
  });
});
