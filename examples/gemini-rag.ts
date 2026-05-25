/**
 * Run with:
 *   GOOGLE_API_KEY=... npx tsx examples/gemini-rag.ts
 *
 * Demonstrates CachedGemini in two modes:
 *
 *   1) IMPLICIT caching (Gemini 2.5+): we just ask questions in a loop
 *      with a stable system instruction. Gemini auto-caches the prefix
 *      and the wrapper measures the hits via usageMetadata.
 *
 *   2) EXPLICIT caching: we POST a CachedContent containing a long
 *      document, then ask several questions referencing it by name.
 *      Cache hits show up in cacheInfo and stats.
 *
 * Auto-managed explicit caching (where the wrapper creates CachedContent
 * objects on its own when prefixes are stable) is on the v0.5 roadmap.
 */

import { CachedGemini } from "../src/index.js";

const longSystemInstruction = `
You are a senior support engineer for the fictional product Foobar v3.
Below is the full Foobar v3 user manual, organized by feature area. When
answering, cite specific section numbers.

${"\n## Section about Foobar features\nFoobar does many useful things.".repeat(80)}
`.trim();

async function main() {
  const client = new CachedGemini({
    apiKey: process.env.GOOGLE_API_KEY,
    autoReorder: true,
    diagnoseMisses: true,
    warnIfHitRateBelow: 0.3,
    onWarning: (w) => console.log(`⚠️  ${w.code}: ${w.message}`),
  });

  console.log("\n=== Mode 1: implicit caching (Gemini 2.5 auto) ===");
  const questions = [
    "How do I install Foobar?",
    "What's the keyboard shortcut for fullscreen?",
    "Can I export my data?",
  ];

  for (const question of questions) {
    const res = await client.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: question }] }],
      config: { systemInstruction: longSystemInstruction },
    });
    const reply = res.text ?? "(no text)";
    console.log(`\nQ: ${question}\nA: ${reply.slice(0, 120)}...`);
    console.log(
      `   cache=${res.cacheInfo.hit ? "HIT " : "MISS"} ` +
        `cached=${res.cacheInfo.cachedTokens} ` +
        `uncached=${res.cacheInfo.uncachedTokens} ` +
        `saved=$${res.cacheInfo.dollarsSaved.toFixed(4)}`,
    );
  }

  console.log("\n=== Mode 2: explicit CachedContent ===");
  // Create a cache holding the system instruction so we can reference
  // it by name on subsequent calls. The wrapper exposes caches.* as a
  // pass-through to the underlying SDK.
  const cache = await client.caches.create({
    model: "gemini-2.5-flash",
    config: {
      contents: [{ role: "user", parts: [{ text: longSystemInstruction }] }],
      ttl: "300s",
    },
  });

  for (const question of questions.slice(0, 2)) {
    const res = await client.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: question }] }],
      config: { cachedContent: cache.name },
    });
    console.log(
      `\nQ: ${question}\n   cache=${res.cacheInfo.hit ? "HIT " : "MISS"} ` +
        `cached=${res.cacheInfo.cachedTokens} ` +
        `saved=$${res.cacheInfo.dollarsSaved.toFixed(4)}`,
    );
  }

  // Be a good citizen — delete the explicit cache when done.
  if (cache.name) {
    await client.caches.delete({ name: cache.name });
  }

  console.log("\n=== Per-segment stability ===");
  for (const entry of client.stability().entries) {
    console.log(
      `  ${entry.segment.padEnd(20)} score=${entry.stabilityScore.toFixed(2)} ` +
        `observed=${entry.callsObserved} approxTokens=${entry.approxTokens}`,
    );
  }

  console.log("\n=== Final aggregate stats ===");
  console.log(client.stats());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
