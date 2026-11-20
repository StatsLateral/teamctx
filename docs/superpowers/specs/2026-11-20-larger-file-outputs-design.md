# Files larger than the current caps (#251)

Status: decided — building A + B + C. Built on `feat/request-upload-url`
(#257, PR #328), whose ticket and save paths C reuses, so this lands stacked on
that branch and rebases onto main once it merges.
Issue: #251 (enhancement, Post-MVP). Builds on the file-outputs MVP
(`docs/superpowers/specs/2026-11-02-task-file-outputs-design.md`, #244–#247) and
relates to the upload-by-URL work (#257, PR #328).

#251 is deliberately a *decision* issue — "decide whether anything better is
needed". The decision taken: lift the ceiling properly rather than only
document it. The options below are kept as the rationale; the **Decision**
section records what is being built and how.

## The caps today, and why they are where they are

| Path | Cap | Set by |
| --- | --- | --- |
| CLI `teamctx task attach` | 10 MB | our own constant; writes to the repo via local git |
| Project page upload | 4 MB | the hosted function's request-body limit |
| `request_upload` URL (#257) | 4 MB | same hosted-function limit |

The storage itself is **not** the ceiling. Bytes are committed through GitHub's
Git Data API (`writeBytes` stages a Buffer; `commit` base64-encodes it to
`git/blobs`, then `git/trees`, then `git/commits`). GitHub accepts blobs far
larger than 4 MB that way. The real wall on the two hosted paths is that the
bytes must first pass **through the Vercel serverless function**, whose request
body is capped at ~4.5 MB. The CLI has no such wall — it writes locally and
pushes — which is why its cap is already 10 MB.

So "lift the 4 MB limit" is really "get more than 4.5 MB of bytes to where we can
commit them, without routing them through the function body."

## Hard constraint to be honest about

There is **no anonymous direct-to-GitHub upload**. GitHub offers no signed,
expiring upload URL the way S3 does; writing to the repo needs a credential. So
"direct-to-GitHub upload from the page" (an open question in the issue) can't be
done by handing the browser or sandbox a target to PUT to — not without exposing
the project's write credential to the client, which we will not do. That rules
out the simplest reading of the issue's own suggestion.

That leaves three real ways to carry >4.5 MB on a hosted path, plus the option of
not carrying it at all.

## Options

### A. Keep the guidance; sharpen the message (no new ingest)

The MVP already refuses an oversize file with a message pointing to a cloud
folder, a part of the file, or a summary, and `task_attach_link` records a cloud
file by reference with no copy and no size limit. For most "large file" cases
(a 30 MB video, a 200 MB dataset) the right home is the cloud tool, not the git
repo — putting big binaries in git is itself a smell. This option accepts the
4 MB hosted cap as correct and just makes the refusal more helpful (name
`task_attach_link`, name the CLI, say the exact size over).

- Cost: tiny. Risk: none. Aligns with "do not build a file store."
- Leaves the real pain (a web agent that generated an 8 MB PNG and has nowhere
  local to put it) unsolved on hosted.

### B. Raise the CLI cap (small, real, unblocked)

The CLI writes via local git, so its 10 MB cap is ours to choose. Raise it to a
GitHub-aligned limit (GitHub warns at 50 MB and hard-refuses a single file over
100 MB on push — to confirm exact numbers at build), with a clear warning as the
file gets large and a reminder that it lands in git history forever. A developer
attaching a larger deliverable from the command line is a genuine case this
serves cheaply.

- Cost: small. Risk: low (git-history bloat; mitigated by the warning).
- Does nothing for the hosted / web-agent path, which is the product's target.

### C. Transit buffer for hosted uploads (the only way to lift the hosted cap)

To accept >4.5 MB on a hosted path the bytes must land somewhere other than the
function body, then be moved into the repo server-side:

1. the client asks our function for a short-lived client-upload token (the same
   shape as the `request_upload` ticket in #257);
2. the client uploads the bytes **directly to a blob store** (for example Vercel
   Blob, which exists on our platform and supports client uploads that bypass the
   function-body limit) — not through our function;
3. our function is notified, fetches the bytes from the blob store, runs the
   same `validateFileOutput` → commit path, and **deletes the blob** (it is pure
   transit, not a second home for the file).

This genuinely lifts the hosted cap (to whatever GitHub will take) and is the
only option that helps the web-agent case. But it adds a dependency (Vercel
Blob or equivalent) and more moving parts, and sits close to the "do not build a
file store" line — defensible only because the blob is transit and deleted. It
also needs the #257 upload path to exist, so it should land **after** PR #328.

- Cost: medium–high (new dependency, notify/fetch/delete flow, failure cleanup).
- Risk: the dependency, and big binaries in git history (same smell as A/B).

### D. Git LFS (for genuinely large binaries)

Store large files as LFS pointers. Removes the git-bloat problem, but needs LFS
storage/quota (billed on GitHub), changes how clones behave, and still needs one
of A–C to get the bytes in. Heaviest option; recommend only if a concrete need
for very large files appears.

## Decision — what is being built

A **+ B + C**. The web-agent large-file case (an 8 MB file generated in a
sandbox, no local disk to fall back to) is the product's own target, so the
hosted ceiling is lifted, not just explained.

- **A — sharpened messages.** The CLI, page and `request_upload` refusals name
  the alternatives (a cloud link via `task_attach_link`, the command line) and
  state the size over.
- **B — CLI cap 10 MB → 50 MB**, GitHub-aligned (it warns at 50 MB and refuses a
  single file over 100 MB on push), with a caution past 25 MB that the file sits
  in history for good. `MAX_OUTPUT_FILE_BYTES`.
- **C — transit blob for hosted uploads.** `request_upload` for a file over the
  4 MB direct cap (up to `hostedUploadMaxBytes`, default 25 MB) mints a
  short-lived Vercel Blob *client token* bound to one unguessable path, and
  returns the Blob ingest URL + headers for the sandbox to PUT to, plus a
  finalize URL. The sandbox PUTs the bytes straight to Blob (around the 4.5 MB
  function body), then POSTs finalize; the server fetches the bytes back,
  validates and commits them on the same `saveFileOutput` path, and deletes the
  blob (one-day TTL backstops an abandoned upload). `src/oauth/blob-transit.js`;
  the finalize route in `api/oauth-server.js`; the `blob` transport on upload
  tickets.

**Transport choice.** Vercel Blob was chosen over an S3/R2 presigned URL because
the deployment already runs on Vercel — a blob store is one provisioning step,
no new account. The cost is that the sandbox PUT uses Blob's internal upload
headers (`x-api-version: 13`, store id, request id), which teamctx emits in the
`reportBack` curl; these are pinned and verified against the installed
`@vercel/blob`, and are the one thing to re-check on a major `@vercel/blob`
bump. A single PUT is assumed to carry 25 MB; if the ingest rejects it,
multipart (parts ≥ 5 MB) is the fallback and the live E2E will catch it.

**Deployment prerequisites** (maintainer/account actions, not code): a Vercel
Blob store on the project with `BLOB_READ_WRITE_TOKEN` set; and the web agent's
allowed-websites list must include both the teamctx host and `vercel.com` (the
Blob ingest). Without the token, `request_upload` degrades cleanly — large files
are refused with a pointer to a cloud link or the CLI.

## Recommendation (original, superseded by the Decision above)

Scope #251 to **A + B**, and write C up as a deliberate *decision for a
maintainer*, not a default build:

1. **A — sharpen the oversize message** on both hosted paths (page and
   `request_upload`) so it names `task_attach_link` and the CLI and states the
   size over. Small, safe, immediately better.
2. **B — raise the CLI cap** to a GitHub-aligned limit with a warning near the
   danger zone.
3. **C — do not build now.** Record it as the only path that lifts the hosted
   cap, with its dependency and tradeoffs, so the maintainer can choose it
   deliberately if the web-agent large-file case proves common. It also depends
   on #257 merging first.

This keeps teamctx out of the file-store business (as the issue asks), delivers a
real improvement, and names the one bigger lever clearly instead of quietly
taking on a dependency. If you'd rather commit to lifting the hosted cap now,
say so and I'll scope C as the build (timed after #328).

## Out of scope

- Previewing or diffing large files (#249, #253).
- The `request_upload` mechanism itself (#257 / PR #328).
- Any permanent second store for files.

## Testing (for whatever scope you pick)

- A/B: unit tests on the new limits and messages; a CLI attach at just under and
  just over the raised cap; the hosted refusal naming the alternatives.
- C (if chosen): the client-upload-token flow, the fetch-commit-delete transit,
  failure cleanup (blob deleted on a failed commit), and a live end-to-end on the
  fork uploading a >4.5 MB file that the 4 MB path rejects.

## Relates to

`docs/superpowers/specs/2026-11-02-task-file-outputs-design.md`; #257 (PR #328),
#256 (CLI batch attach), #253 (version diff), #248 (cloud-file staleness).
