# Design: Hosted "create a new project" onboarding (closes #52)

**Roadmap item:** Manager onboarding: `initProject` never creates the GitHub repo (#52)
**Status:** Approved, ready for planning

## Problem

`initProject` (`cli/commands/init.core.js`) writes into whatever `owner/repo`
the connector URL already names — it never creates the repo itself
(`src/git.js`'s `checkGitRepo` only verifies a repo already exists; hosted
mode skips the check entirely since the session is bound to a repo the URL
already named). There is no `repos.create`/`createRepo` call anywhere in the
codebase.

For the target non-technical manager persona (a startup CEO or board advisor
with no git/GitHub background), this is more than a rough edge: the hosted
connector URL a manager pastes into Claude is literally
`.../api/mcp/<owner>/<repo>` — the repo has to already exist before they can
even start the OAuth handshake. There's a chicken-and-egg problem: they need
a repo to type the URL, but nothing in teamctx today lets them get one
without already knowing how to use GitHub.

Surfaced during a 2026-08-31 audit of the primary manager → freelancer →
daily-approval use case against `main` (see also #53–#55 for the other gaps
found in that audit).

## What exists today (relevant prior art)

- `cli/commands/init.core.js` — `initProject`, already hosted-mode-aware
  (`getCurrentSession()` branch), takes `{ projectDir, project, me, provider,
  ... }` and writes `.teamctx/config.json` + the initial workstream, then
  `commitContext(...)`.
- `src/adapters/github.js` — `GithubSession`, the hosted storage backend.
  Constructed with `{ owner, repo, ref, ghToken }`; `prefetch()` loads
  `.teamctx/**`; `commit(message)` builds one atomic commit. This is the
  exact machinery `mcp/http.js` uses per-request — reusable as-is for a
  freshly created repo.
- `src/session-context.js` — `runWithSession(session, fn)` /
  `getCurrentSession()`. Anything called inside `runWithSession` (including
  `initProject`) transparently sees the session.
- `api/oauth-server.js` — already has a repo-independent GitHub login:
  `/settings` (renders a sign-in page when logged out), `/settings/signin`
  (starts GitHub OAuth with `GITHUB_SCOPES = 'repo read:user'` — `repo`
  scope already covers repo creation, no new scope needed), and the
  `/oauth/github/callback` handler's `settingsPending` branch, which stores
  `{ id, login, name, token }` in a KV-backed session behind an httpOnly
  cookie (`loginViaGithub`). This is the exact foundation for a
  "create a new project" page: sign in once, not scoped to any particular
  repo.
- `/settings/share` and `/settings/unshare` (from #48, merged) are the
  closest precedent for a POST handler in this file that calls out to the
  GitHub API using the session's stored token and does something
  project-affecting — same shape this new POST handler follows.
- `src/oauth/shared-key.test.js` — the one existing test that reaches into
  this area tests an exported plain function (`withSharedKey` from
  `api/mcp/[owner]/[repo].js`) directly with a mocked KV, not the Express
  route. `canShareWith`/`parseRepoRef` (inline in `oauth-server.js`) are
  *not* unit-tested today — that's the established (if imperfect) convention
  for this file, followed here rather than introduced as a new pattern.
- No `supertest` or similar HTTP-route-testing tool is in `package.json`
  (`vitest` only) — introducing one is out of scope for this fix.

## Explicitly out of scope

- **PR #50** ("member onboarding," blocked pending #49's `assertManager`
  fix) builds a proper `get_connect_url` / `docs/mcp-join.md` for showing a
  connector URL. This design does **not** depend on #50 landing — it
  assembles the connector URL inline (`${baseUrlFor(req)}/api/mcp/${owner}/${repo}`),
  since that's simple enough not to need #50's machinery. Worth revisiting
  as a shared-code cleanup once #50 merges, but not a blocker for this work.
- **Local/CLI repo creation** (e.g. `teamctx init --create-repo` from a
  terminal) is not part of this design — it doesn't reach the target
  no-terminal manager persona. Left as a possible smaller follow-up.
- **Org repo-creation permission nuances** beyond a plain 403 passthrough
  (e.g. distinguishing "org doesn't allow members to create repos" from
  "org requires approval") are not modeled — GitHub's 403 body is surfaced
  as-is.

## Design

### 1. GitHub API helpers (`src/adapters/github.js`)

Two new exported functions, alongside `GithubSession`, following its
existing REST-call conventions (`Authorization: Bearer`, `X-GitHub-Api-Version`):

```js
export async function listUserOrgs(token) // → [{ login }]
export async function createRepo(token, { name, org, description }) // → { owner, repo }
```

`createRepo` posts to `POST /user/repos` (personal) or `POST /orgs/{org}/repos`
(org), with `private: true` and `auto_init: true` — the initial commit
`auto_init` produces is required so the repo has a real default branch/HEAD
for `GithubSession.commit()` to build the `.teamctx/` commit on top of; a
truly empty repo (zero commits) has no ref to resolve.

A third small pure helper, `slugifyProjectName(name)`, converts a
human-readable project name into a GitHub-valid repo name (lowercase,
spaces/punctuation → hyphens, strip anything outside `[a-z0-9-]`, collapse
repeated hyphens). Lives in the same file.

### 2. Routes (`api/oauth-server.js`)

**`GET /settings/new-project`**
- Not signed in → `res.redirect(303, '/settings/signin?returnTo=/settings/new-project')`.
- Signed in → fetch `listUserOrgs(user.token)` (non-fatal on failure — fall
  back to personal-account-only); render a form: project name (text) +
  owner picker (personal account, or one of the returned orgs).

**`POST /settings/new-project`**
- Slugify the project name into a repo name.
- `createRepo(user.token, { name, org })`.
  - 422 (name collision) → re-render the form, project name preserved,
    inline error.
  - 403 (org forbids member repo creation) → re-render with an error naming
    the org, suggesting personal account.
- On repo creation success: build `new GithubSession({ owner, repo, ghToken:
  user.token })`, `await session.prefetch()`, then
  `await runWithSession(session, () => initProject({ project: <name>, me:
  user.name || user.login, source: 'web' }))`. `source: 'web'` is a new value
  for `initProject`'s existing `source` param (today only `'mcp'` vs.
  everything-else) — using the existing `'mcp'` value here would mislabel the
  commit history, since this isn't an MCP tool call, it's a plain web form
  POST. `init.core.js`'s `sourceNote` logic gets a matching branch: `source
  === 'mcp' ? ' (via mcp)' : source === 'web' ? ' (via web onboarding)' :
  ''`. Same rationale as the existing note: a repo bootstrapped this way has
  no local checkout and no shell, so the commit history is the only record
  of where it came from.

  `init.core.js` has no existing test file, and adding a full harness just
  for this one line is disproportionate. Instead, extract the note logic
  into a small standalone exported function, `sourceNote(source)` →
  `' (via mcp)' | ' (via web onboarding)' | ''`, trivially unit-testable
  with no mocking (same "pull the pure logic out so it's testable without a
  harness" move already used for `withSharedKey`).
  - If this step throws (repo now exists but isn't initialized): render an
    error page with a "retry setup" action that re-POSTs with the
    already-known `owner`/`repo` and skips straight to the
    `GithubSession`/`initProject` step (idempotent re-entry point — no
    second `createRepo` call).
- On full success: render a success page with the connector URL
  (`${baseUrlFor(req)}/api/mcp/${owner}/${repo}`) and a short "paste this
  into Claude → Settings → Connectors" instruction, matching the "Using it"
  section already in `docs/mcp-hosted-setup.md`.

### 3. `returnTo` on the signin flow

`/settings/signin` currently always sends the OAuth callback back to
`/settings`. Extend the pending KV record
(`keys.pending('settings:'+state)`) from `{ kind: 'settings' }` to `{ kind:
'settings', returnTo }`, where `returnTo` is read from
`req.query.returnTo` and validated against `/^\/settings\/[a-z-]*$/` before
being stored (reject anything else, falling back to `/settings` — this is
the only place a client-supplied path could end up driving a redirect, so
it's allow-listed rather than trusted). The callback's `settingsPending`
branch redirects to `settingsPending.returnTo || '/settings'` instead of the
hardcoded `/settings`.

## Error handling summary

| Case | Behavior |
|---|---|
| Not signed in | Redirect to sign-in, return to `/settings/new-project` after |
| Org list fetch fails | Fall back to personal-account-only, page still loads |
| Repo name collision (422) | Re-render form, name preserved, inline error |
| Org forbids repo creation (403) | Re-render form, error names the org |
| `initProject` fails after repo created | Error page with idempotent "retry setup" action, no repo re-creation |

## Testing

- `src/adapters/github.js` unit tests (vitest, mocked `fetch`): `createRepo`
  success (personal + org), 422, 403; `listUserOrgs` success and failure;
  `slugifyProjectName` across spaces/punctuation/casing/edge input.
- `cli/commands/init.core.js`: new `init.core.test.js` covering just the
  extracted `sourceNote(source)` function (`'mcp'` → `' (via mcp)'`,
  `'web'` → `' (via web onboarding)'`, anything else → `''`) — first test
  file for this module, deliberately scoped to the one new pure function
  rather than standing up a full mocked-git/mocked-session harness for the
  rest of `initProject`.
- No dedicated tests for the Express route handlers, consistent with the
  rest of `oauth-server.js` today.
- Manual verification against a real (throwaway) GitHub account and a
  Vercel preview deploy before considering this done — this class of hosted
  onboarding flow has bitten the project before by only being verified live
  (#44).
