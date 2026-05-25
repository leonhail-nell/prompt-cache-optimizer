/**
 * Run with:
 *   ANTHROPIC_API_KEY=sk-... npm run example
 *
 * This example simulates a chatbot that re-uses a large system prompt across
 * 5 turns. Without prompt caching, you'd pay the full input-token cost for
 * the system prompt every turn. With prompt-cache-optimizer v0.2 you set
 * `autoCache: true` and the wrapper handles cache_control placement for you:
 *
 *   - Call 1: nothing cached yet → full price (also a cache write)
 *   - Call 2: system prompt seen unchanged → wrapper marks it cacheable
 *   - Calls 3–5: cache hits, you pay ~10% of input price for the cached portion
 *
 * After the main loop the example deliberately modifies the system prompt by
 * one character to demonstrate the v0.2 cache-miss diagnostic — the warning
 * will tell you exactly which character changed and roughly where.
 *
 * The example ALSO passes the same set of tool definitions in a different
 * order on each turn to demonstrate v0.3's `autoReorder`. Without
 * autoReorder, every shuffled tools array silently breaks the cache prefix.
 * With it on, the wrapper alphabetizes the tools before sending — so the
 * tools-portion of the cache still matches across calls. Look for the
 * `auto-reorder-applied` warning in the output.
 */

import { CachedAnthropic, placeBreakpoints } from "../src/index.js";

const longSystemPromptBase = `
You are a senior support engineer for the fictional product Foobar v3.
Below is the full Foobar v3 user manual, organized by feature area. When
answering, cite specific section numbers.

${"\n## Section about Foobar features\nFoobar does many useful things.".repeat(80)}
`.trim();

async function main() {
  const client = new CachedAnthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    // v0.2: let the wrapper place cache_control breakpoints for you.
    autoCache: true,
    // v0.2: explain WHY when caching breaks (instead of just "the prefix changed").
    diagnoseMisses: true,
    // v0.3: canonicalize order-insensitive parts of the request so a
    // shuffled tools array (or RAG document set) still hits the cache.
    autoReorder: true,
    warnIfHitRateBelow: 0.5,
    onWarning: (w) => console.log(`⚠️  ${w.code}: ${w.message}`),
  });

  const questions = [
    "How do I install Foobar?",
    "What's the keyboard shortcut for fullscreen?",
    "Can I export my data?",
    "Is there a mobile app?",
    "How do I cancel my subscription?",
  ];

  // Three tool definitions we'll shuffle each turn. The model never calls
  // them — they're there to demonstrate the v0.3 reorder behavior without
  // requiring tool_use round-trips.
  const tools = [
    {
      name: "search_kb",
      description: "Search the Foobar knowledge base for an article.",
      input_schema: {
        type: "object" as const,
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
    {
      name: "lookup_account",
      description: "Look up the user's account by ID.",
      input_schema: {
        type: "object" as const,
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    },
    {
      name: "open_ticket",
      description: "Create a support ticket on the user's behalf.",
      input_schema: {
        type: "object" as const,
        properties: { subject: { type: "string" } },
        required: ["subject"],
      },
    },
  ];

  // Simple deterministic shuffle: rotate by `i` so each call sends a
  // different order. autoReorder canonicalizes it back to alphabetical
  // before the request goes out.
  const rotate = <T>(arr: T[], n: number): T[] =>
    arr.slice(n % arr.length).concat(arr.slice(0, n % arr.length));

  for (let i = 0; i < questions.length; i++) {
    const question = questions[i]!;
    // No placeBreakpoints() needed — autoCache handles it once the system
    // prompt has been seen twice.
    const res = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 256,
      system: longSystemPromptBase,
      tools: rotate(tools, i),
      messages: [{ role: "user", content: question }],
    });

    const firstBlock = res.content[0];
    const reply =
      firstBlock && firstBlock.type === "text" ? firstBlock.text : "(no text)";
    console.log(`\nQ: ${question}\nA: ${reply.slice(0, 120)}...`);
    console.log(
      `   cache=${res.cacheInfo.hit ? "HIT " : "MISS"} ` +
        `cached=${res.cacheInfo.cachedTokens} ` +
        `uncached=${res.cacheInfo.uncachedTokens} ` +
        `saved=$${res.cacheInfo.dollarsSaved.toFixed(4)}`,
    );
  }

  // v0.2 demo: force a cache-miss to show what the diagnostic looks like.
  // We deliberately bypass auto-placement here by calling placeBreakpoints
  // ourselves with a DRIFTED system prompt. The cache for the V1 prompt is
  // still warm from the loop above, so this call writes the V2 prompt
  // without reading anything — exactly the silent-failure mode the
  // diagnostic was built to surface.
  console.log("\n=== Demo: triggering a cache-miss diagnostic ===");
  const driftedSystemPrompt = longSystemPromptBase.replace(
    "senior support engineer",
    "principal support engineer",
  );
  const drifted = placeBreakpoints({
    system: driftedSystemPrompt,
    messages: [{ role: "user", content: "Quick smoke test, hello." }],
    strategy: "after-system",
  });
  await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 64,
    system: drifted.system,
    messages: drifted.messages,
  });

  console.log("\n=== Per-segment stability (client.stability()) ===");
  const stability = client.stability();
  for (const entry of stability.entries) {
    console.log(
      `  ${entry.segment.padEnd(20)} score=${entry.stabilityScore.toFixed(2)} ` +
        `observed=${entry.callsObserved} approxTokens=${entry.approxTokens}`,
    );
  }

  console.log("\n=== Final aggregate stats (client.stats()) ===");
  console.log(client.stats());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
