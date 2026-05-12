/**
 * Warning emitter. Passive — never throws, never blocks a request.
 *
 * The default handler prints a single-line warning via console.warn.
 * Users supply `onWarning` to route warnings into their own logger.
 */

import type { WarningEvent } from "../types.js";

export function defaultWarningHandler(event: WarningEvent): void {
  // eslint-disable-next-line no-console
  console.warn(`[cachet] ${event.code}: ${event.message}`);
}

/**
 * Wraps the user-supplied handler so handler errors never propagate up
 * into request paths.
 */
export function safeEmit(
  handler: ((event: WarningEvent) => void) | undefined,
  event: WarningEvent,
): void {
  const fn = handler ?? defaultWarningHandler;
  try {
    fn(event);
  } catch {
    // Swallow — we will not break the user's request because their logger threw.
  }
}
