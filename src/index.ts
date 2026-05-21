/**
 * Public surface for prompt-cache-optimizer.
 *
 * Stable since v0.1:
 *   - CachedAnthropic class (now with autoCache + diagnoseMisses + stability())
 *   - placeBreakpoints() helper
 *   - All public types
 *
 * Added in v0.2:
 *   - autoPlaceBreakpoints (functional auto-placement)
 *   - StabilityTracker (advanced, exposed for non-client integrations)
 *   - diffSnapshots (diagnostic, exposed for advanced users)
 *   - snapshotRequest / fingerprint / approxTokenCount utilities
 *   - PrefixDiff, StabilityReport, StabilityEntry types
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

export { autoPlaceBreakpoints } from "./analyzer/auto-placer.js";
export type {
  AutoPlaceInput,
  AutoPlaceOutput,
} from "./analyzer/auto-placer.js";

export { StabilityTracker } from "./analyzer/stability-tracker.js";

export {
  fingerprint,
  approxTokenCount,
  snapshotRequest,
} from "./analyzer/fingerprint.js";
export type { RequestSnapshot } from "./analyzer/fingerprint.js";

export { diffSnapshots } from "./diagnostics/diff.js";

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
  PrefixDiff,
  StabilityEntry,
  StabilityReport,
  WarningEvent,
} from "./types.js";
