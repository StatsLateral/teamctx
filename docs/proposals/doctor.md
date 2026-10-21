# Proposal: `teamctx doctor`

**Status:** Implemented · **Issue:** [#180](https://github.com/StatsLateral/teamctx/issues/180)
· **Base:** `main`

## Why

A setup problem shows up late and in the wrong place: a missing or rejected AI
key fails at the first AI call, a broken manager gate at the first approval, and
nothing says which of several things to fix first. `teamctx doctor` checks the
setup up front and says how to fix each problem.

## What it does

`teamctx doctor [--offline]` runs these checks in order and prints one line for
each: `✓` when it passes, `✗` and one action to fix it when it doesn't, `–` when
it was skipped. A clean project ends with "all good" and exits 0; anything that
failed exits 1, so it can be run in a script.

| Check | Fails when | Fix line |
|---|---|---|
| Git repository | not inside one | Run `git init`, then `teamctx init`. |
| teamctx project | no `.teamctx/` above here, or its `config.json` can't be read | Run `teamctx init`. |
| Node version | `process.version` is below `engines.node` in `package.json` | Install Node 18 or later. |
| AI key present | no key for the configured provider | the existing `missingKeyMessage` (`ANTHROPIC_API_KEY not set. Add it to your .env file or shell environment.`) |
| AI key accepted | the provider rejects it, or can't be reached | Replace the key in `.env.local` / Check the network, then run doctor again. |
| Manager gate | `isBrokenGate(config)` | Run `teamctx config manager --repair`. |
| Remote for auto-push | `autoPush` is on and `git remote` is empty | Add one with `git remote add origin <url>`. |

- A check that needs an earlier one is skipped when that one failed (no project:
  no key, gate or remote checks), so the first line to fix is the first `✗`.
- `--offline` skips "AI key accepted", the only check that uses the network.
- The key is read the way the CLI reads it, from `.env.local` and the
  environment, for the provider in `config.json` (`anthropic` when unset).

## Reused

- **The key check:** `verifyProviderKey` (asks the provider's list-models
  endpoint; spends nothing, tells a rejected key from an unreachable provider).
  It lives in `src/oauth/manager-checks.js` beside the hosted-store checks, so it
  moves to `src/providers/verify-key.js` and the Settings page and the manager
  checks import it from there. Not copied.
- **The missing-key message:** `missingKeyMessage` in
  `src/providers/missing-key.js`.
- **The gate check:** `isBrokenGate` in `src/manager-repair.js`.
- **Project lookup:** `getTeamctxDir` and `readConfig` in `src/storage.js`.

The shape is the `doctor` command Homebrew and Flutter ship; there is nothing to
embed.

## Code

- `cli/commands/doctor.core.js`: `runDoctor({ cwd, env, offline, fetchImpl,
  git, nodeVersion })` returns `[{ name, status: 'ok'|'fail'|'skip', fix }]`.
  Git, fetch, the environment and the Node version are passed in, so every
  check is tested without a network or a real repository.
- `cli/commands/doctor.js`: prints the lines and sets the exit code.
- `cli/index.js`: `program.command('doctor')` with `--offline`.
- README: the command in the quickstart and the commands table.

## Tests

Each check passes and fails with the fix line it prints; a check after a failed
one is skipped; `--offline` skips the key check and calls no network; a clean
project prints "all good" and exits 0, a failing one exits 1; `doctor` is in
`--help`.

## Plan

- [x] Move `verifyProviderKey` to `src/providers/verify-key.js`; existing tests
      pass
- [x] `runDoctor` and its checks; tests
- [x] `teamctx doctor` command, `--offline`, exit code; tests
- [x] README quickstart and commands table, CHANGELOG
