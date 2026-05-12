# Publishing to npm — step-by-step

This guide walks you through publishing `prompt-cache-optimizer` to the public npm registry. A few of these steps you have to do yourself (anything involving credentials or your npm account); the rest you can run from this folder.

## Pre-flight (already done)

- ✅ Package name `prompt-cache-optimizer` is available on npm
- ✅ `npm run typecheck` passes
- ✅ `npm run build` produces clean ESM + CJS + types in `dist/`
- ✅ `npm pack --dry-run` shows only 7 files (LICENSE, README, dist/*, package.json)
- ✅ No source files, node_modules, or secrets in the tarball

## Step 1 — Create an npm account (you must do this)

If you don't already have one:

1. Go to https://www.npmjs.com/signup
2. Pick a username, email, and password
3. Verify your email (npm sends a link — required before you can publish)
4. **Recommended:** enable 2FA at https://www.npmjs.com/settings/YOUR-USERNAME/profile under "Two-Factor Authentication." npm requires 2FA for "auth-and-writes" mode on new packages, and it's a hard requirement for popular packages.

> Why you have to do this part: account creation and password setup must come from you directly. Same for 2FA setup.

## Step 2 — Log in locally (you must do this)

Open a terminal in this folder and run:

```bash
cd "/Users/leonhailpaypa/Documents/prompt-cache-optimizer"
npm login
```

This will open a browser window. Log in with the account you just created. Your shell will then have a saved auth token at `~/.npmrc`.

Verify:

```bash
npm whoami
```

It should print your npm username.

## Step 3 — Final local check

Run these one more time before publishing:

```bash
npm install
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

All four should succeed. The `pack --dry-run` should list exactly 7 files totaling ~48KB unpacked.

> If `npm test` fails with a rollup native-module error, run `rm -rf node_modules package-lock.json && npm install` and try again. That's a known npm bug with optional native deps.

## Step 4 — Publish

```bash
npm publish --access public
```

`--access public` is required because npm defaults scoped packages (`@you/pkg`) to private. For unscoped names like `prompt-cache-optimizer` it's harmless to include explicitly.

If 2FA is on, you'll be asked for a one-time code from your authenticator app.

You should see:

```
+ prompt-cache-optimizer@0.1.0
```

## Step 5 — Post-publish verification

```bash
# Check the package page
open https://www.npmjs.com/package/prompt-cache-optimizer

# Try installing it in a scratch folder to confirm it works
cd /tmp && mkdir test-install && cd test-install
npm init -y
npm install prompt-cache-optimizer @anthropic-ai/sdk
node -e "const { CachedAnthropic } = require('prompt-cache-optimizer'); console.log(typeof CachedAnthropic)"
# Should print: function
```

## Publishing future versions

1. Bump the version in `package.json` (follow semver):
   - patch (`0.1.0` → `0.1.1`) for bug fixes
   - minor (`0.1.0` → `0.2.0`) for new features
   - major (`0.x.y` → `1.0.0`) when you break the public API
2. Update `CHANGELOG.md`
3. Commit and tag: `git tag v0.1.1 && git push --tags`
4. `npm publish`

You can also use `npm version patch` / `minor` / `major` to bump and tag in one command.

## Unpublishing (escape hatch)

If you publish something broken, you have a 72-hour window to unpublish:

```bash
npm unpublish prompt-cache-optimizer@0.1.0
```

After 72 hours you can only deprecate (not unpublish):

```bash
npm deprecate prompt-cache-optimizer@0.1.0 "Use 0.1.1 instead"
```

## Things to do once it's live

- Post on https://news.ycombinator.com on a Tuesday morning (US time) — Show HN format
- Submit to https://www.reddit.com/r/LocalLLaMA and r/ClaudeAI
- Tweet/X with a before/after cost graph
- Open a PR adding it to https://github.com/anthropics/anthropic-cookbook
- Add a "Built with" section to the README so people know how to credit you

## Troubleshooting

**`403 Forbidden — You do not have permission to publish`**: someone else owns the name. Pick a different one (try `prefix-pilot`, `anthropic-cache`, or `cache-anthropic` — all confirmed available as of this writing).

**`402 Payment Required`**: you tried to publish a private scoped package. Add `--access public`.

**`E401 — Unable to authenticate`**: run `npm login` again. Your token may have expired.

**Files I didn't want got published**: add them to `.npmignore` or, better, ensure the `"files"` array in `package.json` lists exactly what you want included. (Yours already does: `["dist", "README.md", "LICENSE"]`.)
