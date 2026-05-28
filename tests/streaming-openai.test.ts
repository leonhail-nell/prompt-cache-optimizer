import { describe, expect, it } from "vitest";

import { CachedOpenAI } from "../src/providers/openai/client.js";
import type {
  CachedOpenAIChatStream,
  OpenAIChatCompletionChunk,
} from "../src/providers/openai/client.js";
import type { WarningEvent } from "../src/types.js";

async function* asyncFrom<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) {
    yield item;
  }
}

/** Stub the OpenAI SDK to dispatch on `stream:true`. */
function withStubbedOpenAIStreaming(opts: {
  chunks: OpenAIChatCompletionChunk[];
  nonStreamUsage?: {
    prompt_tokens: number;
    completion_tokens: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}) {
  const warnings: WarningEvent[] = [];
  const seen: Array<Record<string, unknown>> = [];
  const client = new CachedOpenAI({
    apiKey: "test-key",
    warnIfPromptTooSmall: false,
    onWarning: (w) => warnings.push(w),
  });
  client.raw = {
    chat: {
      completions: {
        create: async (params: Record<string, unknown>) => {
          seen.push(params);
          if (params.stream === true) {
            return asyncFrom(opts.chunks);
          }
          return {
            id: "chatcmpl",
            choices: [{ message: { role: "assistant", content: "ok" } }],
            model: "gpt-4o",
            usage: opts.nonStreamUsage ?? {
              prompt_tokens: 0,
              completion_tokens: 0,
            },
          };
        },
      },
    },
  };
  return { client, warnings, seen };
}

describe("CachedOpenAI streaming", () => {
  it("returns a CachedStream when stream:true is passed", async () => {
    const { client, seen } = withStubbedOpenAIStreaming({
      chunks: [
        { choices: [{ delta: { content: "Hi" } }] },
        { choices: [{ delta: { content: " there" } }] },
        // Final chunk carries usage (when include_usage:true was set)
        {
          choices: [],
          usage: {
            prompt_tokens: 2000,
            completion_tokens: 10,
            prompt_tokens_details: { cached_tokens: 1800 },
          },
        },
      ],
    });

    const res = (await client.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    })) as CachedOpenAIChatStream;

    // It's iterable
    const collected: OpenAIChatCompletionChunk[] = [];
    for await (const chunk of res) {
      collected.push(chunk);
    }
    expect(collected).toHaveLength(3);

    // And it has a final() that resolves cacheInfo from the last chunk's usage
    const { cacheInfo } = await res.final();
    expect(cacheInfo.hit).toBe(true);
    expect(cacheInfo.cachedTokens).toBe(1800);
    expect(cacheInfo.uncachedTokens).toBe(200);

    // Auto-set stream_options.include_usage on the wire
    expect(
      (seen[0]!.stream_options as { include_usage?: boolean })?.include_usage,
    ).toBe(true);
  });

  it("warns once when auto-enabling include_usage", async () => {
    const { client, warnings } = withStubbedOpenAIStreaming({
      chunks: [
        { choices: [], usage: { prompt_tokens: 100, completion_tokens: 5 } },
      ],
    });

    const s1 = (await client.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "q1" }],
      stream: true,
    })) as CachedOpenAIChatStream;
    await s1.final();
    const s2 = (await client.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "q2" }],
      stream: true,
    })) as CachedOpenAIChatStream;
    await s2.final();

    const includeUsageWarnings = warnings.filter(
      (w) =>
        w.detail?.reason === "openai-include-usage-auto-on",
    );
    expect(includeUsageWarnings).toHaveLength(1);
  });

  it("non-streaming still works after the streaming refactor", async () => {
    const { client } = withStubbedOpenAIStreaming({
      chunks: [],
      nonStreamUsage: {
        prompt_tokens: 1500,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 1300 },
      },
    });

    const res = await client.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
    });
    // res is the non-stream type here (no stream:true)
    expect("cacheInfo" in res).toBe(true);
    const cacheInfo = (res as { cacheInfo: { cachedTokens: number; hit: boolean } }).cacheInfo;
    expect(cacheInfo.hit).toBe(true);
    expect(cacheInfo.cachedTokens).toBe(1300);
  });

  it("accumulates stats from streamed calls", async () => {
    const { client } = withStubbedOpenAIStreaming({
      chunks: [
        {
          choices: [],
          usage: {
            prompt_tokens: 2000,
            completion_tokens: 10,
            prompt_tokens_details: { cached_tokens: 1500 },
          },
        },
      ],
    });
    for (let i = 0; i < 3; i++) {
      const s = (await client.chat.completions.create({
        model: "gpt-4o",
        messages: [{ role: "user", content: `q${i}` }],
        stream: true,
      })) as CachedOpenAIChatStream;
      await s.final();
    }
    const stats = client.stats();
    expect(stats.totalCalls).toBe(3);
    expect(stats.totalCachedTokens).toBe(4500);
  });
});
