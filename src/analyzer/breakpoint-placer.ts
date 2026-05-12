/**
 * v0.1: explicit breakpoint placement helper.
 *
 * The user provides their system prompt + messages, picks a strategy, and we
 * return a copy with `cache_control: { type: "ephemeral" }` markers inserted.
 *
 * Auto-placement based on observed stability across calls is a v0.2 feature.
 */

/** What kind of system prompt the user passed. */
type SystemInput = string | Array<{ type: "text"; text: string; [k: string]: unknown }>;

/** Loose message shape — matches @anthropic-ai/sdk's MessageParam. */
interface MessageParam {
  role: "user" | "assistant";
  content:
    | string
    | Array<{ type: string; [k: string]: unknown }>;
}

export type BreakpointStrategy =
  /** Put one breakpoint at the end of the system prompt. */
  | "after-system"
  /** Put one breakpoint after the last assistant turn (caches conversation history). */
  | "after-last-assistant"
  /** Both: cache the system prompt AND the running conversation history. */
  | "system-and-history";

export interface PlaceBreakpointsInput {
  system?: SystemInput;
  messages: MessageParam[];
  strategy?: BreakpointStrategy;
}

export interface PlaceBreakpointsOutput {
  system?: SystemInput;
  messages: MessageParam[];
  /** Where breakpoints actually got placed, for debugging. */
  placements: Array<{ position: string; reason: string }>;
}

const CACHE_CONTROL = { type: "ephemeral" as const };

/**
 * Insert cache_control breakpoints into the request payload.
 *
 * Never mutates the input. Returns a shallow-copied output with the markers
 * applied to the last block of the chosen anchor.
 */
export function placeBreakpoints(
  input: PlaceBreakpointsInput,
): PlaceBreakpointsOutput {
  const strategy = input.strategy ?? "after-system";
  const placements: PlaceBreakpointsOutput["placements"] = [];

  let system: SystemInput | undefined = input.system;
  let messages: MessageParam[] = input.messages;

  if (strategy === "after-system" || strategy === "system-and-history") {
    if (system !== undefined) {
      system = applyCacheToSystem(system);
      placements.push({
        position: "after-system",
        reason: "user requested caching of the system prompt",
      });
    }
  }

  if (
    strategy === "after-last-assistant" ||
    strategy === "system-and-history"
  ) {
    const result = applyCacheToLastAssistant(messages);
    messages = result.messages;
    if (result.applied) {
      placements.push({
        position: "after-last-assistant",
        reason: "user requested caching of running conversation history",
      });
    }
  }

  return { system, messages, placements };
}

function applyCacheToSystem(system: SystemInput): SystemInput {
  if (typeof system === "string") {
    return [{ type: "text", text: system, cache_control: CACHE_CONTROL }];
  }
  // Array form — copy, then attach cache_control to the last block
  if (system.length === 0) return system;
  const copy = system.map((block) => ({ ...block }));
  copy[copy.length - 1] = {
    ...copy[copy.length - 1]!,
    cache_control: CACHE_CONTROL,
  };
  return copy;
}

function applyCacheToLastAssistant(messages: MessageParam[]): {
  messages: MessageParam[];
  applied: boolean;
} {
  // Find the last assistant message; cache there to lock in the running history.
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "assistant") {
      lastAssistantIdx = i;
      break;
    }
  }
  if (lastAssistantIdx === -1) return { messages, applied: false };

  const copy = messages.map((m) => ({ ...m }));
  const target = copy[lastAssistantIdx]!;
  const content = target.content;

  if (typeof content === "string") {
    target.content = [
      { type: "text", text: content, cache_control: CACHE_CONTROL },
    ];
  } else if (Array.isArray(content) && content.length > 0) {
    const blocks = content.map((b) => ({ ...b }));
    blocks[blocks.length - 1] = {
      ...blocks[blocks.length - 1]!,
      cache_control: CACHE_CONTROL,
    };
    target.content = blocks;
  } else {
    return { messages, applied: false };
  }

  copy[lastAssistantIdx] = target;
  return { messages: copy, applied: true };
}

/**
 * Quick scan: does this payload contain ANY cache_control markers?
 *
 * Used by the client wrapper to emit a warning when a user enables stats
 * tracking but never actually marks anything cacheable.
 */
export function hasAnyCacheControl(payload: {
  system?: SystemInput;
  messages: MessageParam[];
  tools?: Array<{ [k: string]: unknown }>;
}): boolean {
  const checkBlock = (b: { [k: string]: unknown }): boolean =>
    "cache_control" in b && b.cache_control != null;

  if (payload.system) {
    if (Array.isArray(payload.system)) {
      if (payload.system.some(checkBlock)) return true;
    }
  }

  if (payload.tools) {
    if (payload.tools.some(checkBlock)) return true;
  }

  for (const m of payload.messages) {
    if (typeof m.content !== "string") {
      if (m.content.some(checkBlock)) return true;
    }
  }

  return false;
}
