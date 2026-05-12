import { describe, expect, it } from "vitest";

import { computeCacheInfo } from "../src/tracking/hit-rate.js";
import { StatsAggregator } from "../src/tracking/stats.js";
import { lookupPricing } from "../src/pricing/models.js";

describe("computeCacheInfo", () => {
  it("reports a hit when cache_read_input_tokens > 0", () => {
    const info = computeCacheInfo(
      {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 8000,
      },
      lookupPricing("claude-sonnet-4-6"),
    );
    expect(info.hit).toBe(true);
    expect(info.cachedTokens).toBe(8000);
    expect(info.uncachedTokens).toBe(100);
    expect(info.dollarsSaved).toBeGreaterThan(0);
  });

  it("reports a miss when nothing was read from cache", () => {
    const info = computeCacheInfo(
      {
        input_tokens: 8000,
        output_tokens: 50,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      lookupPricing("claude-sonnet-4-6"),
    );
    expect(info.hit).toBe(false);
    expect(info.dollarsSaved).toBe(0);
  });

  it("returns zero dollars when pricing is unknown", () => {
    const info = computeCacheInfo(
      {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 8000,
      },
      undefined,
    );
    expect(info.hit).toBe(true);
    expect(info.dollarsSaved).toBe(0);
    expect(info.dollarsSpent).toBe(0);
  });

  it("handles missing cache fields gracefully", () => {
    const info = computeCacheInfo(
      { input_tokens: 100, output_tokens: 50 },
      lookupPricing("claude-sonnet-4-6"),
    );
    expect(info.hit).toBe(false);
    expect(info.cachedTokens).toBe(0);
    expect(info.cacheWriteTokens).toBe(0);
  });
});

describe("StatsAggregator", () => {
  it("starts at zero", () => {
    const s = new StatsAggregator();
    const snap = s.snapshot();
    expect(snap.totalCalls).toBe(0);
    expect(snap.hitRate).toBe(0);
  });

  it("accumulates hits and computes hit rate", () => {
    const s = new StatsAggregator();
    s.record({
      hit: true,
      cachedTokens: 100,
      uncachedTokens: 10,
      cacheWriteTokens: 0,
      dollarsSaved: 0.01,
      dollarsSpent: 0.001,
    });
    s.record({
      hit: false,
      cachedTokens: 0,
      uncachedTokens: 100,
      cacheWriteTokens: 100,
      dollarsSaved: 0,
      dollarsSpent: 0.003,
    });
    const snap = s.snapshot();
    expect(snap.totalCalls).toBe(2);
    expect(snap.cacheHits).toBe(1);
    expect(snap.hitRate).toBe(0.5);
    expect(snap.totalCachedTokens).toBe(100);
    expect(snap.dollarsSaved).toBeCloseTo(0.01);
  });

  it("rolling hit rate respects the window size", () => {
    const s = new StatsAggregator(3);
    // 5 hits then 3 misses — rolling window only sees the last 3 (all misses)
    for (let i = 0; i < 5; i++) {
      s.record(makeHit());
    }
    for (let i = 0; i < 3; i++) {
      s.record(makeMiss());
    }
    expect(s.rollingHitRate()).toBe(0);
    expect(s.snapshot().hitRate).toBeCloseTo(5 / 8);
  });

  it("reset clears everything", () => {
    const s = new StatsAggregator();
    s.record(makeHit());
    s.reset();
    expect(s.snapshot().totalCalls).toBe(0);
    expect(s.rollingSampleCount()).toBe(0);
  });
});

function makeHit() {
  return {
    hit: true,
    cachedTokens: 100,
    uncachedTokens: 0,
    cacheWriteTokens: 0,
    dollarsSaved: 0.001,
    dollarsSpent: 0.0001,
  };
}
function makeMiss() {
  return {
    hit: false,
    cachedTokens: 0,
    uncachedTokens: 100,
    cacheWriteTokens: 0,
    dollarsSaved: 0,
    dollarsSpent: 0.001,
  };
}
