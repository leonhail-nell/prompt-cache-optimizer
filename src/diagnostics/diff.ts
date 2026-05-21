/**
 * v0.2: human-readable prefix diff for cache misses.
 *
 * When a cache_creation_input_tokens > 0 / cache_read_input_tokens === 0
 * event fires, the user wants to know WHAT changed in their cacheable
 * prefix — not just that something did. This module compares the previous
 * request snapshot to the current one and surfaces the smallest useful
 * description.
 *
 * Returns an array because a single call can have multiple segments shift
 * (e.g. tools reordered AND a message edited).
 */

import type { PrefixDiff } from "../types.js";
import type { RequestSnapshot } from "../analyzer/fingerprint.js";

type AnyBlock = { [k: string]: unknown };
type SystemInput =
  | string
  | Array<{ type: "text"; text: string; [k: string]: unknown }>;
interface MessageParam {
  role: "user" | "assistant";
  content: string | Array<AnyBlock>;
}

export function diffSnapshots(
  prev: RequestSnapshot,
  curr: RequestSnapshot,
): PrefixDiff[] {
  const diffs: PrefixDiff[] = [];

  if (prev.system && curr.system) {
    if (prev.system.fingerprint !== curr.system.fingerprint) {
      diffs.push(diffSystem(prev.system.raw, curr.system.raw));
    }
  } else if (!!prev.system !== !!curr.system) {
    diffs.push({
      segment: "system",
      summary: prev.system
        ? "system prompt was removed"
        : "system prompt was added",
    });
  }

  if (prev.tools && curr.tools) {
    if (prev.tools.fingerprint !== curr.tools.fingerprint) {
      diffs.push(diffTools(prev.tools.raw, curr.tools.raw));
    }
  } else if (!!prev.tools !== !!curr.tools) {
    diffs.push({
      segment: "tools",
      summary: prev.tools ? "tools array was removed" : "tools array was added",
    });
  }

  // Messages: find the first prefix that differs
  const minLen = Math.min(
    prev.messagePrefixes.length,
    curr.messagePrefixes.length,
  );
  let firstDifferentIdx = -1;
  for (let i = 0; i < minLen; i++) {
    if (
      prev.messagePrefixes[i]!.fingerprint !==
      curr.messagePrefixes[i]!.fingerprint
    ) {
      firstDifferentIdx = i;
      break;
    }
  }
  if (firstDifferentIdx >= 0) {
    const prevMsg = prev.messagePrefixes[firstDifferentIdx]!.raw[firstDifferentIdx];
    const currMsg = curr.messagePrefixes[firstDifferentIdx]!.raw[firstDifferentIdx];
    diffs.push(diffMessage(firstDifferentIdx, prevMsg, currMsg));
  } else if (prev.messagePrefixes.length !== curr.messagePrefixes.length) {
    diffs.push({
      segment: "messages",
      summary: `message count changed: was ${prev.messagePrefixes.length}, now ${curr.messagePrefixes.length}`,
      detail: {
        previousCount: prev.messagePrefixes.length,
        currentCount: curr.messagePrefixes.length,
      },
    });
  }

  return diffs;
}

function diffSystem(prev: SystemInput, curr: SystemInput): PrefixDiff {
  const prevText = stringifySystem(prev);
  const currText = stringifySystem(curr);
  const change = firstCharDiff(prevText, currText);
  if (change === null) {
    return {
      segment: "system",
      summary: "system prompt structure changed but text appears identical",
    };
  }
  return {
    segment: "system",
    summary: `system prompt changed at character ${change.index}: ${change.window}`,
    detail: {
      changeIndex: change.index,
      previousLength: prevText.length,
      currentLength: currText.length,
    },
  };
}

function diffTools(prev: AnyBlock[], curr: AnyBlock[]): PrefixDiff {
  if (prev.length !== curr.length) {
    return {
      segment: "tools",
      summary: `tool count changed: was ${prev.length}, now ${curr.length}`,
      detail: { previousCount: prev.length, currentCount: curr.length },
    };
  }
  const prevNames = prev.map((t) => String(t.name ?? "<unnamed>"));
  const currNames = curr.map((t) => String(t.name ?? "<unnamed>"));
  // Reorder check
  if (
    prevNames.length === currNames.length &&
    prevNames.slice().sort().join(",") === currNames.slice().sort().join(",") &&
    prevNames.join(",") !== currNames.join(",")
  ) {
    const movedIdx: number[] = [];
    for (let i = 0; i < prevNames.length; i++) {
      if (prevNames[i] !== currNames[i]) movedIdx.push(i);
    }
    return {
      segment: "tools",
      summary: `tool order changed at indices [${movedIdx.join(", ")}] (same tools, different order)`,
      detail: { changedIndices: movedIdx, previousOrder: prevNames, currentOrder: currNames },
    };
  }
  // Definition changed
  for (let i = 0; i < prev.length; i++) {
    const p = JSON.stringify(prev[i]);
    const c = JSON.stringify(curr[i]);
    if (p !== c) {
      return {
        segment: "tools",
        summary: `tool definition changed at index ${i} (name: ${currNames[i]})`,
        detail: { index: i, name: currNames[i] },
      };
    }
  }
  return { segment: "tools", summary: "tools changed but no specific delta detected" };
}

function diffMessage(
  idx: number,
  prev: MessageParam | undefined,
  curr: MessageParam | undefined,
): PrefixDiff {
  if (!prev) {
    return { segment: "messages", summary: `message at index ${idx} was inserted` };
  }
  if (!curr) {
    return { segment: "messages", summary: `message at index ${idx} was removed` };
  }
  if (prev.role !== curr.role) {
    return {
      segment: "messages",
      summary: `message at index ${idx}: role changed (${prev.role} → ${curr.role})`,
    };
  }
  const prevText = stringifyMessageContent(prev.content);
  const currText = stringifyMessageContent(curr.content);
  const change = firstCharDiff(prevText, currText);
  if (change === null) {
    return {
      segment: "messages",
      summary: `message at index ${idx} (${curr.role}) changed in structure but text matches`,
      detail: { index: idx },
    };
  }
  return {
    segment: "messages",
    summary: `message at index ${idx} (${curr.role}) changed at character ${change.index}: ${change.window}`,
    detail: {
      index: idx,
      role: curr.role,
      changeIndex: change.index,
    },
  };
}

function stringifySystem(s: SystemInput): string {
  if (typeof s === "string") return s;
  return s.map((b) => String(b.text ?? "")).join("\n");
}

function stringifyMessageContent(c: MessageParam["content"]): string {
  if (typeof c === "string") return c;
  return c
    .map((b) => {
      if (typeof b.text === "string") return b.text;
      if (typeof b.content === "string") return b.content;
      return JSON.stringify(b);
    })
    .join("\n");
}

/**
 * Find the first character position where two strings differ and return a
 * bracketed window around the change, e.g.
 *   "...the docs as of [Tuesday|Wednesday] for the team..."
 *
 * Returns null when strings are identical.
 */
function firstCharDiff(
  a: string,
  b: string,
): { index: number; window: string } | null {
  const minLen = Math.min(a.length, b.length);
  let i = 0;
  while (i < minLen && a[i] === b[i]) i++;
  if (i === minLen && a.length === b.length) return null;

  const ctx = 20;
  const start = Math.max(0, i - ctx);
  const before = a.slice(start, i);
  const aTail = a.slice(i, Math.min(a.length, i + ctx)).replace(/\n/g, "\\n");
  const bTail = b.slice(i, Math.min(b.length, i + ctx)).replace(/\n/g, "\\n");
  const prefix = start > 0 ? "..." : "";
  return {
    index: i,
    window: `${prefix}${before.replace(/\n/g, "\\n")}[${aTail}|${bTail}]...`,
  };
}
