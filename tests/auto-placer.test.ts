import { describe, expect, it } from "vitest";

import { autoPlaceBreakpoints } from "../src/analyzer/auto-placer.js";
import { snapshotRequest } from "../src/analyzer/fingerprint.js";
import { StabilityTracker } from "../src/analyzer/stability-tracker.js";

function makePayload(opts: { system?: string; toolNames?: string[] } = {}) {
  return {
    system: opts.system ?? "stable system",
    tools: opts.toolNames?.map((name) => ({
      name,
      description: `tool ${name}`,
      input_schema: { type: "object", properties: {} },
    })),
    messages: [{ role: "user" as const, content: "hi" }],
  };
}

describe("autoPlaceBreakpoints", () => {
  it("returns a no-op when nothing has been observed", () => {
    const tracker = new StabilityTracker();
    const payload = makePayload();
    const out = autoPlaceBreakpoints({
      ...payload,
      tracker,
      minObservations: 2,
    });
    expect(out.placements).toHaveLength(0);
    expect(out.system).toBe(payload.system);
  });

  it("places a system breakpoint once the system has been stable", () => {
    const tracker = new StabilityTracker();
    const payload = makePayload();
    tracker.observe(snapshotRequest(payload));
    tracker.observe(snapshotRequest(payload));

    const out = autoPlaceBreakpoints({
      ...payload,
      tracker,
      minObservations: 2,
    });
    expect(out.placements.some((p) => p.position === "after-system")).toBe(true);
    const sys = out.system as Array<Record<string, unknown>>;
    expect(sys[0]!.cache_control).toEqual({ type: "ephemeral" });
  });

  it("also caches tools when they are stable", () => {
    const tracker = new StabilityTracker();
    const payload = makePayload({ toolNames: ["search", "calc"] });
    tracker.observe(snapshotRequest(payload));
    tracker.observe(snapshotRequest(payload));

    const out = autoPlaceBreakpoints({
      ...payload,
      tracker,
      minObservations: 2,
    });
    expect(out.placements.some((p) => p.position === "after-tools")).toBe(true);
    const tools = out.tools!;
    expect(tools[tools.length - 1]!.cache_control).toEqual({
      type: "ephemeral",
    });
  });

  it("respects minObservations", () => {
    const tracker = new StabilityTracker();
    const payload = makePayload();
    tracker.observe(snapshotRequest(payload));
    tracker.observe(snapshotRequest(payload));

    const out = autoPlaceBreakpoints({
      ...payload,
      tracker,
      minObservations: 5,
    });
    expect(out.placements).toHaveLength(0);
  });
});
