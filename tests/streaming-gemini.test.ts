import { describe, expect, it } from "vitest";

import {
  CachedGemini,
  type GeminiResponse,
} from "../src/providers/gemini/client.js";

async function* asyncFrom<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) {
    yield item;
  }
}

function withStubbedGeminiStreaming(chunks: GeminiResponse[]) {
  const client = new CachedGemini({ apiKey: "test-key" });
  client.raw = {
    models: {
      generateContent: async () => ({ text: "non-stream" }),
      generateContentStream: async () => asyncFrom(chunks),
    },
    caches: {
      create: async () => ({ name: "cachedContents/x" }),
      get: async () => ({ name: "cachedContents/x" }),
      delete: async () => ({}),
      list: async () => [],
      update: async () => ({ name: "cachedContents/x" }),
    },
  };
  return { client };
}

describe("CachedGemini streaming", () => {
  it("yields chunks and resolves final cacheInfo from the last usageMetadata", async () => {
    const { client } = withStubbedGeminiStreaming([
      { text: "Hi" },
      { text: " there" },
      {
        text: "",
        usageMetadata: {
          promptTokenCount: 5000,
          candidatesTokenCount: 100,
          cachedContentTokenCount: 4800,
        },
      },
    ]);
    const stream = await client.models.generateContentStream({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
    });

    const collected: GeminiResponse[] = [];
    for await (const chunk of stream) {
      collected.push(chunk);
    }
    expect(collected).toHaveLength(3);

    const { cacheInfo } = await stream.final();
    expect(cacheInfo.hit).toBe(true);
    expect(cacheInfo.cachedTokens).toBe(4800);
    expect(cacheInfo.uncachedTokens).toBe(200);
  });

  it("handles streams with no usageMetadata gracefully", async () => {
    const { client } = withStubbedGeminiStreaming([
      { text: "Hi" },
      { text: " there" },
    ]);
    const stream = await client.models.generateContentStream({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
    });
    const { cacheInfo } = await stream.final();
    expect(cacheInfo.hit).toBe(false);
    expect(cacheInfo.cachedTokens).toBe(0);
    expect(cacheInfo.uncachedTokens).toBe(0);
  });

  it("accumulates stats from streamed calls", async () => {
    const { client } = withStubbedGeminiStreaming([
      {
        text: "",
        usageMetadata: {
          promptTokenCount: 5000,
          candidatesTokenCount: 50,
          cachedContentTokenCount: 4500,
        },
      },
    ]);
    for (let i = 0; i < 3; i++) {
      const s = await client.models.generateContentStream({
        model: "gemini-2.5-flash",
        contents: [{ role: "user", parts: [{ text: `q${i}` }] }],
      });
      await s.final();
    }
    const stats = client.stats();
    expect(stats.totalCalls).toBe(3);
    expect(stats.totalCachedTokens).toBe(13500);
  });
});
