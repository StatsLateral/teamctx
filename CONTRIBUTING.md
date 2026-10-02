# Contributing to teamctx

Thanks for your interest in improving teamctx! This guide covers everything you
need to propose a change.

## Setup

```bash
git clone https://github.com/StatsLateral/teamctx.git
cd teamctx
npm install
cp .env.example .env.local   # then add your ANTHROPIC_API_KEY
```

## Run the tests

```bash
npm test
```

teamctx uses [Vitest](https://vitest.dev). **Green tests are required to merge** —
CI runs the suite on every pull request.

## Workflow

1. Fork the repo and create a topic branch off `main`.
2. Make your change. Keep pull requests focused — one logical change per PR.
3. Add a line to `CHANGELOG.md` under `## [Unreleased]` describing your change.
4. Run `npm test` and make sure it passes.
5. Open a PR against `main`. Describe **what** changed and **why**.

## Code style

Match the surrounding code — naming, structure, and comment density. There is no
automated linter yet; readability and consistency with neighboring files is the
bar.

## Build vs borrow

About a quarter of teamctx's non-test code — some 4,000 lines when this was
written — re-implements plumbing that maintained open-source projects provide:
an import connector per service, each with its own sign-in, paging and rate
limits (~2,700 lines, and the bulk of it); a hand-written ZIP and .docx reader;
web sign-in and cookie sessions. None of that was a wrong call at the time.
Nothing in the process asked the question.

Every line of it is permanent maintenance — upstream API changes, edge cases,
security — spent away from the part only teamctx can do. A tab between two words
in a .docx silently joined them, because our reader did not know `<w:tab/>` was
whitespace; it was found and fixed inside
[#41](https://github.com/StatsLateral/teamctx/pull/41). A library would have had
that case years ago.

So before writing new plumbing, name what already exists.

**Borrow.** Anything a wider community already maintains:

| Need | Where to look first | Note |
| --- | --- | --- |
| Connectors, API clients, OAuth per service | [Nango](https://github.com/NangoHQ/nango), [LlamaIndex readers](https://llamahub.ai/) | Nango is a service to run, not a library; most llamahub readers are Python |
| File formats (.docx, .pdf, .xlsx) | [mammoth](https://github.com/mwilliamson/mammoth.js), [MarkItDown](https://github.com/microsoft/markitdown) | mammoth is JS; MarkItDown is Python, so it suits a tool rather than this runtime |
| Web sign-in and sessions | [Better Auth](https://www.better-auth.com/), [Auth.js](https://authjs.dev/) | |
| Switching between AI providers | [Vercel AI SDK](https://sdk.vercel.ai/) | The per-provider files are already thin wrappers over each vendor's own SDK; what an AI SDK would replace is the dispatch, not those |
| Redis | [`@upstash/redis`](https://github.com/upstash/redis-js) | `src/oauth/kv.js` chose plain `fetch` on purpose: no dependency, and an in-process `Map` when nothing is configured, which is what lets the suite run with no external service. A swap has to keep that |

Nothing in that table is a target to move toward. It is where to look when the
need is new, and the notes are there because a column of library names invites a
rewrite the next section rules out.

**Build.** The things nobody else is going to: the context model (Why → What →
How, the project layer a workstream inherits), review and governance, member
scoping, role compilation, and provenance. That is the product.

The line is not about difficulty. A file parser is hard and still worth
borrowing; a review gate is easy and still ours, because its behaviour is a
product decision rather than a solved problem.

**This does not mean rewriting what is here.** Moving working code costs more
than keeping it. A swap happens when a piece breaks or needs extending: the next
connector is where a connector framework earns its place, and the next .docx bug
is where mammoth does.

Two places ask for this, so it happens when the decision is live rather than
after the code is written. The feature request template has a required
**Existing open source first** field, and the PR checklist asks whether new
plumbing uses a library or says why not. "Nothing fits, and here is what I
checked" is a complete answer — the point is that somebody looked.

## Sign your commits (DCO)

teamctx uses the [Developer Certificate of Origin](https://developercertificate.org/).
By signing off, you certify you wrote the patch (or have the right to submit it)
under the project's MIT license. Add a sign-off line to each commit:

```bash
git commit -s -m "your message"
```

This appends `Signed-off-by: Your Name <your@email>` to the commit message. No
CLA is required.

## How contributions are approved

A pull request can merge only when **both** are true:

1. **CI is green** — the Vitest suite passes on Node 18 and 20.
2. **A maintainer approves** — you'll be auto-requested via `CODEOWNERS`.

Branch protection on `main` enforces this; there are no direct pushes to `main`.

## Governance

teamctx is currently maintained by a single maintainer (StatsLateral), who is the
final decision-maker. Decisions happen in the open, in issues and pull requests.
As the project grows, this model may evolve — proposals to change it are welcome
in Discussions.

## Releasing (maintainers)

teamctx follows [Semantic Versioning](https://semver.org). While on `0.x`,
anything may change; the bump to `1.0.0` signals a stable public API/CLI.

To cut a release:

1. In `CHANGELOG.md`, move entries from `## [Unreleased]` into a new
   `## [x.y.z] - YYYY-MM-DD` section.
2. `npm version <patch|minor|major>` (updates `package.json` and creates a git tag).
3. `git push && git push --tags`.
4. `npm publish --access public`.

**First publish (one-time):** the `teamctx` package is not yet on npm. Before the
first `npm publish`, confirm the name is available/owned, run `npm login`, then
`npm publish --access public`. Until this is done, the README's `npx teamctx` will
not work.
