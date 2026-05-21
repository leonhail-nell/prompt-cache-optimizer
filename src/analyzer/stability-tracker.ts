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
  callsStable: number;
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
      const score = seg.callsStable / denom;
      entries.push({
        segment: seg.segment,
        callsObserved: seg.callsObserved,
        callsStable: seg.callsStable,
        stabilityScore: score,
        approxTokens: seg.lastApproxTokens,
        lastChangeReason: seg.lastChangeReason,
      });
      totalObserved += seg.lastApproxTokens;
      if (score === 1 && seg.callsObserved > 1) {
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
   * `minObservations` calls. Sorted descending by approxTokens so the
   * auto-placer can pick the biggest wins first.
   */
  stableSegments(minObservations: number): TrackedSegment[] {
    const stable: TrackedSegment[] = [];
    for (const seg of this.segments.values()) {
      // "Stable" = has been observed at least `minObservations` times AND
      // the most recent run was unchanged from the prior one.
      if (
        seg.callsObserved >= minObservations &&
        seg.callsStable >= minObservations - 1
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
        callsStable: 0,
      });
      return;
    }
    prev.callsObserved += 1;
    prev.lastApproxTokens = approxTokens;
    if (prev.lastFingerprint === fingerprint) {
      prev.callsStable += 1;
    } else {
      prev.lastFingerprint = fingerprint;
      // Stability is "consecutive identical runs", so a change resets it.
      prev.callsStable = 0;
      if (changeReason !== undefined) {
        prev.lastChangeReason = changeReason;
      }
    }
  }
}
