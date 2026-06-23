# Proposal: Public API + MCP server

**Status:** Proposal (suggestion, not committed) · **Serves:** Bring your own tools
& agents · **Rough size:** Large — splittable into two PRs (API, then MCP)

## Problem

The vision is that team members use *their own* AI tools and agents, and feed
distilled decisions back into the shared context. For that to work, something
outside teamctx — a Claude Code session, a Cursor agent, a custom script — needs
a dependable way to **read** the team context and **write** contributions to it.

Today the HTTP endpoints exist but aren't a stable, documented contract, and
there's no way for an AI agent to call teamctx through a standard protocol.

## What exists today

- `api/contribute.js` — accepts a web contribution.
- `api/context/[role].js` — returns a role's context file.
- `api/ask.js` — answers a question against the context (added recently).
- `vercel.json` rewrites map `/contribute` and `/context/:role` to those handlers.
- No version prefix, no documented request/response schemas, no auth story.

## Suggested approach (one way to do it)

### Part A — a stable, versioned HTTP API

1. Namespace endpoints under `/api/v1/...` and document each one (a short
   `docs/api.md` or OpenAPI file) with exact request/response JSON.
2. Cover the core verbs an external tool needs:
   - `GET /api/v1/context/:role` — fetch a role's compiled context
   - `GET /api/v1/context` — fetch the full why/what/how tree
   - `POST /api/v1/contributions` — submit a contribution (enters the approval
     queue once that proposal lands — see
     [manager-approval-queue](manager-approval-queue.md))
   - `POST /api/v1/ask` — ask a question against the context
3. Keep response shapes stable; additive changes only within `v1`.

### Part B — an MCP server

4. Build an [MCP](https://modelcontextprotocol.io) server that exposes teamctx as
   tools any MCP-aware agent can call: `get_context`, `get_role_context`, `ask`,
   `submit_contribution`. Implement it as a thin wrapper over the v1 API so there's
   one source of truth.
5. Document how to point Claude Code / other MCP clients at it.

## Scope

**In:** the `/api/v1` surface + docs, the MCP server wrapping it, tests for request
validation and response shape.

**Out (note as follow-ups):** a full auth/permissions model (see open questions),
rate limiting, websockets/streaming.

## Where to start

- The two parts are independent PRs. **Part A first** — the MCP server depends on it.
- Read the existing `api/*.js` handlers; the v1 versions can reuse most of their logic.

## Open questions

- **Auth:** the read endpoints are currently open. Writing (contributions) and any
  per-team data will need an auth model — token? Tie into the approval-queue roles?
  Worth a Discussion before Part A's write endpoints are finalized.
- Should the MCP server be published as its own npm bin, or shipped inside `teamctx`?
