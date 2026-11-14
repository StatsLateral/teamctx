# Hosted connector access — design

**Branch:** `feat/hosted-connectors` (off `origin/main` `b057bbd`, 0.5.3)
**Status:** building — phase 1 in progress
**Date:** 2026-11-11
**Prerequisite for:** #248 (link-output staleness on the web). See the dependency note on that issue.

---

## The problem

Cloud connectors (Google Drive, Dropbox, SharePoint/M365) authenticate **only
through the CLI** today — `teamctx auth <connector>` writes a token to
`.env.local`. The hosted web app has **no per-user store for a connector token**.

So anything that needs to read a user's cloud file on the server cannot run on
the web — only from a local MCP whose `.env.local` holds a token. The first
feature this blocks is **#248 link staleness**: the check reads a file's version
marker, which needs a connector token, so on the hosted site it is always
`unknown`.

teamctx's primary surface is **web AI agents over hosted MCP + the web app**, so
a connector feature that only works locally is effectively unavailable.

## What we are building

A **hosted, per-user connector connection**, stored server-side, with a
**member → primary-manager fallback** — reusing the exact pattern AI keys
already use (`src/oauth/ai-keys.js`): a personal credential in encrypted KV,
where the **primary manager's** credential is the project's fallback.

This is general connector infrastructure. #248 (and later, hosted import) consume
it; it does not depend on the outputs epic, hence the clean base.

## Model (mirrors AI keys)

- **Connection = per person, global, once.** You connect Google Drive in
  **Settings → Connected accounts**. It is used across every project you are on.
  There is nothing per-project to connect or track — this answers "which project
  did I connect in?": none, it is your account.
- **Project fallback = the primary manager's connection.** A member who has not
  connected, or whose account cannot see a file, falls back to the primary
  manager's connection — exactly as a project runs on the primary manager's AI
  key. The manager "shares access" by being connected and primary; their token
  is used **server-side on the member's behalf** and never handed out.
- **Resolution order for a check:** member's own connection → primary manager's
  connection → `unknown`. Record which one answered, for traceable verdicts.

### Why not per-member OAuth-everywhere, or public files

- Per-member only: every member connects *and* the file owner shares the file
  with each of them — an approval storm. Rejected; the manager fallback removes
  the need.
- Public files: forces oversharing confidential docs for a timestamp. Rejected.

## UX

**Settings → Connected accounts** (the only place OAuth happens):

```
Connected accounts
  Google Drive   Connected as priya@acme.com · Disconnect
  Dropbox        Connect
```

- Copy states plainly: *"teamctx uses this to read files you link in any
  project."* (one global grant, used across projects).
- A **manager** sees a line that their connection is a project's fallback reader;
  consent is explicit by connecting while primary.

**Inside a project:** no new connect UI. If a check needs access the member has
not granted, show *"Connect Google Drive"* that **deep-links to Settings** and
returns.

## Architecture

Reuse the hosted OAuth + KV layer (`src/oauth/kv.js`, `secret-box.js`, the
settings page, the GitHub OAuth app flow in `api/oauth-server.js`).

### Storage (phase 1 — this change)

`src/oauth/connectors.js`, keyed by verified email like AI keys:

- `keys.connectorToken(email, provider)` — **secret** (`teamctx:connector:token:`
  added to `SECRET_PREFIXES`, encrypted at rest). Payload:
  `{ provider, accessToken, refreshToken, expiresAt, account, connectedAt }`.
- `keys.connectorIndex(email)` — the providers a person has connected, for the
  settings page (not secret).

API: `readConnection`, `writeConnection`, `removeConnection`, `connectionsFor`,
and `pickConnection({ email, provider, primaryEmail })` → `{ ...record, via:
'own' | 'project' }` or `null`.

### OAuth routes (phase 2)

Per provider, mirroring the GitHub OAuth app flow, from the settings page:
- `GET /settings/connect/:provider` → provider consent (offline access, so we
  get a refresh token) → `GET /settings/connect/:provider/callback` → exchange
  code → `writeConnection`.
- `POST /settings/disconnect/:provider` → `removeConnection`.
- Provider client id/secret from deployment env (`GOOGLE_CLIENT_ID` etc.). A
  **Google Cloud OAuth app** must be created — external setup the user does once.
- Token refresh: a `freshAccessToken(record)` helper that refreshes with the
  refresh token when `expiresAt` has passed, and re-stores.

### Settings UI (phase 3)

A "Connected accounts" section on the existing settings page: provider rows with
Connect/Disconnect and status, plus the secrets-configured warning the page
already shows for AI keys.

### Consume it — #248 rewiring (phase 4, on the #248 branch, not here)

- `readVersionKey` / `checkLinkOutputs` resolve creds via `pickConnection` when
  running hosted, falling back to `.env.local` locally.
- A hosted trigger for the check (drawer-open / "check now" / scheduled), since
  today the trigger lives only in the local MCP tool.
- Record `via` ('own' / 'project') on the check record.

## Scope for now

**Google Drive first, Dropbox second. M365 later** (its Azure-AD app is more
setup). The connector `currentVersion` code already exists for all three; the
new work is the hosted OAuth + store, which is per-provider.

## Build phases

1. **Connector token store + tests** (this change) — pure KV, no HTTP.
2. Google OAuth connect/callback/disconnect routes + token refresh.
3. Settings "Connected accounts" UI.
4. (#248 branch) Rewire the staleness check to `pickConnection` + a hosted
   trigger.

Each phase is its own commit; phase 2 waits on a Google Cloud OAuth app.
