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

> Why you have to do this part: account creation and password setup must come from you directly. Same for 2FA setup below.

### Set up 2FA (strongly recommended, ~2 minutes)

npm requires 2FA on most published packages now and it's worth doing before your first publish so you don't have to retrofit it.

1. Install an authenticator app on your phone if you don't have one. Options: Google Authenticator, Authy, 1Password, Bitwarden.
2. Log in at https://www.npmjs.com, click your avatar → **Account settings**
3. Find the **Two-Factor Authentication** section, click **Enable 2FA**
4. Pick **Authorization and publishing** (the stricter mode — you'll be prompted for a code every publish)
5. Scan the QR code with your authenticator app
6. Enter the 6-digit code to confirm
7. **Save your recovery codes somewhere safe** — these are your only way back in if you lose your phone

After this, every `npm publish` will prompt for a 6-digit code from your app.

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

Run these one more time before publishing. Use **either** npm or bun, not both (mixing them causes a known rollup native-deps error):

**With npm:**

```bash
npm install
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

**With bun:**

```bash
bun install
bun run typecheck
bun run test       # IMPORTANT: "bun run test", not "bun test"
bun run build
bun pm pack --dry-run
```

The `pack --dry-run` should list exactly 7 files totaling ~48KB unpacked.

> If you see a rollup native-module error, you have leftover state from the other package manager. Fix: `rm -rf node_modules package-lock.json bun.lock && <your-pm> install`.

> Why `bun run test` and not `bun test`: the latter invokes Bun's built-in test runner, which isn't Vitest. `bun run test` goes through the npm script and calls Vitest properly.

## Step 4 — Publish

```bash
npm publish --access public
# or:
bun publish --access public
```

Both push to the same npm registry; the output tarball is byte-identical. Bun reads auth from `~/.npmrc` (the same file `npm login` writes to), so you still need to have logged in once via `npm login`.

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
