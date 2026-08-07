# Plan: hosted MCP server (HTTP transport + GitHub-backed storage)

**Branch:** `feat/mcp-hosted` (off `feat/mcp-full-surface`)
**PR base:** `main`.
**Shape:** Adds a **remote transport** and a **GitHub storage adapter** to
the existing 28-tool MCP surface so Claude.ai (web), ChatGPT (paid), and any
MCP-aware client can call teamctx tools without touching a terminal.

---

## Motivation

Today the MCP server speaks stdio and reads/writes the local filesystem.
That's fine for Claude Desktop / Cursor / Claude Code (they can spawn a
local process), but **useless for web clients** — Claude.ai and ChatGPT in
the browser can only connect to **remote MCP servers over HTTP**. Managers
who want to run teamctx entirely from their AI without any developer
support are gated on this.

The fix: expose the exact same 28 tools over HTTP, with the storage layer
swapped for a **GitHub API adapter** so the server can be **stateless** —
one Vercel deployment serves every user by proxying to their own git repo.
No teamctx-owned DB; the user's repo remains the source of truth.

## Non-goals for this PR

- **No OAuth flow.** MVP takes GitHub PAT + Anthropic key via URL query
  string. GitHub App / OAuth flow is a follow-up (~1 more day) before we
  publicly announce.
- **No self-hosted Docker image.** Same code path could ship as one, but
  packaging is deferred.
- **No stdio deprecation.** Local `teamctx mcp` keeps working exactly as
  today; the HTTP path is additive.
- **No Anthropic Skill / CLAUDE.md snippet in this PR** — will ship in a
  follow-up "discovery layer" PR once the transport works.

## Design

### 1. Transport layer

- Import `StreamableHTTPServerTransport` from
  `@modelcontextprotocol/sdk/server/streamableHttp.js` (already in
  package.json — MCP SDK 1.29).
- Add `startMcpHttpHandler({ req, res, projectContext })` that mounts the
  same `buildServer(projectContext)` on an HTTP response.
- Existing `startMcpServer` (stdio) untouched.

### 2. Storage abstraction

- Introduce a **storage adapter interface** — the same shape as the
  functions currently exported from `src/storage.js` (`readConfig`,
  `readWorkstream`, `writeWorkstream`, `readContributions`,
  `appendContribution`, `writeQueueItem`, `readQueueItem`, `listQueue`,
  `deleteQueueItem`, `writeSnapshot`, `readSnapshot`, `listSnapshots`,
  `writeRoleFile`, `readRoleFile`, `writeWorkstreamMd`, `readWorkstreamMd`,
  `writeConfig`, `readCurrentSnapshotPointer`, `writeCurrentSnapshotPointer`,
  `listWorkstreamIds`, `resolveSnapshotId`, `writeRejected`).
- Refactor `makeHandlers(projectRoot)` to
  `makeHandlers(projectContext)` where `projectContext` is either
  `{ kind: 'fs', teamctxDir }` (today) or
  `{ kind: 'github', owner, repo, ref, ghToken }` (new).
- All handlers use `ctx.storage.<fn>()` instead of top-level storage
  imports.

### 3. GitHub adapter (`src/adapters/github.js`)

**Reads:**
- Fetch each file via GitHub Contents API
  (`GET /repos/:owner/:repo/contents/:path?ref=...`) → returns
  `{ content: base64, sha }`. Cache within a single request (memoized on
  path) so a tool that reads config + workstream + contributions.jsonl
  doesn't hit the API three times.

**Writes:**
- Single-file writes via Contents API
  (`PUT /repos/:owner/:repo/contents/:path` with `sha` for updates).
- Multi-file atomic writes (`init`, `snapshot_create`, `reflect`) via Git
  Data API: `POST blobs` → `POST trees` → `POST commits` → `PATCH refs`.
  One git commit per tool call.
- Concurrent-write handling: on 409 SHA mismatch, refetch and retry once.
  If second attempt also 409s, error back to the client — user re-runs.

**Auth:**
- All API calls use the `Authorization: Bearer <gh_token>` header from
  `projectContext.ghToken`.

**Committer identity:**
- Every write commit's `author` / `committer` = the PAT owner
  (fetched once via `GET /user` and memoized). `author` param on the tool
  still gates approvals via existing `assertManager`, but the git commit
  trailer shows the PAT owner. Documented explicitly.

### 4. Vercel handler

`api/mcp/[...path].js` — Next.js-style catch-all:

- Parses path `/api/mcp/<owner>/<repo>` (with optional `/refs/<ref>`).
- Extracts `gh_token` and `api_key` from the query string.
- Sets `ANTHROPIC_API_KEY` for the AI layer scoped to this request
  (uses `async_hooks` `AsyncLocalStorage` so concurrent requests don't
  collide).
- Builds a `github` `projectContext` and mounts an `StreamableHTTPServerTransport`
  on the `req`/`res` pair, then dispatches.

### 5. AI-layer key scoping

- `src/ai.js` today reads `process.env.ANTHROPIC_API_KEY` at call time.
- Wrap it in an `AsyncLocalStorage` context so the HTTP handler can inject
  the caller's key per-request without touching `process.env` (safe for
  concurrent requests on the same Vercel instance).

### 6. Docs

- New `docs/mcp-hosted.md` — end-user setup for Claude.ai, ChatGPT, and
  Claude Desktop (URL config, PAT scope, API-key handling).
- Update `docs/mcp.md` with a "Transport" section listing stdio + HTTP,
  and link to the hosted doc.

## Files touched

New:
- `src/adapters/index.js` — adapter interface + factory (`makeAdapter(ctx)`).
- `src/adapters/fs.js` — thin wrapper around existing `src/storage.js` fns.
- `src/adapters/github.js` — GitHub-backed storage adapter.
- `src/adapters/github.test.js` — unit tests with mocked `fetch`.
- `api/mcp/[[...path]].js` — Vercel handler (Next-style catch-all).
- `docs/mcp-hosted.md` — end-user setup guide.
- `docs/superpowers/plans/2026-07-30-mcp-hosted.md` — this plan.

Modified:
- `mcp/server.js` — `makeHandlers(ctx)` takes a context instead of a
  projectRoot; all handlers use `ctx.storage.*`; new
  `startMcpHttpHandler` export.
- `mcp/server.test.js` — pass a `{kind: 'fs'}` context in existing tests
  (adapter delegates to the same mock functions).
- `src/ai.js` — AsyncLocalStorage for per-request API key injection.
- `README.md` — brief mention of hosted mode, pointer to the new doc.
- `CHANGELOG.md` — `## [Unreleased]` entry.

## Order of work

Roughly 4 days for a working hosted MVP.

1. **Storage adapter interface + `fs` implementation** — refactor
   `makeHandlers` to take `ctx.storage`. All 165 existing tests still
   green with the fs adapter delegating to the current storage. **1 day.**
2. **GitHub adapter (read side)** — implement read fns via Contents API +
   memoized fetch. Cover with unit tests using a mocked `fetch`.
   **0.75 day.**
3. **GitHub adapter (write side)** — Contents API for single-file writes,
   Git Data API for multi-file atomic writes, 409 retry. **1 day.**
4. **HTTP transport + Vercel handler + AsyncLocalStorage AI key
   injection** — mount `StreamableHTTPServerTransport` in the Vercel
   function, parse URL, run integration tests locally. **0.75 day.**
5. **Docs + CHANGELOG + local smoke test.** **0.5 day.**

## What I'll need from the user

- **Vercel account + project name** — for the actual production deploy. I
  can push a preview deploy on my fork's Vercel org if you'd rather test
  before wiring the org URL.
- **Confirm PAT-in-URL for MVP** vs waiting for GitHub App OAuth (~1 more
  day). Auto-mode default: PAT-in-URL.
- **Confirm committer identity policy** — default: commit shows PAT owner
  in `git log`, `author` on the tool is only used for the manager gate.
  Documented in the new docs.

## Testing checklist

- [ ] `npm test` green through every step.
- [ ] Local integration: `curl -N -X POST http://localhost:3000/api/mcp/<owner>/<repo>?gh_token=...&api_key=... -d '{"jsonrpc":"2.0","method":"tools/list"}'` returns 28 tools.
- [ ] Read tools (`get_context`, `list_workstreams`, `get_role_context`,
      `get_status`, `list_snapshots`, `ask`) work end-to-end against a
      real GitHub repo.
- [ ] Write tools (`contribute`, `snapshot_create`, `role_add`) create
      real commits on the target repo.
- [ ] `contribute --apply` gate enforced with `author` param check.
- [ ] Concurrent-write 409 handled gracefully.
- [ ] Deployed on Vercel; connected from Claude Desktop via URL config.
- [ ] Commits signed off (`git commit -s`).
- [ ] `CHANGELOG.md` entry.

## Follow-ups (out of scope for this PR)

- GitHub App / OAuth flow (Connect button, revocable, no URL token).
- Self-hosted Docker image build.
- Anthropic Skill and CLAUDE.md snippet for the discovery layer.
- Server-hosted Anthropic key option (opt-in per install, for orgs that
  don't want BYOK).
- Rate-limit + quota surface (currently: GitHub's 5000 req/hour per
  token; nothing added).
