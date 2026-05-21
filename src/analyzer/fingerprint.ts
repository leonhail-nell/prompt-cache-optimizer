/**
 * v0.2: deterministic fingerprints of request segments.
 *
 * We hash a canonical JSON form of each segment so we can tell whether the
 * exact same bytes have been sent before. Anthropic's cache only hits when
 * the cacheable prefix is byte-identical, so byte-equality is the right
 * notion of "stable" to track.
 *
 * Canonical-form rules:
 *   - Objects are serialized with sorted keys (so insertion order doesn't
 *     accidentally invalidate the hash).
 *   - Arrays are NOT sorted — order matters to Anthropic, so it must matter
 *     to us too.
 *   - `cache_control` fields are stripped before hashing: whether a block is
 *     marked cacheable should not change its identity (otherwise enabling
 *     auto-placement would force a one-time miss for "the prefix changed").
 */

import { createHash } from "node:crypto";

type AnyBlock = { [k: string]: unknown };
type SystemInput =
  | string
  | Array<{ type: "text"; text: string; [k: string]: unknown }>;
interface MessageParam {
  role: "user" | "assistant";
  content: string | Array<AnyBlock>;
}

/**
 * Snapshot of every segment we track for a single request. Stored on the
 * stability tracker for diffing later.
 */
export interface RequestSnapshot {
  system?: { fingerprint: string; approxTokens: number; raw: SystemInput };
  tools?: { fingerprint: string; approxTokens: number; raw: AnyBlock[] };
  /**
   * One entry per cumulative message prefix. messagePrefixes[N] is the
   * snapshot for messages[0..N+1] (i.e. the first N+1 messages).
   */
  messagePrefixes: Array<{
    fingerprint: string;
    approxTokens: number;
    upToIndex: number;
    raw: MessageParam[];
  }>;
}

/** Compute a SHA-256 hex digest of any JSON-serializable value. */
export function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

/**
 * Rough token estimate: 4 chars per token. We only need this for ordering
 * candidate breakpoints by "biggest stable prefix wins" — not for billing.
 */
export function approxTokenCount(value: unknown): number {
  return Math.ceil(canonicalize(value).length / 4);
}

/** Build a RequestSnapshot from the raw payload the user passed. */
export function snapshotRequest(payload: {
  system?: SystemInput;
  tools?: AnyBlock[];
  messages: MessageParam[];
}): RequestSnapshot {
  const out: RequestSnapshot = { messagePrefixes: [] };

  if (payload.system !== undefined) {
    const stripped = stripCacheControl(payload.system);
    out.system = {
      fingerprint: fingerprint(stripped),
      approxTokens: approxTokenCount(stripped),
      raw: payload.system,
    };
  }

  if (payload.tools && payload.tools.length > 0) {
    const stripped = payload.tools.map((t) => stripCacheControl(t) as AnyBlock);
    out.tools = {
      fingerprint: fingerprint(stripped),
      approxTokens: approxTokenCount(stripped),
      raw: payload.tools,
    };
  }

  // Cumulative message prefixes — every length from 1 to messages.length.
  const stripped = payload.messages.map(stripCacheControl) as MessageParam[];
  for (let i = 0; i < stripped.length; i++) {
    const prefix = stripped.slice(0, i + 1);
    out.messagePrefixes.push({
      fingerprint: fingerprint(prefix),
      approxTokens: approxTokenCount(prefix),
      upToIndex: i,
      raw: payload.messages.slice(0, i + 1),
    });
  }

  return out;
}

/**
 * Serialize a value deterministically: object keys sorted, arrays in their
 * original order, primitives as JSON.
 */
function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value);
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalize).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    "{" +
    keys
      .map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k]))
      .join(",") +
    "}"
  );
}

/**
 * Return a deep copy of `value` with every `cache_control` field removed.
 * Used so fingerprints don't shift when the user (or auto-placement) toggles
 * cache markers on or off.
 */
function stripCacheControl<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((v) => stripCacheControl(v)) as unknown as T;
  }
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj)) {
    if (k === "cache_control") continue;
    out[k] = stripCacheControl(obj[k]);
  }
  return out as unknown as T;
}
