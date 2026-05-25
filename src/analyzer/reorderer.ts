/**
 * v0.3: safe canonical reordering of order-insensitive request parts.
 *
 * Anthropic's prompt cache hits only when the cacheable prefix is byte-
 * identical to what was sent on a previous call. That makes the cache very
 * fragile to incidental shuffling: a tool array passed in a different order,
 * a RAG retriever returning the same documents in a different order, etc.
 *
 * This module canonicalizes those order-insensitive parts in a predictable
 * way (deterministic across calls) so a "slightly shuffled" payload still
 * hits the cache. It is intentionally conservative:
 *
 *   - Tools are alphabetized by `name`.
 *   - Within a single message, only consecutive runs of same-type
 *     "reorderable" blocks (`document`, `image`) are sorted. Text,
 *     tool_use, tool_result, and thinking blocks are NEVER moved.
 *   - A leading run of user messages whose content is purely reorderable
 *     blocks (the classic RAG context-prefix pattern) is sorted by content
 *     fingerprint. The scan stops at the first message that breaks the
 *     pattern (assistant, mixed content, contains text, etc.).
 *
 * Safety invariants:
 *   - Never reorders any segment that already carries a `cache_control`
 *     marker. Moving the marker would silently change where the cache
 *     prefix ends. Explicit intent always wins.
 *   - Never reorders anything if the caller has set `autoReorder: false`.
 *   - Pure: never mutates the input. Returns new arrays/objects.
 *
 * The output is what actually gets sent to the API. The stability tracker
 * and auto-placer both see the canonicalized form, so per-segment
 * stability scores reflect what was actually cached.
 */

import { fingerprint } from "./fingerprint.js";

import type { ReorderDiagnostic } from "../types.js";

type AnyBlock = { [k: string]: unknown };
type SystemInput =
  | string
  | Array<{ type: "text"; text: string; [k: string]: unknown }>;
interface MessageParam {
  role: "user" | "assistant";
  content: string | Array<AnyBlock>;
}

/** Block types that can be safely reordered within a single message. */
const REORDERABLE_BLOCK_TYPES = new Set(["document", "image"]);

export interface ReorderInput {
  system?: SystemInput;
  tools?: AnyBlock[];
  messages: MessageParam[];
}

export interface ReorderOutput {
  system?: SystemInput;
  tools?: AnyBlock[];
  messages: MessageParam[];
  /**
   * One entry per reorder action actually taken. Empty array means the
   * input was already canonical (or nothing was eligible).
   */
  diagnostics: ReorderDiagnostic[];
}

/**
 * Canonicalize order-insensitive parts of the request. See module header
 * for safety invariants.
 */
export function applyAutoReorder(input: ReorderInput): ReorderOutput {
  const diagnostics: ReorderDiagnostic[] = [];

  const toolsResult = canonicalizeTools(input.tools);
  if (toolsResult.diagnostic) diagnostics.push(toolsResult.diagnostic);

  // First: per-message content-block reordering.
  const perMessageOut: MessageParam[] = [];
  for (let i = 0; i < input.messages.length; i++) {
    const m = input.messages[i]!;
    const r = canonicalizeMessageContent(m, i);
    perMessageOut.push(r.message);
    if (r.diagnostic) diagnostics.push(r.diagnostic);
  }

  // Then: leading context-prefix reordering across messages.
  const prefixResult = canonicalizeMessagePrefix(perMessageOut);
  if (prefixResult.diagnostic) diagnostics.push(prefixResult.diagnostic);

  return {
    system: input.system,
    tools: toolsResult.tools,
    messages: prefixResult.messages,
    diagnostics,
  };
}

/* -------------------------------------------------------------------------- */
/* Tools                                                                       */
/* -------------------------------------------------------------------------- */

interface ToolsResult {
  tools: AnyBlock[] | undefined;
  diagnostic?: ReorderDiagnostic;
}

/**
 * Sort tools alphabetically by `name`. No-op when:
 *   - tools is undefined/empty
 *   - any tool already has `cache_control` (moving it would shift the
 *     cache prefix end-position, defeating the user's intent)
 *   - any tool is missing a `name` field (defensive — shouldn't happen
 *     against the real SDK, but we don't want to crash on malformed input)
 *   - tools are already in canonical order (no-op signal)
 */
export function canonicalizeTools(
  tools: AnyBlock[] | undefined,
): ToolsResult {
  if (!tools || tools.length < 2) return { tools };
  if (tools.some((t) => "cache_control" in t && t.cache_control != null)) {
    return { tools };
  }
  if (tools.some((t) => typeof t.name !== "string")) {
    return { tools };
  }

  const originalIndex = new Map<AnyBlock, number>();
  tools.forEach((t, i) => originalIndex.set(t, i));
  const sorted = [...tools].sort((a, b) =>
    (a.name as string).localeCompare(b.name as string),
  );

  let moved = 0;
  for (let i = 0; i < sorted.length; i++) {
    if (originalIndex.get(sorted[i]!) !== i) moved += 1;
  }
  if (moved === 0) return { tools };

  return {
    tools: sorted,
    diagnostic: {
      segment: "tools",
      summary: `tools alphabetized by name (${moved} of ${tools.length} moved)`,
      itemsMoved: moved,
      detail: {
        order: sorted.map((t) => t.name as string),
      },
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Content blocks within a single message                                      */
/* -------------------------------------------------------------------------- */

interface MessageContentResult {
  message: MessageParam;
  diagnostic?: ReorderDiagnostic;
}

/**
 * Within a single message, sort consecutive runs of same-type reorderable
 * blocks (`document`, `image`) by content fingerprint. Leave every other
 * block in place.
 *
 * No-op when:
 *   - content is a bare string
 *   - any block in the array has `cache_control` (we never move marked blocks)
 *   - no runs of length >= 2 of reorderable types exist
 */
export function canonicalizeMessageContent(
  message: MessageParam,
  messageIndex: number,
): MessageContentResult {
  if (typeof message.content === "string") return { message };
  const blocks = message.content;
  if (blocks.length < 2) return { message };
  if (blocks.some((b) => "cache_control" in b && b.cache_control != null)) {
    return { message };
  }

  const newBlocks: AnyBlock[] = [];
  let totalMoved = 0;

  let i = 0;
  while (i < blocks.length) {
    const block = blocks[i]!;
    const type = typeof block.type === "string" ? block.type : "";
    if (!REORDERABLE_BLOCK_TYPES.has(type)) {
      newBlocks.push(block);
      i += 1;
      continue;
    }

    // Collect the maximal run of THIS type starting at i.
    let j = i;
    while (
      j < blocks.length &&
      (blocks[j] as AnyBlock).type === type
    ) {
      j += 1;
    }
    const run = blocks.slice(i, j);
    if (run.length < 2) {
      newBlocks.push(...run);
      i = j;
      continue;
    }

    const fingerprinted = run.map((b) => ({ block: b, fp: fingerprint(b) }));
    const sorted = [...fingerprinted].sort((a, b) =>
      a.fp.localeCompare(b.fp),
    );
    let movedInRun = 0;
    for (let k = 0; k < sorted.length; k++) {
      if (sorted[k]!.block !== run[k]) movedInRun += 1;
    }
    totalMoved += movedInRun;
    newBlocks.push(...sorted.map((s) => s.block));
    i = j;
  }

  if (totalMoved === 0) return { message };

  return {
    message: { ...message, content: newBlocks },
    diagnostic: {
      segment: `messages[${messageIndex}].content`,
      summary: `same-type content blocks sorted by fingerprint (${totalMoved} moved)`,
      itemsMoved: totalMoved,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Leading context prefix across messages                                      */
/* -------------------------------------------------------------------------- */

interface MessagePrefixResult {
  messages: MessageParam[];
  diagnostic?: ReorderDiagnostic;
}

/**
 * Identify the longest leading run of "context-only" user messages and sort
 * that run by content fingerprint. Conservative definition of context-only:
 *
 *   - role === "user"
 *   - content is an array (not a bare string)
 *   - every block in the array is a reorderable type (document/image)
 *   - no block carries `cache_control`
 *
 * The scan stops at the first message that breaks any condition. If the
 * prefix length is < 2 we no-op.
 */
export function canonicalizeMessagePrefix(
  messages: MessageParam[],
): MessagePrefixResult {
  if (messages.length < 2) return { messages };

  let prefixEnd = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role !== "user") break;
    if (typeof m.content === "string") break;
    if (m.content.length === 0) break;
    if (
      m.content.some(
        (b) =>
          !REORDERABLE_BLOCK_TYPES.has(
            typeof b.type === "string" ? b.type : "",
          ) ||
          ("cache_control" in b && b.cache_control != null),
      )
    ) {
      break;
    }
    prefixEnd = i + 1;
  }

  if (prefixEnd < 2) return { messages };

  const prefix = messages.slice(0, prefixEnd);
  const fingerprinted = prefix.map((m) => ({ msg: m, fp: fingerprint(m) }));
  const sorted = [...fingerprinted].sort((a, b) => a.fp.localeCompare(b.fp));

  let moved = 0;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i]!.msg !== prefix[i]) moved += 1;
  }
  if (moved === 0) return { messages };

  const out = [...sorted.map((s) => s.msg), ...messages.slice(prefixEnd)];
  return {
    messages: out,
    diagnostic: {
      segment: "messages-prefix",
      summary: `leading ${prefixEnd}-message context prefix sorted by fingerprint (${moved} moved)`,
      itemsMoved: moved,
      detail: {
        prefixLength: prefixEnd,
      },
    },
  };
}
