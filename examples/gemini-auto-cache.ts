/**
 * Run with:
 *   GOOGLE_API_KEY=... npx tsx examples/gemini-auto-cache.ts
 *
 * Demonstrates v0.5's auto-managed Gemini explicit caching. With
 * `autoCache: true`, the wrapper observes the systemInstruction across
 * calls and — once it's been seen unchanged for `autoCacheMinObservations`
 * calls in a row — creates a CachedContent and references it on
 * subsequent calls. Watch for the `gemini-cache-applied` warnings.
 *
 * Note: Gemini requires a minimum content size for explicit caching
 * (around 32k tokens depending on model). This example uses a large
 * systemInstruction to clear that bar. If you shrink it, you'll see
 * the manager silently fall back to passing the instruction verbatim —
 * the implicit cache still works.
 */

import { CachedGemini } from "../src/index.js";

// Pad the system instruction so it clears Gemini's explicit-cache
// minimum size (~32k tokens for many models). Each section is ~50
// tokens; 700 sections ≈ 35k tokens.
const LONG_SYSTEM_INSTRUCTION = `
You are a senior support engineer for the fictional product Foobar v3.
Below is the full Foobar v3 user manual, organized by feature area. When
answering, cite specific section numbers.

${"\n## Section about Foobar features\nFoobar does many useful things, listed in detail across multiple subsections each describing one capability.".repeat(700)}
`.trim();

async function main() {
  const client = new CachedGemini({
    apiKey: process.env.GOOGLE_API_KEY,
    autoCache: true,
    autoCacheMinObservations: 2,
    autoCacheTtl: 600,
    onWarning: (w) => console.log(`⚠️  ${w.code}: ${w.message}`),
  });

  const questions = [
    "How do I install Foobar?",
    "What's the keyboard shortcut for fullscreen?",
    "Can I export my data?",
    "Is there a mobile app?",
    "How do I cancel my subscription?",
  ];

  for (const question of questions) {
    const res = await client.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: question }] }],
      // The wrapper will see this same systemInstruction across calls,
      // create a CachedContent on the 2nd observation, and reference it
      // by name on calls 2+.
      config: { systemInstruction: LONG_SYSTEM_INSTRUCTION },
    });
    const reply = res.text ?? "(no text)";
    console.log(`\nQ: ${question}\nA: ${reply.slice(0, 100)}...`);
    console.log(
      `   cache=${res.cacheInfo.hit ? "HIT " : "MISS"} ` +
        `cached=${res.cacheInfo.cachedTokens} ` +
        `uncached=${res.cacheInfo.uncachedTokens} ` +
        `saved=$${res.cacheInfo.dollarsSaved.toFixed(4)}`,
    );
  }

  console.log("\n=== client.managedCaches() ===");
  for (const entry of client.managedCaches()) {
    console.log(
      `  ${entry.name} expiresIn=${entry.expiresInSeconds}s approxTokens=${entry.approxTokens}`,
    );
  }

  console.log("\n=== client.stats() ===");
  console.log(client.stats());

  // Be a good citizen — clean up the auto-managed caches.
  const evicted = await client.gc();
  console.log(`\ngc() evicted ${evicted} expired entries`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
