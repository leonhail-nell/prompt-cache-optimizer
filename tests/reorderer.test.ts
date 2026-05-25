import { describe, expect, it } from "vitest";

import {
  applyAutoReorder,
  canonicalizeMessageContent,
  canonicalizeMessagePrefix,
  canonicalizeTools,
} from "../src/analyzer/reorderer.js";

/** Build a tool with the shape Anthropic's API expects. */
function tool(name: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    description: `tool ${name}`,
    input_schema: { type: "object", properties: {} },
    ...extra,
  };
}

function docBlock(id: string) {
  return {
    type: "document",
    source: { type: "text", media_type: "text/plain", data: id },
  };
}

function imageBlock(id: string) {
  return {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: id },
  };
}

function textBlock(text: string) {
  return { type: "text", text };
}

/* -------------------------------------------------------------------------- */
/* canonicalizeTools                                                           */
/* -------------------------------------------------------------------------- */

describe("canonicalizeTools", () => {
  it("alphabetizes tools by name", () => {
    const out = canonicalizeTools([tool("zeta"), tool("alpha"), tool("mu")]);
    expect(out.tools!.map((t) => t.name)).toEqual(["alpha", "mu", "zeta"]);
    expect(out.diagnostic?.itemsMoved).toBeGreaterThan(0);
  });

  it("is a no-op when already sorted", () => {
    const input = [tool("alpha"), tool("beta")];
    const out = canonicalizeTools(input);
    expect(out.tools).toBe(input); // identity — unchanged
    expect(out.diagnostic).toBeUndefined();
  });

  it("is a no-op when any tool has cache_control", () => {
    const input = [
      tool("zeta"),
      tool("alpha", { cache_control: { type: "ephemeral" } }),
    ];
    const out = canonicalizeTools(input);
    expect(out.tools).toBe(input);
    expect(out.diagnostic).toBeUndefined();
  });

  it("is a no-op when fewer than 2 tools", () => {
    expect(canonicalizeTools(undefined).tools).toBeUndefined();
    expect(canonicalizeTools([]).tools).toEqual([]);
    expect(canonicalizeTools([tool("only")]).tools!.length).toBe(1);
  });

  it("is a no-op when a tool is missing a name", () => {
    const input = [tool("alpha"), { description: "nameless" } as never];
    const out = canonicalizeTools(input);
    expect(out.tools).toBe(input);
  });

  it("reports the canonical order in detail", () => {
    const out = canonicalizeTools([tool("z"), tool("a"), tool("m")]);
    expect(out.diagnostic?.detail).toEqual({ order: ["a", "m", "z"] });
  });
});

/* -------------------------------------------------------------------------- */
/* canonicalizeMessageContent                                                  */
/* -------------------------------------------------------------------------- */

describe("canonicalizeMessageContent", () => {
  it("sorts a run of document blocks by fingerprint", () => {
    const message = {
      role: "user" as const,
      content: [docBlock("z"), docBlock("a"), docBlock("m")],
    };
    const out = canonicalizeMessageContent(message, 0);
    const types = (out.message.content as Array<{ source: { data: string } }>)
      .map((b) => b.source.data);
    // Just check it's stable and changed (the exact sort is by sha256 hex)
    expect(out.diagnostic?.itemsMoved).toBeGreaterThan(0);
    expect(types).toHaveLength(3);

    // Running it again should be a no-op now
    const idempotent = canonicalizeMessageContent(out.message, 0);
    expect(idempotent.diagnostic).toBeUndefined();
  });

  it("does not move text blocks", () => {
    const message = {
      role: "user" as const,
      content: [
        textBlock("intro"),
        docBlock("z"),
        docBlock("a"),
        textBlock("outro"),
      ],
    };
    const out = canonicalizeMessageContent(message, 0);
    const blocks = out.message.content as Array<Record<string, unknown>>;
    expect(blocks[0]!.type).toBe("text");
    expect(blocks[3]!.type).toBe("text");
    // The two docs in the middle may have swapped, depending on fingerprint
    expect(blocks[1]!.type).toBe("document");
    expect(blocks[2]!.type).toBe("document");
  });

  it("sorts each same-type run independently", () => {
    const message = {
      role: "user" as const,
      content: [
        docBlock("z"),
        docBlock("a"),
        textBlock("divider"),
        imageBlock("zzz"),
        imageBlock("aaa"),
      ],
    };
    const out = canonicalizeMessageContent(message, 0);
    const blocks = out.message.content as Array<{ type: string }>;
    expect(blocks.map((b) => b.type)).toEqual([
      "document",
      "document",
      "text",
      "image",
      "image",
    ]);
    expect(out.diagnostic?.itemsMoved).toBeGreaterThan(0);
  });

  it("does not reorder a run of length 1", () => {
    const message = {
      role: "user" as const,
      content: [docBlock("only"), textBlock("note"), imageBlock("only")],
    };
    const out = canonicalizeMessageContent(message, 0);
    expect(out.diagnostic).toBeUndefined();
  });

  it("is a no-op for string content", () => {
    const message = { role: "user" as const, content: "hello" };
    const out = canonicalizeMessageContent(message, 0);
    expect(out.message).toBe(message);
    expect(out.diagnostic).toBeUndefined();
  });

  it("is a no-op when any block carries cache_control", () => {
    const message = {
      role: "user" as const,
      content: [
        docBlock("z"),
        { ...docBlock("a"), cache_control: { type: "ephemeral" } },
      ],
    };
    const out = canonicalizeMessageContent(message, 0);
    expect(out.message).toBe(message);
    expect(out.diagnostic).toBeUndefined();
  });

  it("never moves tool_use / tool_result blocks", () => {
    const message = {
      role: "assistant" as const,
      content: [
        { type: "tool_use", id: "1", name: "x", input: {} },
        { type: "text", text: "..." },
      ],
    };
    const out = canonicalizeMessageContent(message, 0);
    expect(out.message).toBe(message);
    expect(out.diagnostic).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* canonicalizeMessagePrefix                                                   */
/* -------------------------------------------------------------------------- */

describe("canonicalizeMessagePrefix", () => {
  it("sorts a leading run of doc-only user messages", () => {
    const messages = [
      { role: "user" as const, content: [docBlock("zzz")] },
      { role: "user" as const, content: [docBlock("aaa")] },
      { role: "user" as const, content: [docBlock("mmm")] },
      { role: "user" as const, content: "now please answer" },
    ];
    const out = canonicalizeMessagePrefix(messages);
    expect(out.diagnostic?.itemsMoved).toBeGreaterThan(0);
    expect(out.diagnostic?.detail).toEqual({ prefixLength: 3 });
    // The question message stays last
    expect(out.messages[3]).toBe(messages[3]);
  });

  it("stops the prefix at the first message that breaks the pattern", () => {
    // Use object identity (`toBe`) to verify prefix detection, which is
    // robust against the (non-deterministic-from-test-perspective)
    // fingerprint sort order.
    const breaker = { role: "user" as const, content: [textBlock("oh wait")] };
    const afterBreaker = {
      role: "user" as const,
      content: [docBlock("never reached")],
    };
    const messages = [
      { role: "user" as const, content: [docBlock("z")] },
      { role: "user" as const, content: [docBlock("a")] },
      breaker,
      afterBreaker,
    ];
    const out = canonicalizeMessagePrefix(messages);
    // Both messages from index 2 onward stay in place — the scan stopped at
    // the text-content breaker, never reached the doc message after it.
    expect(out.messages[2]).toBe(breaker);
    expect(out.messages[3]).toBe(afterBreaker);
  });

  it("is a no-op when the first message is assistant", () => {
    const messages = [
      { role: "assistant" as const, content: "hi" },
      { role: "user" as const, content: [docBlock("z")] },
      { role: "user" as const, content: [docBlock("a")] },
    ];
    const out = canonicalizeMessagePrefix(messages);
    expect(out.diagnostic).toBeUndefined();
    expect(out.messages).toBe(messages);
  });

  it("is a no-op for prefix length < 2", () => {
    const out = canonicalizeMessagePrefix([
      { role: "user", content: [docBlock("z")] },
      { role: "user", content: "question" },
    ]);
    expect(out.diagnostic).toBeUndefined();
  });

  it("is a no-op when any prefix message has cache_control", () => {
    const messages = [
      {
        role: "user" as const,
        content: [{ ...docBlock("z"), cache_control: { type: "ephemeral" } }],
      },
      { role: "user" as const, content: [docBlock("a")] },
    ];
    const out = canonicalizeMessagePrefix(messages);
    expect(out.diagnostic).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* applyAutoReorder (integration)                                              */
/* -------------------------------------------------------------------------- */

describe("applyAutoReorder", () => {
  it("emits a diagnostic when tools get reordered", () => {
    // Tool sort is alphabetical and deterministic — "z" before "a" always
    // produces a moved tool, so this assertion is hash-independent.
    const out = applyAutoReorder({
      tools: [tool("z"), tool("a")],
      messages: [{ role: "user", content: "hi" }],
    });
    const segments = out.diagnostics.map((d) => d.segment);
    expect(segments).toContain("tools");
  });

  it("is fully idempotent: a second pass yields no diagnostics", () => {
    const first = applyAutoReorder({
      tools: [tool("z"), tool("a"), tool("m")],
      messages: [
        {
          role: "user",
          content: [docBlock("zz"), docBlock("aa")],
        },
        { role: "user", content: "question" },
      ],
    });
    const second = applyAutoReorder({
      system: first.system,
      tools: first.tools,
      messages: first.messages,
    });
    expect(second.diagnostics).toHaveLength(0);
  });

  it("passes system through untouched (system reorder is not in v0.3 scope)", () => {
    const sys = "system content";
    const out = applyAutoReorder({
      system: sys,
      tools: [tool("a")],
      messages: [{ role: "user", content: "hi" }],
    });
    expect(out.system).toBe(sys);
  });

  it("returns empty diagnostics when nothing is reorderable", () => {
    const out = applyAutoReorder({
      tools: [tool("a"), tool("b")],
      messages: [{ role: "user", content: "hi" }],
    });
    expect(out.diagnostics).toHaveLength(0);
  });
});
