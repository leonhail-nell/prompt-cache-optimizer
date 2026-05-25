import { describe, expect, it } from "vitest";

import { CachedGemini } from "../../src/providers/gemini/client.js";
import {
  KNOWN_GEMINI_MODELS,
  lookupGeminiPricing,
} from "../../src/providers/gemini/pricing.js";
import { computeGeminiCacheInfo } from "../../src/providers/gemini/usage.js";
import type { WarningEvent } from "../../src/types.js";

function withStubbedGemini(
  usages: Array<{
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
  }>,
  opts?: ConstructorParameters<typeof CachedGemini>[0],
) {
  const warnings: WarningEvent[] = [];
  const client = new CachedGemini({
    apiKey: "test-key",
    onWarning: (w) => warnings.push(w),
    ...opts,
  });
  let callIdx = 0;
  const seen: unknown[] = [];
  const cachesSeen: { create: number; delete: number } = {
    create: 0,
    delete: 0,
  };
  client.raw = {
    models: {
      generateContent: async (params: Record<string, unknown>) => {
        seen.push(params);
        const usage = usages[Math.min(callIdx, usages.length - 1)]!;
        callIdx += 1;
        return {
          text: "ok",
          candidates: [],
          usageMetadata: usage,
        };
      },
    },
    caches: {
      create: async () => {
        cachesSeen.create += 1;
        return {
          name: `cachedContents/test-${cachesSeen.create}`,
          model: "gemini-2.5-flash",
        };
      },
      get: async () => ({ name: "cachedContents/test-1" }),
      delete: async () => {
        cachesSeen.delete += 1;
        return {};
      },
      list: async () => [],
      update: async () => ({ name: "cachedContents/test-1" }),
    },
  };
  return { client, warnings, seen, cachesSeen };
}

/* -------------------------------------------------------------------------- */
/* Pricing                                                                     */
/* -------------------------------------------------------------------------- */

describe("Gemini pricing", () => {
  it("matches exact bare model ids", () => {
    expect(lookupGeminiPricing("gemini-2.5-flash")).toEqual(
      KNOWN_GEMINI_MODELS["gemini-2.5-flash"],
    );
  });
  it("matches resource-name form (models/...)", () => {
    expect(lookupGeminiPricing("models/gemini-2.5-flash")).toEqual(
      KNOWN_GEMINI_MODELS["gemini-2.5-flash"],
    );
  });
  it("matches version-suffixed ids by prefix", () => {
    expect(lookupGeminiPricing("gemini-2.5-flash-001")).toEqual(
      KNOWN_GEMINI_MODELS["gemini-2.5-flash"],
    );
  });
  it("longest prefix wins (flash-lite matches before flash)", () => {
    expect(lookupGeminiPricing("gemini-2.5-flash-lite-001")).toEqual(
      KNOWN_GEMINI_MODELS["gemini-2.5-flash-lite"],
    );
  });
  it("returns undefined for unknown models", () => {
    expect(lookupGeminiPricing("gemini-fictional-9000")).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* Usage extraction                                                            */
/* -------------------------------------------------------------------------- */

describe("computeGeminiCacheInfo", () => {
  it("subtracts cachedContentTokenCount from promptTokenCount", () => {
    const info = computeGeminiCacheInfo(
      {
        promptTokenCount: 5000,
        candidatesTokenCount: 100,
        cachedContentTokenCount: 4500,
      },
      KNOWN_GEMINI_MODELS["gemini-2.5-flash"],
    );
    expect(info.cachedTokens).toBe(4500);
    expect(info.uncachedTokens).toBe(500);
    expect(info.hit).toBe(true);
    expect(info.dollarsSaved).toBeGreaterThan(0);
  });

  it("handles missing usageMetadata gracefully", () => {
    const info = computeGeminiCacheInfo(undefined, undefined);
    expect(info.cachedTokens).toBe(0);
    expect(info.uncachedTokens).toBe(0);
    expect(info.hit).toBe(false);
  });

  it("hit is false when cachedContentTokenCount is missing", () => {
    const info = computeGeminiCacheInfo(
      { promptTokenCount: 1000, candidatesTokenCount: 50 },
      KNOWN_GEMINI_MODELS["gemini-2.5-flash"],
    );
    expect(info.hit).toBe(false);
    expect(info.uncachedTokens).toBe(1000);
  });
});

/* -------------------------------------------------------------------------- */
/* Client wrapper                                                              */
/* -------------------------------------------------------------------------- */

describe("CachedGemini", () => {
  it("attaches cacheInfo on a cache hit", async () => {
    const { client } = withStubbedGemini([
      {
        promptTokenCount: 5000,
        candidatesTokenCount: 100,
        cachedContentTokenCount: 4500,
      },
    ]);
    const res = await client.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
    });
    expect(res.cacheInfo.hit).toBe(true);
    expect(res.cacheInfo.cachedTokens).toBe(4500);
  });

  it("accumulates stats across calls", async () => {
    const { client } = withStubbedGemini([
      {
        promptTokenCount: 5000,
        candidatesTokenCount: 100,
        cachedContentTokenCount: 4500,
      },
    ]);
    for (let i = 0; i < 3; i++) {
      await client.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [{ role: "user", parts: [{ text: `q${i}` }] }],
      });
    }
    const stats = client.stats();
    expect(stats.totalCalls).toBe(3);
    expect(stats.cacheHits).toBe(3);
    expect(stats.totalCachedTokens).toBe(13500);
  });

  it("emits gemini-cache-applied when config.cachedContent is passed", async () => {
    const { client, warnings } = withStubbedGemini([
      {
        promptTokenCount: 5000,
        candidatesTokenCount: 50,
        cachedContentTokenCount: 4800,
      },
    ]);
    await client.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      config: { cachedContent: "cachedContents/abc123" },
    });
    expect(warnings.some((w) => w.code === "gemini-cache-applied")).toBe(true);
  });

  it("autoReorder alphabetizes functionDeclarations within a tool entry", async () => {
    const { client, seen, warnings } = withStubbedGemini(
      [{ promptTokenCount: 100, candidatesTokenCount: 5 }],
      { autoReorder: true },
    );
    const fn = (name: string) => ({ name, parameters: { type: "object" } });
    await client.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      config: {
        tools: [
          {
            functionDeclarations: [fn("zeta"), fn("alpha"), fn("mu")],
          },
        ],
      },
    });
    const sent = seen[0] as {
      config: { tools: Array<{ functionDeclarations: Array<{ name: string }> }> };
    };
    expect(
      sent.config.tools[0]!.functionDeclarations.map((f) => f.name),
    ).toEqual(["alpha", "mu", "zeta"]);
    expect(warnings.some((w) => w.code === "auto-reorder-applied")).toBe(true);
  });

  it("caches.create pass-through emits gemini-cache-applied", async () => {
    const { client, warnings, cachesSeen } = withStubbedGemini([
      { promptTokenCount: 0, candidatesTokenCount: 0 },
    ]);
    const cache = await client.caches.create({
      model: "gemini-2.5-flash",
      config: { contents: [{ role: "user", parts: [{ text: "doc" }] }] },
    });
    expect(cache.name).toMatch(/^cachedContents\//);
    expect(cachesSeen.create).toBe(1);
    expect(warnings.some((w) => w.code === "gemini-cache-applied")).toBe(true);
  });

  it("caches.delete pass-through forwards to the SDK", async () => {
    const { client, cachesSeen } = withStubbedGemini([
      { promptTokenCount: 0, candidatesTokenCount: 0 },
    ]);
    await client.caches.delete({ name: "cachedContents/abc" });
    expect(cachesSeen.delete).toBe(1);
  });

  it("emits unknown-model warning for unrecognized Gemini models", async () => {
    const { client, warnings } = withStubbedGemini([
      { promptTokenCount: 100, candidatesTokenCount: 10 },
    ]);
    await client.models.generateContent({
      model: "gemini-fictional-9000",
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
    });
    expect(warnings.some((w) => w.code === "unknown-model")).toBe(true);
  });

  it("does not emit cache-write-without-read on the first call", async () => {
    const { client, warnings } = withStubbedGemini([
      { promptTokenCount: 1000, candidatesTokenCount: 5 },
    ]);
    await client.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
    });
    expect(warnings.some((w) => w.code === "cache-write-without-read")).toBe(
      false,
    );
  });

  it("resetStats clears stats and stability tracking", async () => {
    const { client } = withStubbedGemini([
      {
        promptTokenCount: 5000,
        candidatesTokenCount: 50,
        cachedContentTokenCount: 4800,
      },
    ]);
    await client.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
    });
    expect(client.stats().totalCalls).toBe(1);
    client.resetStats();
    expect(client.stats().totalCalls).toBe(0);
    expect(client.stability().entries).toHaveLength(0);
  });
});
