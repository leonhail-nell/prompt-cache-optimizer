/**
 * In-memory aggregate stats with a small rolling window for hit-rate alerting.
 *
 * Memory footprint is constant: we keep cumulative totals plus a ring buffer
 * of recent hit/miss booleans. No per-call payload retention.
 */

import type { CacheInfo, CacheStats } from "../types.js";

export class StatsAggregator {
  private totalCalls = 0;
  private cacheHits = 0;
  private totalCachedTokens = 0;
  private totalUncachedTokens = 0;
  private totalCacheWriteTokens = 0;
  private dollarsSaved = 0;
  private dollarsSpent = 0;

  private recentHits: boolean[] = [];
  private readonly windowSize: number;

  constructor(windowSize = 20) {
    this.windowSize = Math.max(1, windowSize);
  }

  record(info: CacheInfo): void {
    this.totalCalls += 1;
    if (info.hit) this.cacheHits += 1;
    this.totalCachedTokens += info.cachedTokens;
    this.totalUncachedTokens += info.uncachedTokens;
    this.totalCacheWriteTokens += info.cacheWriteTokens;
    this.dollarsSaved += info.dollarsSaved;
    this.dollarsSpent += info.dollarsSpent;

    this.recentHits.push(info.hit);
    if (this.recentHits.length > this.windowSize) {
      this.recentHits.shift();
    }
  }

  snapshot(): CacheStats {
    const hitRate = this.totalCalls === 0 ? 0 : this.cacheHits / this.totalCalls;
    return {
      totalCalls: this.totalCalls,
      cacheHits: this.cacheHits,
      hitRate,
      totalCachedTokens: this.totalCachedTokens,
      totalUncachedTokens: this.totalUncachedTokens,
      totalCacheWriteTokens: this.totalCacheWriteTokens,
      dollarsSaved: this.dollarsSaved,
      dollarsSpent: this.dollarsSpent,
    };
  }

  /** Hit rate over the most recent N calls (N = windowSize). */
  rollingHitRate(): number {
    if (this.recentHits.length === 0) return 0;
    const hits = this.recentHits.filter(Boolean).length;
    return hits / this.recentHits.length;
  }

  /** Number of samples in the rolling window so far. */
  rollingSampleCount(): number {
    return this.recentHits.length;
  }

  reset(): void {
    this.totalCalls = 0;
    this.cacheHits = 0;
    this.totalCachedTokens = 0;
    this.totalUncachedTokens = 0;
    this.totalCacheWriteTokens = 0;
    this.dollarsSaved = 0;
    this.dollarsSpent = 0;
    this.recentHits = [];
  }
}
