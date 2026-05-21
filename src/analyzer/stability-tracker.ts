/**
 * v0.2: tracks fingerprint history per segment across calls.
 *
 * The auto-placer asks this tracker "which segments have been stable long
 * enough to be worth caching?" and the diagnostic uses the previous snapshot
 * to build a human-readable diff when the cache misses.
 *
 * Memory footprint: O(segments tracked). We keep only the last fingerprint
 * per segment plus counters, not the full payload history.
 */

import type { StabilityEntry, StabilityReport } from "../types.js";
import type { RequestSnapshot } from "./fingerprint.js";

interface TrackedSegment {
  segment: string;
  lastFingerprint: string;
  lastApproxTokens: number;
  callsObserved: number;
  /**
   * Cumulative count of times the fingerprint matched the prior observation.
   * Never decreases — used to compute the report's `stabilityScore` so a
   * single late change doesn't wipe out a long history of stability.
   */
  totalStable: number;
  /**
   * Length of the current streak of unchanged observations. Resets to 0 on
   * any change. Used by the auto-placer to decide whether a segment is
   * cacheable RIGHT NOW.
   */
  consecutiveStable: number;
  lastChangeReason?: string;
}

export class StabilityTracker {
  private readonly segments = new Map<string, TrackedSegment>();
  private lastSnapshot: RequestSnapshot | undefined;

  /** Feed in the snapshot for a new request. Updates counters. */
  observe(snapshot: RequestSnapshot, changeReasonHints?: Record<string, string>): void {
    if (snapshot.system) {
      this.update("system", snapshot.system.fingerprint, snapshot.system.approxTokens, changeReasonHints?.system);
    }
    if (snapshot.tools) {
      this.update("tools", snapshot.tools.fingerprint, snapshot.tools.approxTokens, changeReasonHints?.tools);
    }
    for (const prefix of snapshot.messagePrefixes) {
      const id = `messages[0..${prefix.upToIndex + 1}]`;
      this.update(id, prefix.fingerprint, prefix.approxTokens, changeReasonHints?.[id]);
    }
    this.lastSnapshot = snapshot;
  }

  /** Snapshot of the most recently observed request, if any. */
  previousSnapshot(): RequestSnapshot | undefined {
    return this.lastSnapshot;
  }

  /** Snapshot of every segment's current stability score. */
  report(): StabilityReport {
    const entries: StabilityEntry[] = [];
    let totalStable = 0;
    let totalObserved = 0;
    for (const seg of this.segments.values()) {
      const denom = Math.max(1, seg.callsObserved - 1);
      // Score is cumulative — a stretch of stability isn't erased by one
      // late change. Use consecutiveStable to know "is it stable RIGHT NOW".
      const score = seg.totalStable / denom;
      entries.push({
        segment: seg.segment,
        callsObserved: seg.callsObserved,
        callsStable: seg.totalStable,
        stabilityScore: score,
        approxTokens: seg.lastApproxTokens,
        lastChangeReason: seg.lastChangeReason,
      });
      totalObserved += seg.lastApproxTokens;
      // "Currently stable" = at least 1 consecutive identical observation
      if (seg.consecutiveStable >= 1) {
        totalStable += seg.lastApproxTokens;
      }
    }
    return {
      entries,
      totalStableTokens: totalStable,
      totalObservedTokens: totalObserved,
    };
  }

  /**
   * Return the list of segments that have been stable for at least
   * `minObservations` calls IN A ROW (consecutive). Sorted descending by
   * approxTokens so the auto-placer can pick the biggest wins first.
   */
  stableSegments(minObservations: number): TrackedSegment[] {
    const stable: TrackedSegment[] = [];
    for (const seg of this.segments.values()) {
      if (
        seg.callsObserved >= minObservations &&
        seg.consecutiveStable >= minObservations - 1
      ) {
        stable.push(seg);
      }
    }
    stable.sort((a, b) => b.lastApproxTokens - a.lastApproxTokens);
    return stable;
  }

  /** Wipe all tracking state. */
  reset(): void {
    this.segments.clear();
    this.lastSnapshot = undefined;
  }

  private update(
    segment: string,
    fingerprint: string,
    approxTokens: number,
    changeReason?: string,
  ): void {
    const prev = this.segments.get(segment);
    if (!prev) {
      this.segments.set(segment, {
        segment,
        lastFingerprint: fingerprint,
        lastApproxTokens: approxTokens,
        callsObserved: 1,
        totalStable: 0,
        consecutiveStable: 0,
      });
      return;
    }
    prev.callsObserved += 1;
    prev.lastApproxTokens = approxTokens;
    if (prev.lastFingerprint === fingerprint) {
      prev.totalStable += 1;
      prev.consecutiveStable += 1;
    } else {
      prev.lastFingerprint = fingerprint;
      // Only the "is it stable right now" counter resets; the cumulative
      // total stays so the report doesn't lie about long histories.
      prev.consecutiveStable = 0;
      if (changeReason !== undefined) {
        prev.lastChangeReason = changeReason;
      }
    }
  }
}
