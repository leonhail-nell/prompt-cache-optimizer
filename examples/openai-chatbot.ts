/**
 * Run with:
 *   OPENAI_API_KEY=sk-... npx tsx examples/openai-chatbot.ts
 *
 * Demonstrates CachedOpenAI on a chatbot pattern. OpenAI's prompt cache
 * is AUTOMATIC for prompts >= 1024 tokens — there are no `cache_control`
 * markers to place. The wrapper just measures the hit rate, surfaces
 * dollar savings, and (with autoReorder) canonicalizes the tools array
 * so a shuffled tools list still hits the cache.
 *
 * What you should see across 5 turns:
 *   - Call 1: full price, no cache yet (cache write happens implicitly)
 *   - Calls 2-5: cache hits on the system prompt portion, dollars saved
 *   - One `auto-reorder-applied` line on calls where the tools were rotated
 */

import { CachedOpenAI } from "../src/index.js";

const longSystemPromptBase = `
You are a senior support engineer for the fictional product Foobar v3.
Below is the full Foobar v3 user manual, organized by feature area. When
answering, cite specific section numbers.

${"\n## Section about Foobar features\nFoobar does many useful things.".repeat(80)}
`.trim();

const tools = [
  {
    type: "function" as const,
    function: {
      name: "search_kb",
      description: "Search the Foobar knowledge base for an article.",
      parameters: {
        type: "object" as const,
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "lookup_account",
      description: "Look up the user's account by ID.",
      parameters: {
        type: "object" as const,
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "open_ticket",
      description: "Create a support ticket on the user's behalf.",
      parameters: {
        type: "object" as const,
        properties: { subject: { type: "string" } },
        required: ["subject"],
      },
    },
  },
];

const rotate = <T>(arr: T[], n: number): T[] =>
  arr.slice(n % arr.length).concat(arr.slice(0, n % arr.length));

async function main() {
  const client = new CachedOpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    autoReorder: true,
    diagnoseMisses: true,
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

  for (let i = 0; i < questions.length; i++) {
    const question = questions[i]!;
    const res = await client.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: longSystemPromptBase },
        { role: "user", content: question },
      ],
      tools: rotate(tools, i),
    });

    const reply = res.choices[0]?.message?.content ?? "(no text)";
    console.log(`\nQ: ${question}\nA: ${reply.slice(0, 120)}...`);
    console.log(
      `   cache=${res.cacheInfo.hit ? "HIT " : "MISS"} ` +
        `cached=${res.cacheInfo.cachedTokens} ` +
        `uncached=${res.cacheInfo.uncachedTokens} ` +
        `saved=$${res.cacheInfo.dollarsSaved.toFixed(4)}`,
    );
  }

  console.log("\n=== Per-segment stability (client.stability()) ===");
  for (const entry of client.stability().entries) {
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
