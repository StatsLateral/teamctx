# Make a failed Claude connection diagnosable and easier to recover from (#285)

## The problem

Connecting teamctx from Claude is the step every new member goes through, and
when it fails it fails silently. A rostered member hit
`invalid_request_error: Method Not Allowed`; disconnecting and reconnecting
fixed it, but nothing in the logs said why. The server side records almost
nothing useful:

- `POST /token` is handled entirely by the MCP SDK's `mcpAuthRouter`
  (`api/oauth-server.js`), so a 400 (e.g. `invalid_grant` on a stale code) goes
  back to the client with **no teamctx log line** behind it.
- The MCP endpoint (`api/mcp/[owner]/[repo].js`) returns 401s with good reasons
  and a `bad_url` 400, but any 4xx the SDK transport itself produces during the
  handshake is **not logged** with a reason.
- `GET /api/mcp/...` returns **405 with a JSON body** — allowed by the MCP spec
  and seen on healthy connections too, so it is indistinguishable from a real
  failure in the logs.

A non-technical member stops at the first error.

## What exists now

| Piece | State |
|---|---|
| OAuth endpoints (`/authorize`, `/token`, `/register`, `/revoke`) | from the SDK's `mcpAuthRouter`; teamctx logs none of their 4xx |
| MCP endpoint 401s | present, with actionable reasons (`unauthorized(...)`) |
| MCP endpoint 400 | only `bad_url`; SDK-transport 4xx not logged |
| GET `/api/mcp/...` → 405 | intentional, carries build info; benign but looks like a failure |
| `/oauth/status` | deployment health only (OAuth/KV/build) — **unauthenticated**, so no roster/project data |
| A reference a stuck member can quote | **absent** |
| "Connection failed" recovery docs | **absent** |

## Proposal

The core move is to make a failed connect **readable from the logs** without
ever logging a secret, and to give a stuck member something to quote.

1. **Log the reason for every OAuth and MCP 4xx**, as a short machine code plus
   which step it was and a short request id — never a token, code, email or any
   secret. For the SDK-owned OAuth routes this is response-capturing middleware
   around `mcpAuthRouter` that reads the `error` field the SDK already puts in
   the JSON body (`invalid_grant`, `invalid_client`, …) and logs
   `connect: /token <code> [req <id>]`. The MCP endpoint logs its own 4xx the
   same way.
2. **Return a short request id to the client** in the error body, so a member
   who is stuck can quote it and it can be matched to the log line. It is a
   random id, tied to nothing personal.
3. **Tag the GET-405 as benign in the logs** (or omit it), so a real failure is
   no longer lost among healthy probes. The 405 behaviour itself is left
   exactly as it is — the spec allows it and clients rely on it.
4. **A short "Connection failed?" section in the connect docs**: disconnect and
   reconnect first, and what each error code means in one line.
5. **Reproduce the handshake with a standard MCP client** (the MCP Inspector) to
   decide whether the original failure was the 405-on-GET, a stale token, or a
   half-finished sign-in. This is investigation to confirm the cause; the GET
   behaviour is not changed before that is known.

## Carefully, or deferred

- **A manager-facing roster/access check (issue item 4).** Useful — confirm a
  member is on the roster and the project lends GitHub access — but it must be
  **authenticated and manager-gated**, because that data is private. It does
  **not** belong on the public `/oauth/status`. Proposed as a small follow-on on
  the already-authenticated settings/project surface rather than part of this
  change, unless wanted now.

## Not in this issue

Changing the 405 behaviour; keeping longer hosted log history (a platform
setting); any new credential path.

## Existing open source first

The OAuth behaviour to compare against is the MCP TypeScript SDK's
`mcpAuthRouter`; the MCP Inspector reproduces a client handshake and shows the
exact response at each step. What only teamctx builds is the logging around
those responses and the recovery docs.

## What changes for the end user

- **Happy path: nothing.** No new step, no behaviour change when a connect works.
- **When a connect fails:** the error carries a short reference id, and the docs
  say to disconnect/reconnect and what the error means — so a non-technical
  member has a next step instead of a dead end.
- **For whoever runs the server:** a failed connect now leaves a log line with
  the reason and that reference id, so it can actually be diagnosed. No token,
  code, email or secret is ever logged.

## Reproduction finding (issue item 3)

Reproduced the handshake against the server run locally, driving the real routes:

- `POST /token` with a bad grant → `400 invalid_client`; the body carries
  `request_id`, and one line is logged: `connect: /token failed (400
  invalid_client) [req_…]`. No code or secret in the log.
- `GET /api/mcp/<owner>/<repo>` → `405`, and **no** failure line. This 405 is
  emitted on healthy connections too (the client probes for an SSE stream the
  server does not offer), so it is benign — it is not the fault, and its
  behaviour is left unchanged, as the issue instructs.
- `POST /api/mcp` with no credential → `401`; body carries `request_id`, and
  `connect: POST /api/mcp failed (401 unauthorized) [req_…]` is logged.

So the original `Method Not Allowed` the member saw lines up with the benign
GET-405 surfaced during a transient/stale-session state — not a real server
fault — which is why a clean reconnect fixed it. The value of this change is
that the *next* such failure leaves the actual failing step and reason in the
log, tied to an id the member can quote. The GET behaviour is deliberately not
changed.

## Acceptance

- A failed `/token` or MCP request leaves a log line naming the step and the
  reason code, with a request id, and never a secret.
- The error body a client receives carries that same request id.
- A healthy GET-405 probe is distinguishable in the logs from a real failure.
- The connect docs have a short, plain recovery section.
- The 405-on-GET response is unchanged.
