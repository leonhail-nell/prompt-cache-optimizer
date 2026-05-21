import { describe, expect, it } from "vitest";

import {
  approxTokenCount,
  fingerprint,
  snapshotRequest,
} from "../src/analyzer/fingerprint.js";

describe("fingerprint", () => {
  it("is stable across runs for the same input", () => {
    const a = fingerprint({ b: 1, a: 2, nested: { y: 1, x: 2 } });
    const b = fingerprint({ a: 2, b: 1, nested: { x: 2, y: 1 } });
    expect(a).toBe(b);
  });

  it("differs when array order differs", () => {
    expect(fingerprint([1, 2, 3])).not.toBe(fingerprint([3, 2, 1]));
  });

  it("is sensitive to cache_control fields (raw form); snapshotRequest strips them", () => {
    // The bare fingerprint() function is purely structural — it does NOT
    // strip cache_control. The cache-control stripping happens inside
    // snapshotRequest before fingerprinting (covered by its own test below).
    const a = fingerprint([{ type: "text", text: "hi" }]);
    const b = fingerprint([
      { type: "text", text: "hi", cache_control: { type: "ephemeral" } },
    ]);
    expect(a).not.toBe(b);
  });
});

describe("snapshotRequest", () => {
  it("produces one entry per cumulative message prefix", () => {
    const snap = snapshotRequest({
      system: "sys",
      messages: [
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
        { role: "user", content: "c" },
      ],
    });
    expect(snap.messagePrefixes).toHaveLength(3);
    expect(snap.messagePrefixes[0]!.upToIndex).toBe(0);
    expect(snap.messagePrefixes[2]!.upToIndex).toBe(2);
  });

  it("system fingerprint is independent of cache_control markers", () => {
    const withMark = snapshotRequest({
      system: [
        { type: "text", text: "x", cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: "hi" }],
    });
    const noMark = snapshotRequest({
      system: [{ type: "text", text: "x" }],
      messages: [{ role: "user", content: "hi" }],
    });
    expect(withMark.system!.fingerprint).toBe(noMark.system!.fingerprint);
  });

  it("approxTokenCount returns positive integer for non-empty input", () => {
    expect(approxTokenCount("hello world")).toBeGreaterThan(0);
  });
});
