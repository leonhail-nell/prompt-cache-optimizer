/**
 * Re-export point for savings-related utilities.
 *
 * In v0.1 the math lives in hit-rate.ts (since per-call savings is computed
 * at the same time as the rest of CacheInfo). This module exists so the
 * public surface and folder structure stay clean as we add v0.2 features
 * like break-even analysis for cache TTL extension.
 */

export { computeCacheInfo } from "./hit-rate.js";
