# Launch & growth plan — prompt-cache-optimizer

A sequenced playbook for getting people to actually use your package. Work through it in order — items at the top have the highest leverage.

> This file is for your reference. You can keep it in the repo (totally fine, lots of OSS does) or gitignore it if you'd rather keep your launch tactics private.

---

## Phase 0 — Pre-launch checklist (1 hour)

Do all of these BEFORE posting anywhere. The first 100 visitors are the most important; landing them on a half-baked README wastes them.

- [ ] Visit https://www.npmjs.com/package/prompt-cache-optimizer and confirm the README renders correctly (badges, code blocks, links)
- [ ] Test install from a clean folder: `cd /tmp && mkdir test && cd test && npm init -y && npm install prompt-cache-optimizer @anthropic-ai/sdk && node -e "console.log(require('prompt-cache-optimizer'))"`
- [ ] Run `examples/basic-chatbot.ts` with a real API key once — confirm `cacheInfo` shows up
- [ ] Take a clean terminal screenshot of `client.stats()` output with real numbers (e.g., `dollarsSaved: 3.72` over ~100 calls). This is your single most important marketing asset.
- [ ] Add that screenshot to the top of the README, above the badges, with a caption like "Real output after 142 calls in production."
- [ ] Add a "Star this repo if it saves you money" line at the bottom of the README. Awkward but works.
- [ ] Verify GitHub repo has: description, topics (claude, anthropic, prompt-caching, llm, typescript), website link to npm page
- [ ] Pin the repo on your GitHub profile

---

## Phase 1 — Day 1 launch (the Hacker News post)

This is the single biggest lever. Done right, 200–2000 downloads in week 1. Done poorly, 10.

### Timing
- **Best windows:** Tuesday, Wednesday, or Thursday, between 8–10 AM US Pacific time
- **Avoid:** Mondays (everyone catching up), Fridays (people checking out), weekends (low traffic)
- **Don't post the same day** Anthropic ships a major announcement — your post will get buried

### Title (pick one, iterate)

Strong titles lead with concrete value, not feature description:

- `Show HN: I cut my Claude API bill 70% with a small wrapper for prompt caching`
- `Show HN: Most Anthropic prompt caching setups silently fail — here's how to catch it`
- `Show HN: Prompt-cache-optimizer – measure real Claude cache hit rate, save dollars`

Weak titles to avoid:
- ❌ `Show HN: prompt-cache-optimizer` (no value prop)
- ❌ `Show HN: A TypeScript library for Anthropic SDK` (too generic)
- ❌ Anything starting with "I built" — sounds like a vanity project

### URL field
Use the GitHub repo URL, not the npm URL. HN readers prefer reading the README on GitHub before installing.

`https://github.com/leonhail-nell/prompt-cache-optimizer`

### First comment (post this YOURSELF immediately after submitting)

This is where you provide context. HN posts without a first comment from the author get ignored. Template:

> Hey HN — author here.
>
> I built this after realizing my Anthropic bill was 3x what it should've been. Prompt caching is supposed to give a 90% discount on the cached portion of your prompt, but the `cache_control` API is finicky: a misplaced breakpoint silently degrades to a full-price call, and the only way to verify it's working is to manually parse `cache_read_input_tokens` from every response.
>
> The wrapper attaches `cacheInfo` to every response (hit/miss, tokens cached, dollars saved) and warns you when the cache silently breaks ("write without read" = your prefix changed call-over-call).
>
> v0.1 is intentionally small — just measurement and an explicit `placeBreakpoints()` helper. v0.2 will auto-place breakpoints based on observed prompt stability.
>
> What's NOT here yet: OpenAI/Gemini support, persistent stats storage, streaming. Happy to chat about priorities — comment what would unlock your use case.

### Be online for the first hour

The first hour determines whether you make the front page. Refresh, respond to every comment, be helpful even to critics. Don't argue — acknowledge and move on. Predictable questions to prepare for:

- **"How is this different from LiteLLM/Helicone/Langfuse?"** — Those are routers/observability platforms requiring accounts and infra. This is a 9KB drop-in for the Anthropic SDK, zero dependencies, runs locally.
- **"Why not just use the SDK directly?"** — You can, but you'll spend hours debugging silent cache misses. This package surfaces them automatically.
- **"Doesn't Anthropic publish their pricing — why do you bake it in?"** — Yes, but to compute per-call savings on every response, the math has to be local. There's an override option for when pricing drifts.
- **"What about 1-hour TTL?"** — Roadmap item. v0.1 assumes 5-min default.

---

## Phase 2 — Day 1 expansion (Reddit)

Post AFTER the HN submission so the timing aligns. Use a different angle for each subreddit — copy-pasted posts get downvoted as spam.

### r/ClaudeAI

**Title:** `Built a small TypeScript wrapper that tracks real Claude cache hit rate`

**Body:**

> I've been running Claude in production for a few months and realized I had no idea whether my prompt caching was actually working. Anthropic's API returns `cache_read_input_tokens` in the usage object but you have to parse it yourself every call.
>
> Made a wrapper that just attaches a `.cacheInfo` field to every response and tracks aggregate stats. Also catches the silent failure mode where your cacheable prefix changes call-over-call.
>
> `npm install prompt-cache-optimizer`
>
> v0.1 needs you to manually mark a cache breakpoint via `placeBreakpoints()`. Auto-placement is v0.2.
>
> GitHub: https://github.com/leonhail-nell/prompt-cache-optimizer
>
> Curious whether others have hit this and what would actually be useful.

### r/LocalLLaMA

**Title:** `If you're mixing local models with the Claude API, here's a small thing to track Claude's caching`

**Body:**

> Most of you run local models, but a lot of pipelines I see use Claude for the final synthesis step. If you do, prompt caching can cut that API cost by ~90% on the stable prefix — but it silently breaks in ways that are hard to catch.
>
> Built a TypeScript wrapper that measures real cache hit rate from the response usage object: https://github.com/leonhail-nell/prompt-cache-optimizer
>
> Zero runtime deps, 9KB. Not relevant if you're 100% local, but if Claude is in your pipeline somewhere this might save you actual money.

### r/AI_Agents

**Title:** `Agents are expensive — prompt caching is the easy 70% cost win, here's how to verify it's working`

**Body:**

> Agents that loop with tool use absolutely thrash your Anthropic bill because the system prompt + tool definitions get re-sent every turn. Prompt caching is built for exactly this: cache the stable prefix, pay 10% on rereads.
>
> But: it silently fails if anything in your prefix shifts between calls (tools reordered, retrieved docs in a different order, etc.). I built a wrapper that catches this and tells you exactly when it happens:
>
> https://github.com/leonhail-nell/prompt-cache-optimizer
>
> v0.1 is just measurement + an explicit `placeBreakpoints()` helper. v0.2 (auto-placement) is what I think will be most useful for agents specifically.

### r/typescript (optional, for broader reach)

**Title:** `Built a TS wrapper for Anthropic SDK that catches a common silent failure mode`

Short body explaining the problem, link to repo. r/typescript is less topic-specific so keep it brief.

---

## Phase 3 — Day 1 social (Twitter/X)

Record a **30-second screen recording** showing:

1. (0–5s) Open your editor, show `import { CachedAnthropic } from "prompt-cache-optimizer"`
2. (5–15s) Run the basic-chatbot example in terminal
3. (15–25s) Show the final `client.stats()` output with real numbers
4. (25–30s) Zoom on `dollarsSaved`

### Caption template

> If you run @AnthropicAI Claude in production and aren't using prompt caching, you're paying 10x for nothing.
>
> Built a 9KB wrapper that tracks real cache hit rate and warns when your cache silently breaks. Saved me 70% on my bill.
>
> npm i prompt-cache-optimizer
>
> github.com/leonhail-nell/prompt-cache-optimizer

Tag @AnthropicAI. Tag any Anthropic DR folks you can find. Use hashtags sparingly: `#Claude #LLM` is enough.

---

## Phase 4 — Week 1 follow-up

### Blog post (do this within 7 days)

**Outline:**

1. Hook — a specific dollar amount you lost or saved (real numbers > generic claims)
2. The problem — prompt caching is supposed to save 90% but silently fails
3. The 4 failure modes — wrong breakpoint placement, reordering, TTL expiration, no measurement
4. The solution — what your wrapper does, with a code snippet
5. What surprised you while building it
6. Roadmap and how to contribute
7. Link to the npm + GitHub

**Where to post:**
- dev.to (best for organic SEO)
- Medium
- Your personal blog if you have one
- Hashnode (decent dev audience)

Submit the dev.to version to relevant tags: `#anthropic`, `#claude`, `#llm`, `#typescript`, `#opensource`.

### Awesome lists (submit a PR to each)

Find these by searching GitHub for "awesome anthropic", "awesome claude", "awesome llm tools":

- [ ] https://github.com/Hannibal046/Awesome-LLM
- [ ] https://github.com/awesome-anthropic (if it exists)
- [ ] https://github.com/awesome-claude (if it exists)
- [ ] https://github.com/eugeneyan/applied-ml (under tools)
- [ ] Search GitHub for `awesome ai tools` and submit to top 3 results

Each PR is one line. Costs you 15 minutes total, gets you free discoverability.

### Anthropic Developer Discord

Find the official Anthropic developer community:
1. Discord invite is usually on https://docs.anthropic.com or the Anthropic website footer
2. Post in `#community-showcase` or equivalent channel
3. Be brief: "Built this to make prompt caching less painful — feedback welcome"
4. Anthropic DR sometimes amplifies good community tools. Don't ask for it directly; just be visible and helpful.

### Direct outreach (15 minutes/day for a week)

Search Twitter/X for:
- "Claude API expensive"
- "Anthropic bill"
- "prompt caching"
- "claude cost"

Reply to 3 people/day with a one-liner: "If you want to actually measure your cache hit rate, I built this — [link]. Free, MIT." Don't sell — be helpful.

---

## Phase 5 — Ongoing (week 2+)

### Ship v0.2 within 30 days

Auto-placement is what will make this package actually take off. v0.1 still requires the user to think about breakpoints; v0.2 should be zero-config. When v0.2 ships:

- New Show HN post (different angle: "v0.2 ships zero-config prompt caching")
- New Reddit posts (different angle each)
- Update the dev.to article with a follow-up

Each major version is a fresh distribution moment. Don't waste them.

### Build social proof

- [ ] Get one company to post a case study or testimonial
- [ ] Get one merged PR from an external contributor
- [ ] Get one mention in Anthropic's official cookbook
- [ ] Get one mention in a popular newsletter (AI Engineer, TLDR AI, Ben's Bites)

### PR to a popular Claude-using OSS project

Find one with 1K+ stars that uses `@anthropic-ai/sdk` directly. Open a PR replacing it with `CachedAnthropic`. Even if not merged, the PR is social proof and the discussion drives traffic.

How to find candidates:
```
https://github.com/search?q=%22%40anthropic-ai%2Fsdk%22+language%3ATypeScript&type=code
```

---

## Metrics to track

Check these weekly:

| Metric | Where | Target by end of month 1 |
|---|---|---|
| npm weekly downloads | https://npm-stat.com/charts.html?package=prompt-cache-optimizer | >100 |
| GitHub stars | repo page | >50 |
| GitHub issues opened | repo Issues tab | >5 (means real usage) |
| Discord/Reddit mentions | manual search | >3 |
| External PRs | repo Pull Requests | >0 |

The most important one is **issues opened**. People only file issues when they're actually using the package. Even angry issues are good signal.

---

## What NOT to do

- ❌ Don't post the same text to multiple subreddits — that's spam and gets you banned
- ❌ Don't ask for stars directly on HN ("please star my repo") — instant downvote
- ❌ Don't argue with critics — acknowledge, fix, move on
- ❌ Don't reply to every "X already exists" comment defensively — let the package speak
- ❌ Don't post in unrelated subreddits (r/programming, r/coding) — gets buried
- ❌ Don't buy fake stars or downloads — npm and GitHub catch this, and it kills credibility

---

## Daily checklist for week 1

**Day 1 (launch day):**
- [ ] Final README check, screenshot of stats at top
- [ ] Post Show HN at 9 AM PT
- [ ] Post r/ClaudeAI within 30 minutes
- [ ] Post r/LocalLLaMA within 1 hour
- [ ] Post r/AI_Agents within 2 hours
- [ ] Tweet with video
- [ ] Respond to every HN/Reddit comment for the next 4 hours

**Day 2:**
- [ ] Start writing the blog post
- [ ] Submit PRs to 3 awesome lists
- [ ] Post in Anthropic Discord

**Day 3:**
- [ ] Publish blog post on dev.to
- [ ] 3 direct outreach replies on Twitter

**Day 4:**
- [ ] Cross-post blog to Medium and Hashnode
- [ ] 3 more direct outreach replies

**Day 5:**
- [ ] Reply to any new issues / PRs
- [ ] Find and PR to one popular Claude-using OSS project

**Day 6–7:**
- [ ] Check metrics
- [ ] Plan v0.2 priorities based on feedback
- [ ] Write the v0.1.1 patch release notes if needed

---

## When this is working

You'll know it's working when:

1. The npm download chart hockey-sticks during week 1
2. People file issues without you knowing them
3. Someone DMs you saying "this saved me $X"
4. A bigger project links to yours
5. You hear someone mention it in a podcast / newsletter without prompting

Then v0.2 ships, and the cycle starts over but bigger.
