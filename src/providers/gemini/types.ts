/**
 * Options for the CachedGemini wrapper.
 *
 * Mirrors the v0.1-0.3 CachedAnthropicOptions surface where the
 * semantics carry over.
 */

import type { ModelPricing, WarningEvent } from "../../types.js";

export interface CachedGeminiOptions {
  apiKey?: string;
  /** Use Vertex AI auth flow instead of API key. Passed through to SDK. */
  vertexai?: boolean;
  /** Vertex project id. Required when vertexai=true. */
  project?: string;
  /** Vertex location. Required when vertexai=true. */
  location?: string;
  /** API version override (e.g. "v1beta"). Passed through to SDK. */
  apiVersion?: string;
  /**
   * Emit a `low-hit-rate` warning when the rolling hit rate drops below
   * this value. Set to 0 to disable. Default 0.
   */
  warnIfHitRateBelow?: number;
  /** Rolling window size. Default 20. */
  hitRateWindow?: number;
  /** Override per-model pricing. */
  pricingOverride?: Partial<Record<string, ModelPricing>>;
  /** Receive warning events. Default: emits to console.warn. */
  onWarning?: (event: WarningEvent) => void;
  /** Pass through additional options to the underlying GoogleGenAI client. */
  geminiClientOptions?: Record<string, unknown>;
  /**
   * v0.3-style auto-reorder. For Gemini we sort the `tools` array entries
   * (each entry's `functionDeclarations[]` is sorted by name) so a
   * shuffled tools list still hits the cache. Default false (opt-in).
   */
  autoReorder?: boolean;
  /**
   * v0.2-style cache-miss diagnostic: when the cache misses on a call
   * that had cache activity earlier in the session, compute a
   * human-readable diff of what changed. Default false (opt-in).
   */
  diagnoseMisses?: boolean;
}
