# Narrow GitHub access to the project's repository: a GitHub App, not an OAuth `repo` token (#110)

## The problem

The hosted connector signs people in through a **GitHub OAuth App** asking for
`repo read:user user:email` (`GITHUB_SCOPES` in `src/oauth/provider.js:33`). An
OAuth App cannot be limited to one repository — `repo` grants read and write on
**every** repository the user can reach, public and private, personal and
organisation.

This hurts most for the credential a manager **lends** (#50). It is stored as a
user token under `keys.projectGhCred(owner, repo)` and the deployment reaches the
repository through it for everyone who has no GitHub access of their own —
Google-signed-in members and agents. So the deployment holds a long-lived token
that can read and write **all of the lender's repositories**, not just the
project's. A leak of the deployment's KV exposes every repository the lender can
reach. It is the one place where teamctx's "your data stays in storage you
control" position rests on a credential far broader than the project.

## What exists now

| Piece | State |
|---|---|
| Identity + repo access | one OAuth App, scope `repo read:user user:email` (`provider.js:33`). The same `repo` token is used for sign-in identity **and** all repo I/O. |
| The lent credential | `kvSet(keys.projectGhCred, { token, lentById, lentByLogin, lentByEmail })` on lend (`api/oauth-server.js:1092`); a **user access token** with full `repo`. |
| Who reads through it | Google members (`resolveGoogleMember` → `member-access.js:52`), agents (`api/mcp/[owner]/[repo].js:161`), the project page (`project-view.js:78`), downloads/attaches, and more — ~15 read sites of `projectGhCred`. |
| GitHub I/O | hand-rolled `fetch` to `api.github.com` (`github-identity.js`, `member-access.js`, `project-creator.js`, `provider.js`). **No `octokit` dependency.** Reads use the Contents API; writes commit through it. |
| Lending ownership | `manager-checks.js` reasons about *the person who lent* — `lentByEmail`/`lentById`; the primary-manager handoff (#86) can only go to the lender. |
| Stop lending | `kvSet(keys.projectGhCred, null)` (`oauth-server.js:1121`); access ends on the next request because every read goes back to KV. |
| Self-host setup | `docs/mcp-hosted-setup.md` §1 registers an OAuth App and explicitly says *"Use an OAuth App, not a GitHub App."* |

## Proposal

Move repository access to a **GitHub App installed on the project's repository**,
and keep OAuth for **identity only**. The two concerns are separate today only by
accident (one token does both); splitting them is what lets each be as narrow as
it should be.

### 1. A GitHub App, installed per repository

A GitHub App installation gives **short-lived installation tokens** (1 hour),
limited to the repositories the app is installed on, with fine-grained
permissions. teamctx needs only:

- **Contents: read & write** — read and commit `.teamctx/…`.
- **Metadata: read** — mandatory, repository lookup.
- **Members: read** — only if org roster checks need it; otherwise omit.

The deployment registers one GitHub App (one per deployment, like the OAuth App
today). A manager **installs** it on the project repository.

### 2. Lending becomes installing

- The settings page offers **"Install the GitHub App on this repository"**,
  linking to the app's install URL. GitHub walks the manager through choosing the
  repository and returns to a **setup callback** carrying `installation_id`.
- teamctx stores, under a new `keys.projectInstallation(owner, repo)`, the
  **installation id** and who installed it (`installedByEmail`/`installedById`)
  — **never a token**.
- **Stop lending → uninstall.** Removing the install on GitHub, or teamctx
  dropping the stored id, cuts access on the next request (tokens are minted on
  demand, never stored).

### 3. One helper mints tokens on demand

A single `installationTokenFor(owner, repo)` resolves the stored installation id
to a fresh installation token, cached until shortly before its hour is up. Every
current read of `projectGhCred.token` calls it instead. Built on
**`@octokit/auth-app`** (`createAppAuth({ appId, privateKey, installationId })`
→ `auth({ type: 'installation' })` → `{ token, expiresAt }`); the library signs
the app JWT, caches tokens (lru-cache) and refreshes them, so teamctx writes no
JWT or refresh logic. The app's **private key** lives in a deployment env var,
server-side only.

### 4. Identity stays on OAuth, narrowed

Sign-in keeps the OAuth App but drops `repo`: **`read:user user:email`** is all
identity needs. (GitHub App user-to-server tokens could also carry identity, but
keeping a separate narrow OAuth path is a smaller change and leaves sign-in
working for people the app is not installed for.)

### 5. Keep the OAuth `repo` path working through migration

`projectGhCred` (a lent user token) and `projectInstallation` (an app install)
coexist. A read resolves a credential by: **installation first, else the legacy
lent token.** Existing deployments keep working untouched; a manager migrates
by installing the app and then withdrawing the old lent token. The settings page
marks the `repo`-scoped lend **legacy**, with a one-line deprecation note and a
link to install the app instead.

### 6. Manager checks: the installer is the lender

`manager-checks.js`'s "person who lent" becomes "person who installed":
`installedByEmail`/`installedById` play the role `lentByEmail`/`lentById` do now,
so the #86 handoff and step-out checks read the same, against the installation
record. The access itself belongs to the repository (the install), but a person
still performed the install, which is who the checks name.

## Existing open source first

- **GitHub Apps** are a GitHub platform feature — nothing to build for the
  permission model.
- **`@octokit/auth-app`** (MIT) handles the app JWT, installation tokens and
  caching. teamctx adds it as its first `octokit` dependency and uses it only in
  `installationTokenFor`; the existing hand-rolled `fetch` calls to the Contents
  API are unchanged except for where the token comes from.
- **What teamctx builds:** the settings "install on this repository" step and
  setup-callback handler, the `projectInstallation` mapping, `installationTokenFor`,
  and the migration shim that prefers an installation over a legacy lent token.

## Phasing (this is large and security-critical — ship it in parts)

1. **App support alongside OAuth.** Add `@octokit/auth-app`, `projectInstallation`,
   `installationTokenFor`, and the credential-resolution shim (installation → legacy
   token). No behaviour change for existing projects. Self-host doc gains the App
   registration steps.
2. **Install flow on the settings page.** The install link, setup callback, and
   the stored installer identity; manager-checks read the installation record.
3. **Deprecate the lent token + document.** Frame lending as the broader option
   with the App as the narrower one on the settings page, report the App in
   `/oauth/status`, and document the App setup in `docs/mcp-hosted-setup.md`.
   **Deferred:** dropping `repo` from the sign-in scope. A person signing in with
   GitHub still reads and writes their *own* repository through their token, and
   creating a repository needs `repo` too, so narrowing the sign-in scope means
   first moving those onto the App — a larger change than this one, which only
   narrows the **lent** credential. Left as a follow-up so nothing a GitHub
   sign-in does today breaks.

## Sub-questions, answered

- **Self-hosters register their own App.** A one-time setup like the OAuth App
  step, documented the same way in `docs/mcp-hosted-setup.md`: create the App,
  set its permissions, generate a private key, set `GITHUB_APP_ID` /
  `GITHUB_APP_PRIVATE_KEY` / `GITHUB_APP_SLUG` env vars.
- **Handoff reasoning:** as in §6 — the installer stands in for the lender.
- **Rate limits:** installation tokens carry their own per-installation limit,
  separate from a user's 5,000/hour, and scale up with installation size — so for
  a busy project this is equal or better, not worse. Confirm the exact numbers
  against GitHub's "Rate limits for the REST API" before relying on them.

## Acceptance (from the issue)

- A lent project's stored credential reaches only that project's repository: a
  token minted for project A is refused by GitHub on project B (a test asserts the
  403).
- Uninstalling the app (or clearing the stored installation) cuts off Google
  members' and agents' access within one request.
- `docs/mcp-hosted-setup.md` explains setting up the App.

## Risks and open points

- **Private-key handling.** A PEM in an env var; never logged, never sent to a
  client. Rotating it is an operator task to document.
- **Migration UX.** Existing deployments must not break: the legacy path stays
  until a manager has installed the App and withdrawn the old token. Decide
  whether to nudge migration or leave it entirely opt-in.
- **The install round-trip** differs from the OAuth redirect: GitHub's setup
  callback carries `installation_id` (and `setup_action`), which the settings
  flow must handle distinctly from the sign-in callback.
- **Org-owned repositories** may require an org owner to approve the installation;
  the settings copy should say so when the install cannot complete.

## Out of scope

Webhooks (installation/uninstall events) — teamctx can read the install state on
demand rather than subscribe; a later change could add `@octokit/app` webhook
handling if proactive revocation is wanted. Also out: changing how a local clone
authenticates (`teamctx contribute` with the clone's own push access is untouched).
