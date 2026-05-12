import { describe, expect, it } from "vitest";

import {
  hasAnyCacheControl,
  placeBreakpoints,
} from "../src/analyzer/breakpoint-placer.js";

describe("placeBreakpoints", () => {
  it("marks a string system prompt as cacheable (after-system)", () => {
    const out = placeBreakpoints({
      system: "You are a helpful assistant.",
      messages: [{ role: "user", content: "Hi" }],
      strategy: "after-system",
    });
    expect(Array.isArray(out.system)).toBe(true);
    const sys = out.system as Array<Record<string, unknown>>;
    expect(sys[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(out.placements).toHaveLength(1);
    expect(out.placements[0]!.position).toBe("after-system");
  });

  it("appends cache_control to the last block of an array system prompt", () => {
    const out = placeBreakpoints({
      system: [
        { type: "text", text: "Role description" },
        { type: "text", text: "Documents..." },
      ],
      messages: [{ role: "user", content: "Hi" }],
      strategy: "after-system",
    });
    const sys = out.system as Array<Record<string, unknown>>;
    expect(sys[0]!.cache_control).toBeUndefined();
    expect(sys[1]!.cache_control).toEqual({ type: "ephemeral" });
  });

  it("caches after last assistant turn (after-last-assistant)", () => {
    const out = placeBreakpoints({
      messages: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello there." },
        { role: "user", content: "Tell me a joke" },
      ],
      strategy: "after-last-assistant",
    });
    const assistantMsg = out.messages[1]!.content as Array<
      Record<string, unknown>
    >;
    expect(Array.isArray(assistantMsg)).toBe(true);
    expect(assistantMsg[0]!.cache_control).toEqual({ type: "ephemeral" });
  });

  it("system-and-history applies both", () => {
    const out = placeBreakpoints({
      system: "sys",
      messages: [
        { role: "user", content: "u1" },
        { role: "assistant", content: "a1" },
      ],
      strategy: "system-and-history",
    });
    expect(out.placements.map((p) => p.position).sort()).toEqual([
      "after-last-assistant",
      "after-system",
    ]);
  });

  it("after-last-assistant is a no-op when there are no assistant messages yet", () => {
    const out = placeBreakpoints({
      messages: [{ role: "user", content: "Hi" }],
      strategy: "after-last-assistant",
    });
    expect(out.placements).toHaveLength(0);
  });

  it("does not mutate inputs", () => {
    const messages = [{ role: "user" as const, content: "Hi" }];
    const system = "sys";
    placeBreakpoints({ system, messages, strategy: "after-system" });
    expect(system).toBe("sys");
    expect(messages[0]!.content).toBe("Hi");
  });
});

describe("hasAnyCacheControl", () => {
  it("returns true for marked system block", () => {
    expect(
      hasAnyCacheControl({
        system: [
          { type: "text", text: "x", cache_control: { type: "ephemeral" } },
        ],
        messages: [],
      }),
    ).toBe(true);
  });

  it("returns false when nothing is marked", () => {
    expect(
      hasAnyCacheControl({
        system: [{ type: "text", text: "x" }],
        messages: [{ role: "user", content: "hi" }],
      }),
    ).toBe(false);
  });

  it("returns true for marked tool", () => {
    expect(
      hasAnyCacheControl({
        messages: [],
        tools: [{ name: "search", cache_control: { type: "ephemeral" } }],
      }),
    ).toBe(true);
  });
});
