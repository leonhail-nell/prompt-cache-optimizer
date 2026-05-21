import { describe, expect, it } from "vitest";

import { snapshotRequest } from "../src/analyzer/fingerprint.js";
import { StabilityTracker } from "../src/analyzer/stability-tracker.js";

describe("StabilityTracker", () => {
  it("marks a segment as stable after repeated identical observations", () => {
    const tracker = new StabilityTracker();
    const payload = {
      system: "stable system prompt",
      messages: [{ role: "user" as const, content: "hi" }],
    };
    tracker.observe(snapshotRequest(payload));
    tracker.observe(snapshotRequest(payload));

    const stable = tracker.stableSegments(2);
    expect(stable.some((s) => s.segment === "system")).toBe(true);
  });

  it("does not mark a segment stable when it changed between calls", () => {
    const tracker = new StabilityTracker();
    tracker.observe(
      snapshotRequest({
        system: "v1",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    tracker.observe(
      snapshotRequest({
        system: "v2",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    const stable = tracker.stableSegments(2);
    expect(stable.some((s) => s.segment === "system")).toBe(false);
  });

  it("report() reflects per-segment scores", () => {
    const tracker = new StabilityTracker();
    const payload = {
      system: "sys",
      messages: [{ role: "user" as const, content: "hi" }],
    };
    tracker.observe(snapshotRequest(payload));
    tracker.observe(snapshotRequest(payload));
    tracker.observe(snapshotRequest(payload));

    const report = tracker.report();
    const system = report.entries.find((e) => e.segment === "system")!;
    expect(system.callsObserved).toBe(3);
    expect(system.stabilityScore).toBe(1);
  });

  it("cumulative stabilityScore does not collapse to 0 after a single late change", () => {
    const tracker = new StabilityTracker();
    const stable = {
      system: "stable system prompt",
      messages: [{ role: "user" as const, content: "hi" }],
    };
    // Five identical observations
    for (let i = 0; i < 5; i++) tracker.observe(snapshotRequest(stable));
    // One drift
    tracker.observe(
      snapshotRequest({
        system: "stable system prompt CHANGED",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    const sys = tracker
      .report()
      .entries.find((e) => e.segment === "system")!;
    expect(sys.callsObserved).toBe(6);
    expect(sys.stabilityScore).toBeGreaterThan(0.5);
    // Auto-placer should NOT consider it stable right now though
    expect(tracker.stableSegments(2).some((s) => s.segment === "system")).toBe(
      false,
    );
  });

  it("reset() wipes state", () => {
    const tracker = new StabilityTracker();
    tracker.observe(
      snapshotRequest({
        system: "sys",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    tracker.reset();
    expect(tracker.report().entries).toHaveLength(0);
    expect(tracker.previousSnapshot()).toBeUndefined();
  });
});
