/**
 * v0.2: automatic placement of cache_control breakpoints.
 *
 * The auto-placer looks at the stability tracker's report and inserts
 * cache_control markers at the end of the longest segments that have been
 * stable across calls. The 4-breakpoint budget Anthropic enforces is
 * respected.
 *
 * Order of preference (each spends 1 breakpoint):
 *   1. End of `system`           — biggest single-shot win for RAG/instructions
 *   2. End of `tools`            — caches tool definitions across calls
 *   3. End of the longest stable cumulative message prefix
 *
 * The placer is a no-op when:
 *   - the user has already placed any cache_control markers themselves (we
 *     never override explicit intent),
 *   - or no segment has been observed enough times to qualify as stable.
 */

import type { StabilityTracker } from "./stability-tracker.js";

type AnyBlock = { [k: string]: unknown };
type SystemInput =
  | string
  | Array<{ type: "text"; text: string; [k: string]: unknown }>;
interface MessageParam {
  role: "user" | "assistant";
  content: string | Array<AnyBlock>;
}

const CACHE_CONTROL = { type: "ephemeral" as const };
const MAX_BREAKPOINTS = 4;

export interface AutoPlaceInput {
  system?: SystemInput;
  tools?: AnyBlock[];
  messages: MessageParam[];
  tracker: StabilityTracker;
  minObservations: number;
}

export interface AutoPlaceOutput {
  system?: SystemInput;
  tools?: AnyBlock[];
  messages: MessageParam[];
  /** Where breakpoints actually got placed (zero entries = no-op). */
  placements: Array<{ position: string; reason: string; approxTokens: number }>;
}

export function autoPlaceBreakpoints(input: AutoPlaceInput): AutoPlaceOutput {
  const placements: AutoPlaceOutput["placements"] = [];
  let system = input.system;
  let tools = input.tools;
  let messages = input.messages;

  const stable = input.tracker.stableSegments(input.minObservations);
  if (stable.length === 0) {
    return { system, tools, messages, placements };
  }

  // Index by segment name for quick lookup
  const stableSet = new Set(stable.map((s) => s.segment));
  const tokensFor = new Map(stable.map((s) => [s.segment, s.lastApproxTokens]));

  let budgetLeft = MAX_BREAKPOINTS;

  // 1. System prompt
  if (stableSet.has("system") && system !== undefined && budgetLeft > 0) {
    system = applyCacheToSystem(system);
    placements.push({
      position: "after-system",
      reason: `system prompt has been stable across calls`,
      approxTokens: tokensFor.get("system") ?? 0,
    });
    budgetLeft -= 1;
  }

  // 2. Tools
  if (stableSet.has("tools") && tools && tools.length > 0 && budgetLeft > 0) {
    tools = applyCacheToLastTool(tools);
    placements.push({
      position: "after-tools",
      reason: `tool definitions have been stable across calls`,
      approxTokens: tokensFor.get("tools") ?? 0,
    });
    budgetLeft -= 1;
  }

  // 3. Longest stable messages prefix
  if (budgetLeft > 0 && messages.length > 0) {
    let bestPrefixLen = 0;
    let bestTokens = 0;
    for (const seg of stable) {
      const m = seg.segment.match(/^messages\[0\.\.(\d+)\]$/);
      if (!m) continue;
      const prefixLen = parseInt(m[1]!, 10);
      if (prefixLen > bestPrefixLen && prefixLen <= messages.length) {
        bestPrefixLen = prefixLen;
        bestTokens = seg.lastApproxTokens;
      }
    }
    if (bestPrefixLen > 0) {
      const result = applyCacheToMessageAt(messages, bestPrefixLen - 1);
      if (result.applied) {
        messages = result.messages;
        placements.push({
          position: `after-messages[${bestPrefixLen - 1}]`,
          reason: `messages[0..${bestPrefixLen}] have been stable across calls`,
          approxTokens: bestTokens,
        });
        budgetLeft -= 1;
      }
    }
  }

  return { system, tools, messages, placements };
}

function applyCacheToSystem(system: SystemInput): SystemInput {
  if (typeof system === "string") {
    return [{ type: "text", text: system, cache_control: CACHE_CONTROL }];
  }
  if (system.length === 0) return system;
  const copy = system.map((block) => ({ ...block }));
  copy[copy.length - 1] = {
    ...copy[copy.length - 1]!,
    cache_control: CACHE_CONTROL,
  };
  return copy;
}

function applyCacheToLastTool(tools: AnyBlock[]): AnyBlock[] {
  if (tools.length === 0) return tools;
  const copy = tools.map((t) => ({ ...t }));
  copy[copy.length - 1] = {
    ...copy[copy.length - 1]!,
    cache_control: CACHE_CONTROL,
  };
  return copy;
}

function applyCacheToMessageAt(
  messages: MessageParam[],
  idx: number,
): { messages: MessageParam[]; applied: boolean } {
  if (idx < 0 || idx >= messages.length) {
    return { messages, applied: false };
  }
  const copy = messages.map((m) => ({ ...m }));
  const target = copy[idx]!;
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
  copy[idx] = target;
  return { messages: copy, applied: true };
}
