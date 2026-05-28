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
 *
 * Added in v0.3:
 *   - applyAutoReorder (functional canonicalization)
 *   - canonicalizeTools / canonicalizeMessageContent / canonicalizeMessagePrefix
 *   - ReorderDiagnostic type
 *
 * Added in v0.4:
 *   - CachedOpenAI (wraps `openai`)
 *   - CachedGemini (wraps `@google/genai`)
 *   - OpenAI + Gemini pricing tables, usage extractors, option types
 *   - 'prompt-too-small-for-cache' and 'gemini-cache-applied' warning codes
 *
 * Added in v0.5:
 *   - CachedStream (shared streaming wrapper class)
 *   - messages.stream() on CachedAnthropic
 *   - stream:true support on CachedOpenAI.chat.completions.create
 *   - models.generateContentStream() on CachedGemini
 *   - autoCache + autoCacheMinObservations + autoCacheTtl on CachedGemini
 *     for auto-managed explicit CachedContent lifecycle
 *   - client.gc() and client.managedCaches() on CachedGemini
 *   - GeminiAutoCacheManager exported for advanced use
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

export {
  applyAutoReorder,
  canonicalizeTools,
  canonicalizeMessageContent,
  canonicalizeMessagePrefix,
} from "./analyzer/reorderer.js";
export type {
  ReorderInput,
  ReorderOutput,
} from "./analyzer/reorderer.js";

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

/* -------------------------------------------------------------------------- */
/* v0.5: shared streaming                                                      */
/* -------------------------------------------------------------------------- */

export { CachedStream } from "./core/cached-stream.js";
export type {
  CachedStreamFinal,
  CachedStreamHooks,
} from "./core/cached-stream.js";

/* -------------------------------------------------------------------------- */
/* v0.4: OpenAI                                                                */
/* -------------------------------------------------------------------------- */

export { CachedOpenAI } from "./providers/openai/client.js";
export type {
  CachedChatCompletion,
  OpenAIChatCompletion,
  OpenAIChatCompletionChunk,
  CachedOpenAIChatStream,
} from "./providers/openai/client.js";
export {
  lookupOpenAIPricing,
  KNOWN_OPENAI_MODELS,
} from "./providers/openai/pricing.js";
export {
  computeOpenAICacheInfo,
} from "./providers/openai/usage.js";
export type { OpenAIUsage } from "./providers/openai/usage.js";
export type { CachedOpenAIOptions } from "./providers/openai/types.js";
export { OPENAI_CACHE_MIN_TOKENS } from "./providers/openai/types.js";

/* -------------------------------------------------------------------------- */
/* v0.4: Gemini                                                                */
/* -------------------------------------------------------------------------- */

export { CachedGemini } from "./providers/gemini/client.js";
export type {
  CachedGeminiResponse,
  CachedGeminiStream,
  GeminiResponse,
  GeminiCachedContent,
} from "./providers/gemini/client.js";
export { GeminiAutoCacheManager } from "./providers/gemini/auto-cache-manager.js";
export type {
  AutoCacheManagerOptions,
  AutoCacheApplyResult,
} from "./providers/gemini/auto-cache-manager.js";
export {
  lookupGeminiPricing,
  KNOWN_GEMINI_MODELS,
} from "./providers/gemini/pricing.js";
export {
  computeGeminiCacheInfo,
} from "./providers/gemini/usage.js";
export type { GeminiUsageMetadata } from "./providers/gemini/usage.js";
export type { CachedGeminiOptions } from "./providers/gemini/types.js";

export type {
  AnthropicUsage,
  CacheInfo,
  CacheStats,
  CachedAnthropicOptions,
  ModelId,
  ModelPricing,
  PrefixDiff,
  ReorderDiagnostic,
  StabilityEntry,
  StabilityReport,
  WarningEvent,
} from "./types.js";
