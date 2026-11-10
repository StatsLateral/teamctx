# Telling a manager when a linked cloud file changed after it was approved

**Date:** 2026-11-10
**Status:** Proposal; pending review
**Builds on:** [files as task outputs](2026-11-02-task-file-outputs-design.md) (#244–#247), [connected sources](../../proposals/connected-sources.md) and its per-tool proposals for Google Drive, SharePoint/OneDrive and Dropbox (#171–#173)
**Issue:** #248

## Problem

A link output records a file that lives in a connected tool — a deck in SharePoint, a sheet in
Drive — without copying it. At submit time it keeps a **version marker** (`link.version`): a
revision id, an ETag, a modified time, whatever the tool gave. The manager approves that version.

But the file keeps moving. Someone edits the deck the day after it was approved. The project now
says "approved", the task is closed, and the thing it points at is no longer the thing anyone
reviewed. Nobody is told. The file-outputs design named this a non-goal on purpose ("Detecting
that a linked file changed after approval") and left it for here.

The ask is narrow: compare the version that was approved with the file's current version, and
show **"changed since approved"** on the task and in the review drawer.

## Goals

1. When a linked file's current version differs from the version that was approved, the task and
   the review drawer **say so**, in plain words, with roughly when it was last checked.
2. Reuse what the connectors already know about versions (#171–#173). **No new client**, no new
   credential store.
3. Be honest about reach: where a file cannot be checked (a title-only sharing link, or nobody
   connected can read it), say "can't check", never a false "unchanged".

## Non-goals (this version)

- **Reopening review automatically.** A change raises a flag; it does not undo an acceptance.
  Reopening stays a manager's deliberate act (the existing `task_reopen`).
- **Live, on-page checking.** The page shows the last computed status; it does not call the tool
  while the manager watches.
- **Watching for changes / push notifications.** The check runs when the assistant runs it, not
  on a timer or a webhook.
- **File outputs** (uploaded bytes). Those are immutable in the repo; only links can drift.
- **Diffing the file** or saying *what* changed — only *that* it changed.

## The crux: who holds the credential

teamctx copies nothing and **holds no credential for a linked file**. The hosted page renders the
task for a manager who may not even have access to the file. So the check cannot happen on the
page. Two models were weighed:

| | Page-side live check | Assistant-side check *(chosen)* |
|---|---|---|
| Who calls the tool | Hosted server | The assistant, via the member's existing connector OAuth |
| Credential | None exists; would need a new per-file token store | Already held (#171–#173) |
| Manager needs file access | Yes (often false) | No — whoever ran the check needed it |
| Fits teamctx's model | No | Yes — "the assistant is where work is done" |

**Decision:** the assistant checks; the page displays. This is the answer to the issue's first
open question. The assistant reads the current version through the connector it already has,
compares it to the approved marker, and **writes the result back** as a small status on the
output. The page then renders a stored fact and needs no credential of its own.

## Design

### 1. Snapshot the approved version

When a link output is accepted, record the marker that was approved alongside the acceptance:
`approvedVersion`, the `connector`, and the reference needed to find the file again (`url` /
`itemId`). The marker already exists on the output (`link.version` from #245); this persists
*which* version the acceptance blessed, so a later check has something to compare against.

### 2. A per-connector "current version for this reference"

Each connector already fetches a file's metadata — Google Drive returns `modifiedTime`, Dropbox a
`rev`, Microsoft 365 an eTag/cTag — through the same `fetch`/`list` paths used at import
(`FILE_FIELDS` on Drive, etc.). Add one thin helper per connector, `currentVersion(auth, ref)`,
that returns the same kind of marker `link.version` holds, reusing those fields. No new API
client; this is the "existing open source first" the issue asks for.

### 3. An assistant-run check that stores a status

A new MCP tool — `task_check_links` (or folded into `get_task`'s refresh) — for each link output
on a task whose reference is resolvable and whose connector the caller can reach:

- reads `currentVersion`,
- compares it to `approvedVersion` (or to `link.version` for a not-yet-approved output),
- writes back a status: `{ state: 'unchanged' | 'changed' | 'unknown', observedVersion, checkedAt }`.

`unknown` is first-class: a title-only sharing link (we dropped its URL in #245), or a file the
caller's connector cannot read, yields `unknown` with a reason — never a guessed "unchanged".

### 4. The page displays the stored status

The task row and the review drawer render the last stored status, the way #244 renders the output
itself — a one-line badge: **"changed since approved · checked 2d ago"**, or "can't check (no
stored reference)". Pure render of a stored fact; no live call, no credential on the page.

### 5. What a change does — flag only (the issue's second open question)

A change **flags**; it does not reopen. An acceptance closes a task for good by design (#247), and
silently reversing that would fight the model and surprise everyone on the task. Instead the
drawer offers the manager a one-step prompt to `task_reopen` and review the new version — their
call, made deliberately. v1 ships the flag and the surfacing; reopening reuses the path that
already exists.

## What this cannot do (stated plainly)

- **Title-only sharing links** have no resolvable reference (we refuse to store the tokenised URL
  in #245), so they can only ever be `unknown`.
- The check needs **someone with a connector that can read the file** to run it; if nobody
  connected has access, the status stays `unknown`.
- The status is **as of the last check**, not real-time — there is no page-side credential to make
  it live, and that is the honest limit of a copy-nothing design.

## Rough shape of the work

| Piece | Size | Notes |
|---|---|---|
| Persist `approvedVersion` at acceptance | small | extends the acceptance record |
| `currentVersion(auth, ref)` per connector | medium | reuses existing fetch/list fields; gdrive, m365, dropbox |
| `task_check_links` MCP tool + status record | medium | scope-checked like other task writes |
| Task-row + drawer badge | small | mirrors #244 render work |
| Tests (status states incl. `unknown`, per connector) | medium | no new dependencies |

No new runtime dependencies. No new credential storage.

## Is it doable?

Yes — scoped. The hard part is not the comparison; it is that the page has no credential, which the
assistant-side check resolves cleanly and in keeping with how teamctx already works. The honest
boundary is that it covers link outputs with a resolvable connector reference, checked by someone
who can read the file, and reports `unknown` everywhere else rather than pretending.
