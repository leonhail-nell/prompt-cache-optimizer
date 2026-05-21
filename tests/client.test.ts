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

/**
 * Stub variant that returns DIFFERENT usage objects on successive calls.
 * Used to model "first call writes to cache, second call reads from it".
 */
function withProgrammableStub(
  usages: Array<{
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  }>,
  opts?: ConstructorParameters<typeof CachedAnthropic>[0],
) {
  const warnings: WarningEvent[] = [];
  const client = new CachedAnthropic({
    apiKey: "test-key",
    onWarning: (w) => warnings.push(w),
    ...opts,
  });
  let callIdx = 0;
  const seen: unknown[] = [];
  // @ts-expect-error overriding the bound method for testing
  client.raw.messages.create = vi.fn(async (params: unknown) => {
    seen.push(params);
    const usage = usages[Math.min(callIdx, usages.length - 1)]!;
    callIdx += 1;
    return {
      id: `msg_${callIdx}`,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      model: "claude-sonnet-4-6",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage,
    };
  });
  return { client, warnings, seen };
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
    expect(client.stability().entries).toHaveLength(0);
  });
});

describe("CachedAnthropic v0.2 — autoCache", () => {
  it("places cache_control on the system prompt after observing it twice", async () => {
    const { client, seen } = withProgrammableStub(
      [
        { input_tokens: 100, output_tokens: 10 },
        { input_tokens: 100, output_tokens: 10 },
        { input_tokens: 100, output_tokens: 10 },
      ],
      { autoCache: true, autoCacheMinObservations: 2 },
    );

    const baseParams = {
      model: "claude-sonnet-4-6" as const,
      max_tokens: 100,
      system: "Stable system prompt repeated across calls",
      messages: [{ role: "user" as const, content: "q1" }],
    };

    await client.messages.create(baseParams);
    await client.messages.create({
      ...baseParams,
      messages: [{ role: "user", content: "q2" }],
    });
    await client.messages.create({
      ...baseParams,
      messages: [{ role: "user", content: "q3" }],
    });

    // First call sent unmodified; later calls should have auto-placed cache_control on system
    const lastCall = seen[2] as { system: unknown };
    expect(Array.isArray(lastCall.system)).toBe(true);
    const sys = lastCall.system as Array<Record<string, unknown>>;
    expect(sys[sys.length - 1]!.cache_control).toEqual({ type: "ephemeral" });
  });

  it("does not override user-placed cache_control", async () => {
    const { client, seen } = withProgrammableStub(
      [
        { input_tokens: 100, output_tokens: 10 },
        { input_tokens: 100, output_tokens: 10 },
      ],
      { autoCache: true, autoCacheMinObservations: 2 },
    );
    const params = {
      model: "claude-sonnet-4-6" as const,
      max_tokens: 100,
      system: [
        { type: "text" as const, text: "user-marked", cache_control: { type: "ephemeral" as const } },
      ],
      messages: [{ role: "user" as const, content: "hi" }],
    };
    await client.messages.create(params);
    await client.messages.create(params);

    const second = seen[1] as { system: Array<Record<string, unknown>> };
    // Exactly one cache_control marker — the user's, not duplicated
    expect(second.system).toHaveLength(1);
    expect(second.system[0]!.cache_control).toEqual({ type: "ephemeral" });
  });
});

describe("CachedAnthropic v0.2 — warning gating", () => {
  it("does not emit no-cache-control-found when autoCache is on", async () => {
    const { client, warnings } = withProgrammableStub(
      [{ input_tokens: 10, output_tokens: 5 }],
      { autoCache: true },
    );
    await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 100,
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(warnings.some((w) => w.code === "no-cache-control-found")).toBe(
      false,
    );
  });

  it("emits auto-placement-applied only when the placement set changes", async () => {
    const { client, warnings } = withProgrammableStub(
      Array.from({ length: 5 }, () => ({ input_tokens: 10, output_tokens: 5 })),
      { autoCache: true, autoCacheMinObservations: 2 },
    );
    const base = {
      model: "claude-sonnet-4-6" as const,
      max_tokens: 100,
      system: "the same system across calls",
      messages: [{ role: "user" as const, content: "q" }],
    };
    for (let i = 0; i < 5; i++) {
      await client.messages.create({
        ...base,
        messages: [{ role: "user", content: `q${i}` }],
      });
    }
    const applied = warnings.filter((w) => w.code === "auto-placement-applied");
    // Should fire exactly once when system becomes cacheable, not on every
    // subsequent call.
    expect(applied).toHaveLength(1);
  });

  it("does not emit cache-write-without-read on the very first cache write", async () => {
    const { client, warnings } = withProgrammableStub(
      [
        {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 500,
          cache_read_input_tokens: 0,
        },
      ],
      { diagnoseMisses: true },
    );
    await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 100,
      system: [
        { type: "text", text: "sys", cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: "hi" }],
    });
    expect(warnings.some((w) => w.code === "cache-write-without-read")).toBe(
      false,
    );
  });
});

describe("CachedAnthropic v0.2 — diagnoseMisses", () => {
  it("attaches a prefix diff when the cache misses on the second call", async () => {
    const { client, warnings } = withProgrammableStub(
      [
        // First call: cache write only
        {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 500,
          cache_read_input_tokens: 0,
        },
        // Second call: still cache write, no read (prefix changed)
        {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 500,
          cache_read_input_tokens: 0,
        },
      ],
      { diagnoseMisses: true },
    );

    await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 100,
      system: [
        { type: "text", text: "Today is Tuesday", cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: "hi" }],
    });
    await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 100,
      system: [
        { type: "text", text: "Today is Wednesday", cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: "hi" }],
    });

    const missWarning = warnings.find((w) => w.code === "cache-write-without-read");
    expect(missWarning).toBeDefined();
    expect(missWarning!.detail).toBeDefined();
    expect(missWarning!.message).toContain("Tuesday");
  });
});

describe("CachedAnthropic v0.2 — stability()", () => {
  it("returns per-segment scores", async () => {
    const { client } = withProgrammableStub([
      { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 },
      { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 },
    ]);
    const params = {
      model: "claude-sonnet-4-6" as const,
      max_tokens: 100,
      system: [
        { type: "text" as const, text: "sys", cache_control: { type: "ephemeral" as const } },
      ],
      messages: [{ role: "user" as const, content: "hi" }],
    };
    await client.messages.create(params);
    await client.messages.create(params);
    const report = client.stability();
    expect(report.entries.length).toBeGreaterThan(0);
    const system = report.entries.find((e) => e.segment === "system");
    expect(system?.stabilityScore).toBe(1);
  });
});
