/**
 * v0.5: auto-managed Gemini explicit CachedContent lifecycle.
 *
 * When `autoCache: true` is set on CachedGemini, this manager observes
 * the stability of `config.systemInstruction` across generateContent
 * calls. Once an instruction has been seen unchanged for at least
 * `autoCacheMinObservations` calls in a row, the manager creates a
 * `CachedContent` for it and references it via `config.cachedContent`
 * on subsequent matching calls — removing `systemInstruction` from the
 * outgoing payload so the cached version takes its place.
 *
 * Lifecycle behavior:
 *   - One CachedContent per stable systemInstruction fingerprint.
 *   - On a fingerprint MISS (instruction changed), the previously
 *     created cache is best-effort deleted (fire-and-forget; failures
 *     are silent because Gemini may have already expired it).
 *   - TTL is set on creation; expired caches are evicted lazily on
 *     the next request that would have used them. Call `client.gc()`
 *     to force a sweep.
 *
 * What it deliberately does NOT do (yet):
 *   - Refresh TTL when a cache is about to expire. v0.6 work item.
 *   - Cache full contents arrays (multi-message prefixes). v0.6.
 *   - Survive across process restarts (no persistence). v1.0 work.
 *   - Coordinate across processes (no distributed locking). v1.0 work.
 *
 * Failure modes are deliberately silent: Gemini requires a minimum
 * content size for explicit caching (~32k tokens depending on model),
 * and the create call will reject smaller instructions. When that
 * happens we just fall back to passing systemInstruction through
 * verbatim — the implicit cache still works.
 */

import { fingerprint } from "../../analyzer/fingerprint.js";
import { safeEmit } from "../../diagnostics/warnings.js";
import type { WarningEvent } from "../../types.js";

import type { GeminiCachedContent } from "./client.js";

/** Per-fingerprint state we keep for each known stable instruction. */
interface CacheEntry {
  name: string;
  expireTimeMs: number;
  /** When (ms) we last referenced this cache — useful for LRU debugging. */
  lastUsedMs: number;
  /** Approximate token count from the fingerprint stage (chars/4). */
  approxTokens: number;
}

/** Minimal interface the manager needs from the caches.* surface. */
interface CachesAPI {
  create: (params: Record<string, unknown>) => Promise<GeminiCachedContent>;
  delete: (params: Record<string, unknown>) => Promise<unknown>;
}

export interface AutoCacheManagerOptions {
  minObservations: number;
  ttlSeconds: number;
  onWarning?: (event: WarningEvent) => void;
}

/** Result of a `maybeApply` call. */
export interface AutoCacheApplyResult {
  /** Modified config to send to the API (with cachedContent set, systemInstruction removed). */
  config: Record<string, unknown>;
  /** True if we successfully attached an explicit cache reference. */
  applied: boolean;
  /** The cache resource name if applied. */
  cacheName?: string;
}

export class GeminiAutoCacheManager {
  /** Map of instruction-fingerprint → cache entry. */
  private readonly caches = new Map<string, CacheEntry>();
  /** Map of instruction-fingerprint → consecutive observation count. */
  private readonly observations = new Map<string, number>();
  /** Last-seen fingerprint, so we know when observations should reset. */
  private lastFingerprint: string | undefined;

  constructor(private readonly opts: AutoCacheManagerOptions) {}

  /**
   * Observe a new request's systemInstruction. Returns the fingerprint
   * (used as the cache key) and the current consecutive-observation count.
   */
  observe(systemInstruction: string): { fingerprint: string; count: number } {
    const fp = fingerprint(systemInstruction);
    if (fp === this.lastFingerprint) {
      const next = (this.observations.get(fp) ?? 0) + 1;
      this.observations.set(fp, next);
      return { fingerprint: fp, count: next };
    }
    // Fingerprint changed — reset observation count for the new one,
    // and best-effort evict any cache tied to the previous fingerprint.
    this.observations.set(fp, 1);
    this.lastFingerprint = fp;
    return { fingerprint: fp, count: 1 };
  }

  /**
   * Decide whether to apply an existing or new explicit cache for this
   * request. The caller already extracted `systemInstruction` from the
   * `config` and observed it via `observe()`.
   */
  async maybeApply(
    fingerprintKey: string,
    observationCount: number,
    systemInstruction: string,
    model: string,
    config: Record<string, unknown>,
    caches: CachesAPI,
  ): Promise<AutoCacheApplyResult> {
    // Respect explicit cachedContent — never override user intent.
    if (config.cachedContent) {
      return { config, applied: false };
    }

    const now = Date.now();
    const existing = this.caches.get(fingerprintKey);

    // Try to reuse a fresh cache if we have one.
    if (existing && existing.expireTimeMs > now) {
      existing.lastUsedMs = now;
      const modified = withCacheReference(config, existing.name);
      safeEmit(this.opts.onWarning, {
        code: "gemini-cache-applied",
        message: `Auto-cache reused existing CachedContent (${existing.name}, ~${existing.approxTokens} tokens).`,
        detail: {
          name: existing.name,
          reason: "reuse",
          expiresInSeconds: Math.round((existing.expireTimeMs - now) / 1000),
        },
      });
      return { config: modified, applied: true, cacheName: existing.name };
    }

    // Existing cache expired — evict it and fall through to maybe-create.
    if (existing) {
      this.caches.delete(fingerprintKey);
      // best-effort delete; ignore failure (Gemini may have already gc'd).
      caches.delete({ name: existing.name }).catch(() => undefined);
    }

    // Have we observed this instruction enough times to qualify?
    if (observationCount < this.opts.minObservations) {
      return { config, applied: false };
    }

    // Try to create a new cache. Failures (e.g. content too small) are
    // silent — we fall through to passing systemInstruction verbatim.
    try {
      const created = await caches.create({
        model,
        config: {
          contents: [
            {
              role: "user",
              parts: [{ text: systemInstruction }],
            },
          ],
          ttl: `${this.opts.ttlSeconds}s`,
        },
      });
      if (!created.name) {
        return { config, applied: false };
      }
      const entry: CacheEntry = {
        name: created.name,
        expireTimeMs: now + this.opts.ttlSeconds * 1000,
        lastUsedMs: now,
        approxTokens: Math.ceil(systemInstruction.length / 4),
      };
      this.caches.set(fingerprintKey, entry);
      const modified = withCacheReference(config, entry.name);
      safeEmit(this.opts.onWarning, {
        code: "gemini-cache-applied",
        message: `Auto-cache created CachedContent (${entry.name}, ~${entry.approxTokens} tokens, ttl=${this.opts.ttlSeconds}s).`,
        detail: { name: entry.name, reason: "created", ttlSeconds: this.opts.ttlSeconds },
      });
      return { config: modified, applied: true, cacheName: entry.name };
    } catch (_err) {
      // Most common failure: instruction too small for explicit caching.
      // Don't surface as an error — the implicit cache still works.
      return { config, applied: false };
    }
  }

  /**
   * Sweep expired caches. Returns how many were evicted.
   * Best-effort: errors deleting individual entries are silently
   * dropped (Gemini may have already collected them).
   */
  async gc(caches: CachesAPI): Promise<number> {
    const now = Date.now();
    let evicted = 0;
    for (const [fp, entry] of this.caches) {
      if (entry.expireTimeMs <= now) {
        this.caches.delete(fp);
        try {
          await caches.delete({ name: entry.name });
        } catch {
          /* ignore — likely already expired server-side */
        }
        evicted += 1;
      }
    }
    return evicted;
  }

  /** Force-delete every known cache. Used by client.resetStats(). */
  async clear(caches: CachesAPI): Promise<void> {
    const entries = Array.from(this.caches.values());
    this.caches.clear();
    this.observations.clear();
    this.lastFingerprint = undefined;
    await Promise.all(
      entries.map((e) => caches.delete({ name: e.name }).catch(() => undefined)),
    );
  }

  /** Snapshot of current managed caches (for debugging). */
  list(): Array<{ fingerprint: string; name: string; expiresInSeconds: number; approxTokens: number }> {
    const now = Date.now();
    return Array.from(this.caches.entries()).map(([fp, e]) => ({
      fingerprint: fp,
      name: e.name,
      expiresInSeconds: Math.round((e.expireTimeMs - now) / 1000),
      approxTokens: e.approxTokens,
    }));
  }
}

function withCacheReference(
  config: Record<string, unknown>,
  cacheName: string,
): Record<string, unknown> {
  // Drop systemInstruction (it's now in the cache) and attach the
  // cache reference. We don't mutate the caller's config.
  const copy = { ...config };
  delete copy.systemInstruction;
  copy.cachedContent = cacheName;
  return copy;
}
