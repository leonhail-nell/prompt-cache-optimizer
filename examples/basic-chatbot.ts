/**
 * Run with:
 *   ANTHROPIC_API_KEY=sk-... npm run example
 *
 * This example simulates a chatbot that re-uses a large system prompt across
 * 5 turns. Without prompt caching, you'd pay the full input-token cost for
 * the system prompt every turn. With cachet, you pay it once and read from
 * cache on turns 2–5.
 */

import { CachedAnthropic, placeBreakpoints } from "../src/index.js";

const longSystemPrompt = `
You are a senior support engineer for the fictional product Foobar v3.
Below is the full Foobar v3 user manual, organized by feature area. When
answering, cite specific section numbers.

${"\n## Section about Foobar features\nFoobar does many useful things.".repeat(80)}
`.trim();

async function main() {
  const client = new CachedAnthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
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

  for (const question of questions) {
    const { system, messages } = placeBreakpoints({
      system: longSystemPrompt,
      messages: [{ role: "user", content: question }],
      strategy: "after-system",
    });

    const res = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 256,
      system,
      messages,
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

  console.log("\n=== Final stats ===");
  console.log(client.stats());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
