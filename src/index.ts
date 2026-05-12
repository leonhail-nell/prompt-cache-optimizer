/**
 * Public surface for cachet v0.1.
 *
 * Stable in v0.1:
 *   - CachedAnthropic class
 *   - placeBreakpoints() helper
 *   - All public types
 *
 * Marked unstable for v0.1 (signature may change in v0.2):
 *   - hasAnyCacheControl
 *   - StatsAggregator (exposed for advanced users)
 */

export { CachedAnthropic } from "./client.js";
export type { CachedMessage } from "./client.js";

export {
  placeBreakpoints,
  hasAnyCacheControl,
} from "./analyzer/breakpoint-placer.js";
export type {
  BreakpointStrategy,
  PlaceBreakpointsInput,
  PlaceBreakpointsOutput,
} from "./analyzer/breakpoint-placer.js";

export { computeCacheInfo } from "./tracking/hit-rate.js";
export { StatsAggregator } from "./tracking/stats.js";

export { lookupPricing, KNOWN_MODELS } from "./pricing/models.js";

export type {
  AnthropicUsage,
  CacheInfo,
  CacheStats,
  CachedAnthropicOptions,
  ModelId,
  ModelPricing,
  WarningEvent,
} from "./types.js";
