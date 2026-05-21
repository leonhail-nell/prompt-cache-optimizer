import { describe, expect, it } from "vitest";

import { snapshotRequest } from "../src/analyzer/fingerprint.js";
import { diffSnapshots } from "../src/diagnostics/diff.js";

describe("diffSnapshots", () => {
  it("detects a system prompt edit and locates the change", () => {
    const prev = snapshotRequest({
      system: "Today is Tuesday and we are shipping.",
      messages: [{ role: "user", content: "hi" }],
    });
    const curr = snapshotRequest({
      system: "Today is Wednesday and we are shipping.",
      messages: [{ role: "user", content: "hi" }],
    });
    const diffs = diffSnapshots(prev, curr);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]!.segment).toBe("system");
    expect(diffs[0]!.summary).toContain("system prompt changed");
    expect(diffs[0]!.summary).toContain("Tuesday");
  });

  it("detects tool reorder", () => {
    const prev = snapshotRequest({
      tools: [
        { name: "search", input_schema: {} },
        { name: "calc", input_schema: {} },
      ],
      messages: [{ role: "user", content: "hi" }],
    });
    const curr = snapshotRequest({
      tools: [
        { name: "calc", input_schema: {} },
        { name: "search", input_schema: {} },
      ],
      messages: [{ role: "user", content: "hi" }],
    });
    const diffs = diffSnapshots(prev, curr);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]!.segment).toBe("tools");
    expect(diffs[0]!.summary).toContain("tool order changed");
  });

  it("detects message count change", () => {
    const prev = snapshotRequest({
      messages: [{ role: "user", content: "hi" }],
    });
    const curr = snapshotRequest({
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "there" },
      ],
    });
    const diffs = diffSnapshots(prev, curr);
    expect(diffs.some((d) => d.summary.includes("message count changed"))).toBe(
      true,
    );
  });

  it("returns empty array when nothing changed", () => {
    const payload = {
      system: "sys",
      messages: [{ role: "user" as const, content: "hi" }],
    };
    expect(diffSnapshots(snapshotRequest(payload), snapshotRequest(payload))).toEqual([]);
  });
});
