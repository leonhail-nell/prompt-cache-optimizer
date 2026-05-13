# Contributing

Thanks for considering a contribution. This project is small and the contribution loop is short.

## Quick start

```bash
git clone https://github.com/leonhail-nell/prompt-cache-optimizer.git
cd prompt-cache-optimizer
bun install            # or: npm install
bun run typecheck      # should be clean
bun run test           # all tests should pass
bun run build          # produces dist/
```

## Project layout

```
src/
├── client.ts                  # CachedAnthropic — main wrapper
├── analyzer/
│   └── breakpoint-placer.ts   # placeBreakpoints() and detection helpers
├── tracking/
│   ├── hit-rate.ts            # parses Anthropic usage → CacheInfo
│   ├── stats.ts               # aggregator with rolling window
│   └── savings.ts             # re-export shim
├── diagnostics/
│   └── warnings.ts            # safe warning emitter
├── pricing/
│   └── models.ts              # per-model pricing table
├── types.ts                   # public types
└── index.ts                   # public exports
```

## Filing an issue

Use the templates — they're short and the structured info saves a few round trips. Bug reports need a minimal reproduction; feature requests need a concrete use case.

## Making a change

1. Open an issue first for anything non-trivial. Saves you the risk of writing code that won't land.
2. Branch from `main`.
3. Add or update tests in `tests/`. We use Vitest with stubbed SDK responses — see `tests/client.test.ts` for the pattern.
4. Run `bun run typecheck && bun run test` before pushing.
5. Update `CHANGELOG.md` under the "Unreleased" section.
6. Open a PR. CI runs typecheck + tests on Node 18, 20, and 22.

## Coding conventions

- TypeScript strict mode is on. No `any` without a comment explaining why.
- Comments explain *why*, not *what*. The code already says what.
- New public exports go through `src/index.ts` and need a doc comment.
- The public API is stable starting v1.0 — for v0.x, breaking changes are allowed in minor versions but should be called out in the CHANGELOG.

## Pricing updates

When Anthropic changes pricing, update `src/pricing/models.ts`:

1. Verify against https://www.anthropic.com/pricing
2. Update the affected entries
3. Update the "Last verified" date in the file header
4. Add a CHANGELOG entry — users care about pricing accuracy

## Releases

Maintainers only. Bumps go through `npm version`:

```bash
npm version patch   # 0.1.0 → 0.1.1
git push --follow-tags
npm publish --access public
```

GitHub release notes are copied from the matching CHANGELOG entry.

## License

By contributing, you agree your contributions will be licensed under the MIT license.
