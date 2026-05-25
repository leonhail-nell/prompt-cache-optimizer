import { describe, expect, it } from "vitest";

import { CachedOpenAI } from "../../src/providers/openai/client.js";
import {
  KNOWN_OPENAI_MODELS,
  lookupOpenAIPricing,
} from "../../src/providers/openai/pricing.js";
import { computeOpenAICacheInfo } from "../../src/providers/openai/usage.js";
import type { WarningEvent } from "../../src/types.js";

/**
 * Build a CachedOpenAI with the underlying `chat.completions.create`
 * stubbed. The wrapper's `raw` setter accepts a pre-constructed instance
 * so we never have to actually call OpenAI.
 */
function withStubbedOpenAI(
  usages: Array<{
    prompt_tokens: number;
    completion_tokens: number;
    prompt_tokens_details?: { cached_tokens?: number };
  }>,
  opts?: ConstructorParameters<typeof CachedOpenAI>[0],
) {
  const warnings: WarningEvent[] = [];
  const client = new CachedOpenAI({
    apiKey: "test-key",
    // Silence the default warn-on-small-prompt — most tests don't care
    warnIfPromptTooSmall: false,
    onWarning: (w) => warnings.push(w),
    ...opts,
  });
  let callIdx = 0;
  const seen: unknown[] = [];
  client.raw = {
    chat: {
      completions: {
        create: async (params: Record<string, unknown>) => {
          seen.push(params);
          const usage = usages[Math.min(callIdx, usages.length - 1)]!;
          callIdx += 1;
          return {
            id: `chatcmpl_${callIdx}`,
            choices: [
              { message: { role: "assistant" as const, content: "ok" } },
            ],
            model: "gpt-4o",
            usage,
          };
        },
      },
    },
  };
  return { client, warnings, seen };
}

/* -------------------------------------------------------------------------- */
/* Pricing                                                                     */
/* -------------------------------------------------------------------------- */

describe("OpenAI pricing", () => {
  it("matches exact model ids", () => {
    expect(lookupOpenAIPricing("gpt-4o")).toEqual(KNOWN_OPENAI_MODELS["gpt-4o"]);
  });
  it("matches version-suffixed model ids by prefix", () => {
    expect(lookupOpenAIPricing("gpt-4o-2024-08-06")).toEqual(
      KNOWN_OPENAI_MODELS["gpt-4o"],
    );
  });
  it("returns undefined for unknown models", () => {
    expect(lookupOpenAIPricing("totally-fake-model-9000")).toBeUndefined();
  });
  it("longest prefix wins (mini matches before gpt-4o)", () => {
    expect(lookupOpenAIPricing("gpt-4o-mini-2024")).toEqual(
      KNOWN_OPENAI_MODELS["gpt-4o-mini"],
    );
  });
  it("honors overrides", () => {
    const custom = { input: 99, output: 99, cacheWrite: 99, cacheRead: 9.9 };
    expect(lookupOpenAIPricing("gpt-4o", { "gpt-4o": custom })).toBe(custom);
  });
});

/* -------------------------------------------------------------------------- */
/* Usage extraction                                                            */
/* -------------------------------------------------------------------------- */

describe("computeOpenAICacheInfo", () => {
  it("subtracts cached_tokens from prompt_tokens for uncached count", () => {
    const info = computeOpenAICacheInfo(
      {
        prompt_tokens: 1000,
        completion_tokens: 50,
        prompt_tokens_details: { cached_tokens: 800 },
      },
      KNOWN_OPENAI_MODELS["gpt-4o"],
    );
    expect(info.cachedTokens).toBe(800);
    expect(info.uncachedTokens).toBe(200);
    expect(info.hit).toBe(true);
    expect(info.dollarsSaved).toBeGreaterThan(0);
  });

  it("reports cacheWriteTokens=0 (OpenAI has no separate write charge)", () => {
    const info = computeOpenAICacheInfo(
      {
        prompt_tokens: 1000,
        completion_tokens: 50,
      },
      KNOWN_OPENAI_MODELS["gpt-4o"],
    );
    expect(info.cacheWriteTokens).toBe(0);
    expect(info.hit).toBe(false);
  });

  it("handles missing pricing by returning zero-dollars but valid token counts", () => {
    const info = computeOpenAICacheInfo(
      {
        prompt_tokens: 1000,
        completion_tokens: 50,
        prompt_tokens_details: { cached_tokens: 800 },
      },
      undefined,
    );
    expect(info.cachedTokens).toBe(800);
    expect(info.dollarsSaved).toBe(0);
    expect(info.dollarsSpent).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Client wrapper                                                              */
/* -------------------------------------------------------------------------- */

describe("CachedOpenAI", () => {
  it("attaches cacheInfo on a cache hit", async () => {
    const { client } = withStubbedOpenAI([
      {
        prompt_tokens: 1500,
        completion_tokens: 30,
        prompt_tokens_details: { cached_tokens: 1300 },
      },
    ]);
    const res = await client.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.cacheInfo.hit).toBe(true);
    expect(res.cacheInfo.cachedTokens).toBe(1300);
    expect(res.cacheInfo.dollarsSaved).toBeGreaterThan(0);
  });

  it("accumulates stats across calls", async () => {
    const { client } = withStubbedOpenAI([
      {
        prompt_tokens: 1500,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 1200 },
      },
    ]);
    for (let i = 0; i < 3; i++) {
      await client.chat.completions.create({
        model: "gpt-4o",
        messages: [{ role: "user", content: `q${i}` }],
      });
    }
    const stats = client.stats();
    expect(stats.totalCalls).toBe(3);
    expect(stats.cacheHits).toBe(3);
    expect(stats.totalCachedTokens).toBe(3600);
  });

  it("emits unknown-model warning for unrecognized models", async () => {
    const { client, warnings } = withStubbedOpenAI([
      { prompt_tokens: 100, completion_tokens: 10 },
    ]);
    await client.chat.completions.create({
      model: "totally-fake-model-9000",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(warnings.some((w) => w.code === "unknown-model")).toBe(true);
  });

  it("emits prompt-too-small-for-cache when below the threshold", async () => {
    const { client, warnings } = withStubbedOpenAI(
      [{ prompt_tokens: 100, completion_tokens: 5 }],
      { warnIfPromptTooSmall: true },
    );
    await client.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
    });
    const w = warnings.find((x) => x.code === "prompt-too-small-for-cache");
    expect(w).toBeDefined();
    expect(w!.detail).toMatchObject({ threshold: 1024 });
  });

  it("respects a custom threshold", async () => {
    const { client, warnings } = withStubbedOpenAI(
      [{ prompt_tokens: 100, completion_tokens: 5 }],
      { warnIfPromptTooSmall: 50_000 }, // very large — always warn
    );
    await client.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(
      warnings.some((w) => w.code === "prompt-too-small-for-cache"),
    ).toBe(true);
  });

  it("autoReorder alphabetizes tools by function.name", async () => {
    const { client, seen, warnings } = withStubbedOpenAI(
      [{ prompt_tokens: 100, completion_tokens: 5 }],
      { autoReorder: true },
    );
    const fn = (name: string) => ({
      type: "function" as const,
      function: { name, parameters: {} },
    });
    await client.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      tools: [fn("zeta"), fn("alpha"), fn("mu")],
    });
    const sent = seen[0] as { tools: Array<{ function: { name: string } }> };
    expect(sent.tools.map((t) => t.function.name)).toEqual([
      "alpha",
      "mu",
      "zeta",
    ]);
    expect(warnings.some((w) => w.code === "auto-reorder-applied")).toBe(true);
  });

  it("does not reorder tools when autoReorder is off", async () => {
    const { client, seen } = withStubbedOpenAI([
      { prompt_tokens: 100, completion_tokens: 5 },
    ]);
    const fn = (name: string) => ({
      type: "function" as const,
      function: { name, parameters: {} },
    });
    await client.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      tools: [fn("zeta"), fn("alpha")],
    });
    const sent = seen[0] as { tools: Array<{ function: { name: string } }> };
    expect(sent.tools.map((t) => t.function.name)).toEqual(["zeta", "alpha"]);
  });

  it("emits cache-write-without-read only after prior cache activity", async () => {
    const { client, warnings } = withStubbedOpenAI(
      [
        // Call 1: cache hit (sets up "prior activity")
        {
          prompt_tokens: 2000,
          completion_tokens: 5,
          prompt_tokens_details: { cached_tokens: 1500 },
        },
        // Call 2: total miss — should fire the warning now
        { prompt_tokens: 2000, completion_tokens: 5 },
      ],
      { diagnoseMisses: true },
    );
    await client.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "q1" }],
    });
    await client.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "q2" }],
    });
    expect(warnings.some((w) => w.code === "cache-write-without-read")).toBe(
      true,
    );
  });

  it("does NOT emit cache-write-without-read on the very first call", async () => {
    const { client, warnings } = withStubbedOpenAI([
      { prompt_tokens: 2000, completion_tokens: 5 },
    ]);
    await client.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(warnings.some((w) => w.code === "cache-write-without-read")).toBe(
      false,
    );
  });

  it("resetStats clears stats and stability tracking", async () => {
    const { client } = withStubbedOpenAI([
      {
        prompt_tokens: 1500,
        completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: 1000 },
      },
    ]);
    await client.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(client.stats().totalCalls).toBe(1);
    client.resetStats();
    expect(client.stats().totalCalls).toBe(0);
    expect(client.stability().entries).toHaveLength(0);
  });
});
