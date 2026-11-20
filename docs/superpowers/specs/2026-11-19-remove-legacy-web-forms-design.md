# Remove the legacy `/ask` and `/contribute` web forms, and `teamctx pull`

Issue: #322. Branch: `feat/remove-legacy-web-forms`.

## Why

`/ask` and `/contribute` are HTML forms from before the hosted connector. The
hosted product (connector, Settings, review queue) no longer uses them, and they
carry a cost that now outweighs their value:

- **`/contribute`** (`api/contribute.js`) writes a file to `.teamctx/pending/`
  in the repo named by `GITHUB_REPO`, using `GITHUB_TOKEN`. Its only reader is
  `teamctx pull`. No hosted flow touches it.
- **`/ask`** (`api/ask.js`) answers from the deployed context with the server's
  `ANTHROPIC_API_KEY`.
- Both are routed in `vercel.json` with **no check on the caller** — the README's
  security model calls them "public". They are inert when their env vars are
  unset, but a deployment that *does* set them exposes an unauthenticated,
  key-spending (`/ask`) or repo-writing (`/contribute`) endpoint to anyone who
  finds the URL. Removing them removes that surface.

The CLI `teamctx ask` is a **different** thing: it runs locally and shares only
the core (`src/context.js` → `answerQuestion`, `src/storage.js`), not the web
route. It stays.

## What is removed

- `vercel.json` — the `/contribute` and `/ask` route entries.
- `api/ask.js`, `api/contribute.js` — the two handlers.
- `api/ask-project.test.js` — the web-`/ask` handler's test.
- `cli/commands/pull.js` — the `pull` command, which has nothing left to read.
- `cli/index.js` — the `pullCommand` import and its `program.command('pull')`
  registration.
- `README.md` — the `teamctx pull` row in the command table, the two web-page
  bullets, the "Enable web contributions" step, the two "public" lines in the
  Security model, and the `pending/` inbox line in the repo layout.
- `CHANGELOG.md` — a note that the two forms and `teamctx pull` are removed,
  since it removes an interface.

## What is kept

- The CLI `teamctx ask` command and its test (`cli/commands/ask.js`,
  `cli/commands/ask-project.test.js`).
- The shared core used by the CLI path: `src/context.js`, `src/storage.js`,
  `src/project-level.js`.
- `/context/<role>` — the CLI prints that URL; it is unrelated to the forms.

## Risks and checks

- **Shared env vars.** `GITHUB_REPO` / `GITHUB_TOKEN` are also referenced by
  `cli/commands/setup.js` and `src/oauth/provider.js`. The "Enable web
  contributions" README step documents them for the contribute/pull flow only;
  removing that section must not delete env-var documentation or code still used
  elsewhere. Verify the vars are not orphaned, and leave any non-form use intact.
- **No shared module is deleted.** `api/ask.js` imports only shared core that the
  CLI path also uses; only the web handlers, the web-ask test, and `pull` are
  deleted, so the CLI `ask` path and the rest of the suite are untouched.
- **Anyone still using the forms.** The issue's noted alternative — putting them
  behind the `/settings` sign-in with a per-person limit — is more work than
  removing them and is out of scope here; the removal is called out in the
  changelog so it is not a silent break.

## Acceptance (from the issue)

- `/ask` and `/contribute` return 404 on a deployment.
- `teamctx pull` is gone from `--help`; `teamctx ask` still works.
- The README no longer describes either form, and the changelog lists the
  removal.
- The full test suite passes with the removed files gone.

## Plan (naturally sized commits)

1. Remove the two routes from `vercel.json` and delete `api/ask.js`,
   `api/contribute.js`, and `api/ask-project.test.js`.
2. Remove `teamctx pull`: delete `cli/commands/pull.js` and its import and
   command registration in `cli/index.js`.
3. Update `README.md` (command table, web-page bullets, "Enable web
   contributions" step, Security-model "public" lines, repo-layout `pending/`
   line) and add the `CHANGELOG.md` entry.

## End-to-end verification (developer, on a live test deployment)

- `/ask` and `/contribute` return 404.
- `teamctx --help` no longer lists `pull`; `teamctx ask "<question>"` still
  answers from the project's context.
- A deployment with no form env vars set behaves as before.
