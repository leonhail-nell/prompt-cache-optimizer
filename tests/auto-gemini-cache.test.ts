import { describe, expect, it, vi } from "vitest";

import { CachedGemini } from "../src/providers/gemini/client.js";
import type { WarningEvent } from "../src/types.js";

const STABLE_INSTRUCTION =
  "You are a helpful assistant. " + "Detail.".repeat(2000);

/**
 * Stub a CachedGemini that records caches.create and caches.delete calls,
 * and lets us script generateContent responses.
 */
function withAutoCacheGemini(opts?: {
  /** Override caches.create return name (e.g. simulate failure with throw). */
  createImpl?: (params: Record<string, unknown>) => Promise<{ name?: string }>;
  /** What usageMetadata to attach to each response (defaults: zero cached). */
  usage?: { promptTokenCount?: number; cachedContentTokenCount?: number; candidatesTokenCount?: number };
  /** Auto-cache options. */
  minObservations?: number;
  ttl?: number;
}) {
  const warnings: WarningEvent[] = [];
  const calls: {
    generateContent: Array<Record<string, unknown>>;
    cachesCreate: Array<Record<string, unknown>>;
    cachesDelete: Array<Record<string, unknown>>;
  } = {
    generateContent: [],
    cachesCreate: [],
    cachesDelete: [],
  };
  let cacheCounter = 0;
  const createImpl =
    opts?.createImpl ??
    (async () => ({ name: `cachedContents/auto-${++cacheCounter}` }));

  const client = new CachedGemini({
    apiKey: "test-key",
    autoCache: true,
    autoCacheMinObservations: opts?.minObservations ?? 2,
    autoCacheTtl: opts?.ttl ?? 300,
    onWarning: (w) => warnings.push(w),
  });
  client.raw = {
    models: {
      generateContent: vi.fn(async (params: Record<string, unknown>) => {
        calls.generateContent.push(params);
        return {
          text: "ok",
          usageMetadata: opts?.usage ?? {
            promptTokenCount: 100,
            candidatesTokenCount: 10,
          },
        };
      }),
      generateContentStream: async () => {
        async function* empty() {}
        return empty();
      },
    },
    caches: {
      create: vi.fn(async (params: Record<string, unknown>) => {
        calls.cachesCreate.push(params);
        return createImpl(params);
      }),
      get: async () => ({ name: "cachedContents/x" }),
      delete: vi.fn(async (params: Record<string, unknown>) => {
        calls.cachesDelete.push(params);
        return {};
      }),
      list: async () => [],
      update: async () => ({ name: "cachedContents/x" }),
    },
  };
  return { client, warnings, calls };
}

describe("CachedGemini autoCache (explicit CachedContent management)", () => {
  it("creates a CachedContent on the Nth observation and references it after", async () => {
    const { client, calls, warnings } = withAutoCacheGemini({
      minObservations: 2,
    });

    // Call 1 — first observation, no cache yet
    await client.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: "q1" }] }],
      config: { systemInstruction: STABLE_INSTRUCTION },
    });
    expect(calls.cachesCreate).toHaveLength(0);
    // SystemInstruction was passed through unmodified
    const sent1 = calls.generateContent[0]!;
    expect((sent1.config as Record<string, unknown>).systemInstruction).toBe(
      STABLE_INSTRUCTION,
    );

    // Call 2 — second observation, manager creates the cache
    await client.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: "q2" }] }],
      config: { systemInstruction: STABLE_INSTRUCTION },
    });
    expect(calls.cachesCreate).toHaveLength(1);
    // SystemInstruction REMOVED, cachedContent attached
    const sent2 = calls.generateContent[1]!;
    const config2 = sent2.config as Record<string, unknown>;
    expect(config2.systemInstruction).toBeUndefined();
    expect(typeof config2.cachedContent).toBe("string");
    expect((config2.cachedContent as string)).toMatch(/^cachedContents\//);

    // Call 3 — reuse the existing cache (no new create)
    await client.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: "q3" }] }],
      config: { systemInstruction: STABLE_INSTRUCTION },
    });
    expect(calls.cachesCreate).toHaveLength(1);

    // Warnings: at least one gemini-cache-applied (created), one or more (reused)
    const events = warnings.filter((w) => w.code === "gemini-cache-applied");
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events[0]!.detail?.reason).toBe("created");
  });

  it("respects explicit config.cachedContent — does not override", async () => {
    const { client, calls } = withAutoCacheGemini({ minObservations: 1 });
    await client.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: "q" }] }],
      config: {
        systemInstruction: STABLE_INSTRUCTION,
        cachedContent: "cachedContents/user-supplied",
      },
    });
    expect(calls.cachesCreate).toHaveLength(0);
    const sent = calls.generateContent[0]!;
    expect((sent.config as Record<string, unknown>).cachedContent).toBe(
      "cachedContents/user-supplied",
    );
  });

  it("silently falls back when caches.create rejects (e.g. content too small)", async () => {
    const { client, calls } = withAutoCacheGemini({
      minObservations: 1,
      createImpl: async () => {
        throw new Error("content too small for caching");
      },
    });
    await client.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: "q" }] }],
      config: { systemInstruction: "tiny" },
    });
    expect(calls.cachesCreate).toHaveLength(1);
    // SystemInstruction stays in the outgoing config because create failed
    const sent = calls.generateContent[0]!;
    expect((sent.config as Record<string, unknown>).systemInstruction).toBe(
      "tiny",
    );
  });

  it("client.managedCaches() lists created entries", async () => {
    const { client } = withAutoCacheGemini({ minObservations: 1 });
    await client.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: "q1" }] }],
      config: { systemInstruction: STABLE_INSTRUCTION },
    });
    const managed = client.managedCaches();
    expect(managed).toHaveLength(1);
    expect(managed[0]!.name).toMatch(/^cachedContents\//);
    expect(managed[0]!.approxTokens).toBeGreaterThan(0);
    expect(managed[0]!.expiresInSeconds).toBeGreaterThan(0);
  });

  it("client.gc() is a no-op when nothing has expired", async () => {
    const { client } = withAutoCacheGemini({ minObservations: 1 });
    await client.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: "q1" }] }],
      config: { systemInstruction: STABLE_INSTRUCTION },
    });
    const evicted = await client.gc();
    expect(evicted).toBe(0);
  });

  it("autoCache off → no manager activity at all", async () => {
    const client = new CachedGemini({ apiKey: "test-key" });
    const calls: Array<Record<string, unknown>> = [];
    client.raw = {
      models: {
        generateContent: vi.fn(async (params: Record<string, unknown>) => {
          calls.push(params);
          return { text: "ok", usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 5 } };
        }),
        generateContentStream: async () => {
          async function* empty() {}
          return empty();
        },
      },
      caches: {
        create: vi.fn(async () => ({ name: "should-never-be-called" })),
        get: async () => ({ name: "x" }),
        delete: async () => ({}),
        list: async () => [],
        update: async () => ({ name: "x" }),
      },
    };
    for (let i = 0; i < 3; i++) {
      await client.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [{ role: "user", parts: [{ text: `q${i}` }] }],
        config: { systemInstruction: STABLE_INSTRUCTION },
      });
    }
    // Should NOT have created any caches
    expect(client.managedCaches()).toHaveLength(0);
  });

  it("resets observation counter when systemInstruction changes", async () => {
    const { client, calls } = withAutoCacheGemini({ minObservations: 2 });

    // 1st: instruction A
    await client.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: "q" }] }],
      config: { systemInstruction: STABLE_INSTRUCTION },
    });
    // 2nd: instruction B (different) — observation count resets
    await client.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: "q" }] }],
      config: { systemInstruction: STABLE_INSTRUCTION + "DIFFERENT" },
    });
    // Should NOT have created a cache yet (B has only 1 obs)
    expect(calls.cachesCreate).toHaveLength(0);
    // 3rd: instruction B again — now 2 obs, create
    await client.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: "q" }] }],
      config: { systemInstruction: STABLE_INSTRUCTION + "DIFFERENT" },
    });
    expect(calls.cachesCreate).toHaveLength(1);
  });
});
