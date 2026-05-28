import { describe, expect, it } from "vitest";

import { CachedStream } from "../src/core/cached-stream.js";
import type { CacheInfo } from "../src/types.js";

/** Build an async iterable from an array of chunks. */
async function* fromArray<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) {
    yield item;
  }
}

const dummyCacheInfo = (cached: number): CacheInfo => ({
  hit: cached > 0,
  cachedTokens: cached,
  uncachedTokens: 100,
  cacheWriteTokens: 0,
  dollarsSaved: cached * 0.0001,
  dollarsSpent: 0.01,
});

describe("CachedStream", () => {
  it("yields chunks in order and resolves final() after consumption", async () => {
    const stream = new CachedStream<number, { last: number }>(
      fromArray([1, 2, 3]),
      {
        initialState: { last: 0 },
        onChunk: (chunk, state) => ({ last: chunk }),
        finalize: async (state) => ({ cacheInfo: dummyCacheInfo(state.last) }),
      },
    );

    const out: number[] = [];
    for await (const chunk of stream) {
      out.push(chunk);
    }
    expect(out).toEqual([1, 2, 3]);

    const { cacheInfo } = await stream.final();
    expect(cacheInfo.cachedTokens).toBe(3);
  });

  it("drains the stream itself when consumer skips iteration", async () => {
    const stream = new CachedStream<number, { count: number }>(
      fromArray([10, 20, 30, 40]),
      {
        initialState: { count: 0 },
        onChunk: (_chunk, state) => ({ count: state.count + 1 }),
        finalize: async (state) => ({ cacheInfo: dummyCacheInfo(state.count) }),
      },
    );

    // Skip iteration; call final() directly.
    const { cacheInfo } = await stream.final();
    expect(cacheInfo.cachedTokens).toBe(4);
  });

  it("rejects double iteration", async () => {
    const stream = new CachedStream<number, void>(fromArray([1]), {
      initialState: undefined,
      finalize: async () => ({ cacheInfo: dummyCacheInfo(0) }),
    });
    // First iteration succeeds.
    for await (const _ of stream) {
      /* drain */
    }
    // Second iteration should throw.
    let caught: unknown;
    try {
      for await (const _ of stream) {
        /* never */
      }
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).toMatch(/can only be iterated once/);
  });

  it("propagates errors from the upstream source through iteration", async () => {
    async function* errorStream(): AsyncGenerator<number> {
      yield 1;
      throw new Error("upstream blew up");
    }
    const stream = new CachedStream<number, void>(errorStream(), {
      initialState: undefined,
      finalize: async () => ({ cacheInfo: dummyCacheInfo(0) }),
    });
    const out: number[] = [];
    let caught: unknown;
    try {
      for await (const chunk of stream) {
        out.push(chunk);
      }
    } catch (err) {
      caught = err;
    }
    expect(out).toEqual([1]);
    expect((caught as Error).message).toBe("upstream blew up");
    // final() should also reject.
    await expect(stream.final()).rejects.toThrow("upstream blew up");
  });

  it("returns the same final value on multiple awaits", async () => {
    const stream = new CachedStream<number, void>(fromArray([1, 2]), {
      initialState: undefined,
      finalize: async () => ({ cacheInfo: dummyCacheInfo(42) }),
    });
    const a = await stream.final();
    const b = await stream.final();
    expect(a).toBe(b);
    expect(a.cacheInfo.cachedTokens).toBe(42);
  });

  it("passes the raw final value through", async () => {
    const finalRaw = { id: "final-msg", text: "done" };
    const stream = new CachedStream<number, void, typeof finalRaw>(
      fromArray([1]),
      {
        initialState: undefined,
        finalize: async () => ({ cacheInfo: dummyCacheInfo(0), raw: finalRaw }),
      },
    );
    const { raw } = await stream.final();
    expect(raw).toBe(finalRaw);
  });
});
