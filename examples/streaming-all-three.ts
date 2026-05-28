/**
 * Run with one of:
 *   ANTHROPIC_API_KEY=... npx tsx examples/streaming-all-three.ts anthropic
 *   OPENAI_API_KEY=...    npx tsx examples/streaming-all-three.ts openai
 *   GOOGLE_API_KEY=...    npx tsx examples/streaming-all-three.ts gemini
 *
 * Demonstrates the v0.5 streaming wrappers. The shape is identical across
 * providers: an async-iterable for chunks plus `await stream.final()` for
 * cacheInfo. Pick whichever provider you have an API key for.
 */

import { CachedAnthropic, CachedGemini, CachedOpenAI } from "../src/index.js";

const LONG_SYSTEM = `
You are a helpful assistant with deep knowledge of the fictional product
Foobar v3. Cite specific section numbers when you answer.
${"\n## Foobar feature section\nFoobar does many useful things.".repeat(80)}
`.trim();

const QUESTION = "How do I install Foobar on macOS?";

async function streamAnthropic() {
  const client = new CachedAnthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    autoCache: true,
    onWarning: (w) => console.log(`⚠️  ${w.code}: ${w.message}`),
  });
  const stream = client.messages.stream({
    model: "claude-sonnet-4-6",
    max_tokens: 256,
    system: LONG_SYSTEM,
    messages: [{ role: "user", content: QUESTION }],
  });
  process.stdout.write("A: ");
  for await (const event of stream) {
    if (
      event.type === "content_block_delta" &&
      event.delta.type === "text_delta"
    ) {
      process.stdout.write(event.delta.text);
    }
  }
  const { cacheInfo } = await stream.final();
  console.log("\n");
  console.log(
    `cache=${cacheInfo.hit ? "HIT " : "MISS"} cached=${cacheInfo.cachedTokens} saved=$${cacheInfo.dollarsSaved.toFixed(4)}`,
  );
}

async function streamOpenAI() {
  const client = new CachedOpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    autoReorder: true,
    onWarning: (w) => console.log(`⚠️  ${w.code}: ${w.message}`),
  });
  const stream = await client.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: LONG_SYSTEM },
      { role: "user", content: QUESTION },
    ],
    stream: true,
  });
  // Discriminated by stream:true — TS sees the union; cast for ergonomic iteration
  const it = stream as AsyncIterable<{
    choices?: Array<{ delta?: { content?: string | null } }>;
  }> & { final: () => Promise<{ cacheInfo: { hit: boolean; cachedTokens: number; dollarsSaved: number } }> };
  process.stdout.write("A: ");
  for await (const chunk of it) {
    const piece = chunk.choices?.[0]?.delta?.content;
    if (piece) process.stdout.write(piece);
  }
  const { cacheInfo } = await it.final();
  console.log("\n");
  console.log(
    `cache=${cacheInfo.hit ? "HIT " : "MISS"} cached=${cacheInfo.cachedTokens} saved=$${cacheInfo.dollarsSaved.toFixed(4)}`,
  );
}

async function streamGemini() {
  const client = new CachedGemini({
    apiKey: process.env.GOOGLE_API_KEY,
    onWarning: (w) => console.log(`⚠️  ${w.code}: ${w.message}`),
  });
  const stream = await client.models.generateContentStream({
    model: "gemini-2.5-flash",
    contents: [{ role: "user", parts: [{ text: QUESTION }] }],
    config: { systemInstruction: LONG_SYSTEM },
  });
  process.stdout.write("A: ");
  for await (const chunk of stream) {
    if (chunk.text) process.stdout.write(chunk.text);
  }
  const { cacheInfo } = await stream.final();
  console.log("\n");
  console.log(
    `cache=${cacheInfo.hit ? "HIT " : "MISS"} cached=${cacheInfo.cachedTokens} saved=$${cacheInfo.dollarsSaved.toFixed(4)}`,
  );
}

async function main() {
  const which = (process.argv[2] ?? "").toLowerCase();
  if (which === "anthropic") return streamAnthropic();
  if (which === "openai") return streamOpenAI();
  if (which === "gemini") return streamGemini();
  console.error(
    "Usage: tsx examples/streaming-all-three.ts <anthropic|openai|gemini>",
  );
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
