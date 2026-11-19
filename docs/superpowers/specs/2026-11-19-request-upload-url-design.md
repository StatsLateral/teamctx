# Upload a file output by short-lived URL, without token cost (#257)

Status: proposal, awaiting review.
Issue: #257 (enhancement, Post-MVP). Builds on the file-outputs MVP
(`docs/superpowers/specs/2026-11-02-task-file-outputs-design.md`, #244–#247).

## The problem

A person working in a chatbot may produce dozens of files — marketing images,
a spreadsheet, a report. Today the only ways to make one a task output are:

- the **project page**, where a member picks a file and posts it (≤ 4 MB,
  through the hosted function); or
- the **command line** (`teamctx task attach`), which writes to the repository
  directly (≤ 10 MB).

Neither helps an assistant working inside a hosted chatbot. There is **no MCP
tool that carries file bytes**, and on purpose: bytes in a tool call are tokens,
so a handful of images would cost more than the work that made them. The file
the assistant just generated has to be downloaded by the person and re-uploaded
through the page, by hand, one at a time.

## What this builds

An MCP tool, `request_upload`, that hands back a **short-lived, single-use
upload URL** scoped to one task, one person and a size cap. The chatbot's own
code sandbox sends the bytes there directly (for example with `curl`); the
bytes never pass through the model, so they cost no tokens. The upload then runs
through the **same** size limit, type sniffing, name-safing and scope rules as
every other file output, and is recorded as an ordinary output on the task.

This is the inbound equivalent of the download route: the page already lets a
file *leave* teamctx without going through a model; this lets one *arrive* the
same way.

### Flow

1. The assistant (as the signed-in member, over the hosted MCP connection)
   calls `request_upload` with the task id and the file's name and size.
2. teamctx checks the member may add to that task (same scope gate as
   `attachFileOutput`), that the task is not already accepted, and that the
   declared size is within the cap. It mints an opaque ticket, stores only its
   hash with a short TTL, and returns the absolute upload URL and its expiry.
3. The sandbox `PUT`s (or `POST`s) the raw bytes to that URL. No sign-in cookie,
   no bearer token: the ticket in the URL is the authority, which is why it is
   single-use and short-lived.
4. The endpoint looks up the ticket, enforces the cap again from the actual
   byte count, runs `validateFileOutput`, stores the file through the existing
   `saveFileOutput` path, deletes the ticket, and returns the output id.
5. `request_upload` returns in step 2 are enough for the assistant to report
   "uploaded" to the person without ever holding the bytes.

## Why no new signing library

The issue flags signed, expiring URLs as a standard pattern and asks to reuse a
library rather than write the signing. teamctx already has exactly the right
primitive and needs no new dependency:

`src/oauth/agent-tokens.js` mints an opaque `randomBytes(32)` token, stores only
its **sha-256 hash** in KV, and verifies by hashing the presented token. KV
(`kvSet(key, value, { ttlSeconds })`, Upstash/Vercel REST over `fetch`) gives:

- **expiry** — the ticket key carries a TTL (proposed: 10 minutes), so it is
  gone whether or not it is used;
- **single use** — the endpoint `kvDelete`s the ticket the moment it consumes
  it, so a replay finds nothing;
- **no secret in the URL** — only the hash is stored, so a leaked KV backup
  yields nothing that works, same as agent tokens.

A JWT/HMAC scheme (`jsonwebtoken`) would add a dependency and a stateless token
we could not revoke or spend once; the stored-hash + TTL + delete pattern is
strictly better for a single-use ticket and is already in the codebase.

## Pieces

- **`src/oauth/upload-tickets.js`** (new): `createUploadTicket({ owner, repo,
  taskId, member, declaredName, declaredSize, maxBytes })` → `{ url-less record,
  token }`; `consumeUploadTicket(token, { owner, repo })` → the record, deleting
  it; built on the `agent-tokens.js` hash-and-store shape. Key:
  `keys.uploadTicket(hash)` with a `UPLOAD_TICKET_TTL_SECONDS` TTL.
- **MCP `request_upload`** in `mcp/server.js`: new tool beside `task_output` /
  `task_attach_link`. Runs as the calling member; resolves the task, applies the
  scope and not-accepted checks, rejects a declared size over the cap or a name
  whose extension is not an allowed output type (a cheap pre-check so a doomed
  upload is refused before any bytes move), mints the ticket, and returns the
  absolute URL (built from the request's base URL) plus `expiresAt` and the cap.
- **Upload endpoint** in `api/oauth-server.js`:
  `PUT /project/:owner/:repo/task/:taskId/upload/:ticket`. Reads the body under a
  hard byte cap (same bounded-read discipline as `readUpload`), consumes the
  ticket (404/410 if missing or expired; refuses a ticket whose owner/repo/task
  do not match the path), then `validateFileOutput` → `saveFileOutput` with
  `source: 'web'` and the ticket's member as actor. Returns JSON `{ outputId }`
  or a `FileOutputError` message.
- **Size cap.** The hosted function body limit (4.5 MB) still applies to this
  endpoint, so the cap is `MAX_PAGE_UPLOAD_BYTES` (4 MB), the same as the page.
  Lifting it needs direct-to-GitHub upload, which is #251 and out of scope here.
- **Docs**: `docs/agents.md` / the file-outputs section — how an assistant
  uploads a generated file without token cost; one worked `curl` example.

## Decisions taken (flagged for review)

- **Cap = 4 MB** (page limit), not 10 MB. The bytes still land on the hosted
  function, which rejects a body over 4.5 MB, so a larger cap would fail at the
  edge, not in our code. Bigger files stay a #251 concern.
- **One file per ticket, one ticket per `request_upload` call.** Matches the
  page (one output at a time) and keeps single-use simple. A batch of N files is
  N calls; the token cost of N small `request_upload` calls is still far below
  carrying one file's bytes.
- **TTL 10 minutes.** Long enough for a sandbox to fetch-and-send, short enough
  that a leaked URL is stale fast. Open to a different number.
- **Ticket in the path, not a query string.** A URL with a secret in the query
  can land in logs and referrers; the path segment is the lesser evil, and the
  ticket is single-use and short-lived regardless.
- **Pre-check the declared type at `request_upload`.** Refusing a `.exe` or a
  10 MB declared size before minting a ticket saves a round-trip; the real
  check is still `validateFileOutput` on the actual bytes, which is
  authoritative (a lying `declaredSize` or renamed file is caught there).

## Open questions (from the issue, for review)

- **Which chatbots can reach our server from their sandbox?** This is the sibling
  spike #258. It does not block the build — the endpoint works for any sandbox
  with outbound network (Claude's code tool among them) — but it decides how
  useful the feature is in practice and what the docs should claim. Proposed:
  build the endpoint, document it for a sandbox with network egress, and let
  #258 report the per-platform matrix separately.
- **`PUT` vs `POST` multipart.** A raw `PUT` of the bytes is simplest for a
  `curl` one-liner and needs no multipart parse; the page uses multipart because
  a browser form posts that way. Proposed: raw `PUT` with the file name taken
  from the ticket (so the name is fixed at `request_upload` time, not re-declared
  by the uploader). Alternative: accept both.
- **Should a declared-size pre-check be mandatory?** If `request_upload` does not
  require `declaredSize`, the cap is only enforced on the bytes, which is still
  safe but wastes a round-trip on an oversize file. Proposed: optional, used for
  the pre-check when given.

## Out of scope

- Direct-to-GitHub upload to lift the 4 MB cap (#251).
- Batch attach from a folder on the CLI (#256).
- The platform file-reference survey (#258).
- Diffing an output against its earlier version (#253).

## Testing

Unit: ticket mint/consume/expire/replay (`upload-tickets`), the MCP tool's scope
and not-accepted refusals, the endpoint's cap, ticket-mismatch and
expired-ticket paths, and that a valid upload produces an output identical in
shape to a page upload.

End-to-end (done by the developer against the fork, before any PR): from a
chatbot connected to a live test project, call `request_upload` for a task,
`curl` a real PNG to the returned URL, confirm the output appears on the task
page and downloads byte-for-byte; confirm a second `curl` to the same URL is
refused; confirm a URL left unused for over the TTL is refused; confirm a file
over 4 MB and a disallowed type are both refused with a clear message.

## Relates to

`docs/superpowers/specs/2026-11-02-task-file-outputs-design.md` (the MVP this
extends); #258 (platform survey), #251 (large files), #256 (CLI batch),
#253 (version diff).
