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

## The crux: who holds the credential, and where can code run

Everything turns on one fact: to know a file's *current* version, something has to call the tool,
and that call needs a credential and a place to run. So before choosing a design, here is the
ground truth of what teamctx has today.

**Where connector credentials live.** A member runs `teamctx auth <connector>` once; it writes the
tool's refresh token to a local env file (mode `0600`) on *their own machine*. The hosted
deployment's secret store holds AI-provider keys and a lent GitHub credential — and **nothing
else**: no Google, SharePoint or Dropbox token is ever stored server-side. So the only place a
connector credential exists is where the member's CLI or assistant runs.

**Where code can run.** Three surfaces, not two:

- The **hosted page** (`api/oauth-server.js`): renders per request, holds no credential for any
  linked file.
- The **assistant/MCP** on the member's machine: holds that member's connector token.
- An **agent** (`docs/AGENTS.md`): an unattended job — cron, workflow, any MCP client — that
  reaches the project through the hosted connector with a manager's token. This is the "scheduler"
  I first said did not exist.

But the agent surface does not help here, for a telling reason: an agent is handed exactly three
tools (`my_brief`, `contribute`, `task_done`) and **no cloud-connector credential**. It can read
the project and send work back; it cannot open a Drive or Dropbox file. So the blocker was never
the absence of a scheduler — teamctx has unattended execution. The blocker is that **no unattended
surface holds a cloud credential.** That is the whole problem in one sentence.

**Three more constraints the code imposes** (each checked, each shaped this design):

1. *The version marker is freeform.* `saveLinkOutput` stores whatever string the assistant passed
   as `version`; it never asks the connector for its native marker, though it has the connector
   name in hand. A stored `"v3"` is not comparable to a Drive `modifiedTime`. **So a machine
   version must be captured from the connector at attach time**, or the comparison is meaningless.
2. *Outputs are write-once.* An output file "is written once and never changed" (`storage.js`), on
   purpose — it is the reviewed artifact. **A computed staleness status cannot live on the output;
   it needs its own mutable store.**
3. *The checker is not the viewer.* The connector token sits on the submitter's machine. The
   manager who opens the task or the review drawer usually has neither that token nor access to the
   file. **So a check can only be run by someone with access — normally the submitter — and cannot
   happen at the moment the manager looks.** This is the real limit, and it is what separates the
   version we can build now from the version the issue imagines.

### Every option, against that reality

| Option | Who reads the version | Works today? | What building it would take | Verdict |
|---|---|---|---|---|
| **A. Assistant checks on demand** | Assistant, via the member's local connector token | **Yes** | A per-connector `currentVersion` helper + an MCP tool that stores the result | **Build this** |
| **B. Page checks live on render** | Hosted server | No | Store every member's connector refresh token in the hosted KV, add server-side OAuth + refresh per provider, and use the submitter's token for a background read they didn't trigger | Reject — large new credential subsystem + consent/privacy cost, for a low-priority flag; cuts against "copy nothing" |
| **C. Scheduled re-check** | A cron job | No | Everything in B, **plus** a scheduler teamctx does not have (e.g. Vercel Cron) and job/state management | Reject — biggest build, depends on B |
| **D. Provider push (webhooks/watch)** | Provider calls us | No | Everything in B, **plus** public subscription endpoints, renewal, and per-file watch management | Reject — real-time but wildly disproportionate |
| **E. Submitter's assistant checks when it next touches the task** | Assistant that has the token (the submitter's) | **Yes** | One extra line in the task prompt + the helper from A | The realistic **trigger** for A |
| **E′. Submitter schedules the check on their own machine** | A cron on the submitter's machine, using their local token | **Yes** (member sets it up) | The helper + tool from A, run on a schedule the member owns; no hosted token store | Document as an opt-in for someone who wants semi-automatic post-approval detection without B |
| **F. Human re-submits** | Nobody; the member notices | Yes | Nothing | Fallback only — detects nothing |

**Decision.** The credential exists only on the assistant surface, so that is where the check runs
(A), triggered when the person who has the token — the submitter — next works the task (E), with
the result written to a mutable status store the page then renders as a badge. The page displays a
stored fact and needs no credential of its own. This answers the issue's first open question.

But be honest about what that gives: because the checker is the submitter and the viewer is the
manager (constraint 3 above), this is an **on-demand** check — "as of the last time someone who can
see the file looked", not drift noticed the moment it happens, nor a fresh check when the manager
opens the drawer. That weaker promise is the true ceiling of what teamctx can do today without
storing credentials.

The fuller vision — the manager opens the task and *it checks for them* — is option B, and it is
not impossible: it needs a hosted store of members' connector refresh tokens, server-side OAuth and
refresh per provider, and the server using the submitter's token for a read the submitter did not
initiate. That is a real subsystem and a real consent question, for a flag the issue files as
low-priority, and it cuts against teamctx holding no credential for linked files. This design does
not build B; it names it so the maintainer can decide whether view-time detection is worth that
cost later. C and D (scheduling, webhooks) sit on top of B and are further still.

## Design

### 1. Capture a machine version at attach time (the enabler)

Today `link.version` is a freeform string the assistant typed — not comparable to anything a
connector returns. So the attach step (`saveLinkOutput`, `task_attach_link`) gains a second,
machine field: `link.versionKey`, the connector's own marker read at attach time
(`currentVersion`, §2). The human `version` stays for display; `versionKey` is what a later check
compares. If the connector cannot be reached at attach, `versionKey` is null and the output simply
cannot be staleness-checked — stated, not faked. This runs on the submitter's surface, where the
token is, which is exactly where attach already runs.

### 2. A per-connector "current version for this reference"

Each connector already fetches a file's metadata — Google Drive `modifiedTime`, Dropbox `rev`,
Microsoft 365 eTag/cTag — through the same `fetch`/`list` paths used at import (`FILE_FIELDS` on
Drive, etc.). Add one thin helper per connector, `currentVersion(auth, ref)`, returning that native
marker. No new API client; this is the "existing open source first" the issue asks for.

### 3. Snapshot the blessed version at acceptance

When a link output is accepted, record `approvedVersionKey` (the `versionKey` as it stood at
acceptance) on the acceptance record, so a later check compares against *what was approved*, not
against the latest attach.

### 4. An assistant-run check that writes to a mutable status store

Outputs are write-once, so the status cannot live on the output. It lives in its own namespace —
`checks/<taskId>/<outputId>.json`, one file per output, overwritten each check (these are *meant*
to change, unlike outputs). A new MCP tool — `task_check_links` — for each link output on a task
whose `versionKey` exists and whose connector the caller can reach:

- reads `currentVersion`,
- compares it to `approvedVersionKey` (or to the output's own `versionKey` before acceptance),
- writes `{ state: 'unchanged' | 'changed' | 'unknown', observed, checkedAt, by }`.

`unknown` is first-class: a title-only sharing link (we dropped its URL in #245), a null
`versionKey`, or a file the caller's connector cannot read — each yields `unknown` with a reason,
never a guessed "unchanged".

The realistic trigger is the **submitter's** task prompt (§E): the submitter holds the token, so
their assistant runs the check when they next work the task. The manager's review prompt does *not*
run it — the reviewer usually cannot read the file.

### 5. The page displays the stored status

The task row and the review drawer render the last stored status, the way #244 renders the output
itself — a one-line badge: **"changed since approved · checked 2d ago"**, or "can't check (no
machine version was recorded)". Pure render of a stored fact; no live call, no credential on the
page. Because the check is on-demand, the badge always carries *when* it was last checked, so a
manager never mistakes "not checked lately" for "unchanged".

### 6. What a change does — flag only (the issue's second open question)

A change **flags**; it does not reopen. An acceptance closes a task for good by design (#247), and
silently reversing that would fight the model and surprise everyone on the task. Instead the
drawer offers the manager a one-step prompt to `task_reopen` and review the new version — their
call, made deliberately. v1 ships the flag and the surfacing; reopening reuses the path that
already exists.

## What this cannot do (stated plainly)

- **Title-only sharing links** have no resolvable reference (we refuse to store the tokenised URL
  in #245), and anything attached before `versionKey` existed has none — both can only be `unknown`.
- The check needs **someone with a connector that can read the file** to run it; if nobody
  connected has access, the status stays `unknown`.
- It is **on-demand, not view-time**. The manager does not get a fresh check when they open the
  drawer; they see the last check someone with access ran. The badge always shows *when*, so this
  is visible, not hidden. True view-time detection is option B, and this design does not build it.

## Rough shape of the work

| Piece | Size | Notes |
|---|---|---|
| `link.versionKey` captured at attach | small | extends `saveLinkOutput` / `task_attach_link`; needs the token, runs where attach already runs |
| `currentVersion(auth, ref)` per connector | medium | reuses existing fetch/list fields; gdrive, m365, dropbox |
| `approvedVersionKey` on the acceptance record | small | snapshot at accept time |
| `checks/<taskId>/<outputId>.json` mutable status store | small–medium | separate from write-once outputs |
| `task_check_links` MCP tool | medium | scope-checked like other task writes |
| Task-row + drawer badge (with "checked when") | small | mirrors #244 render work |
| Tests (status states incl. `unknown`, per connector) | medium | no new dependencies |

No new runtime dependencies. No new credential storage.

## Verdict

**Build the on-demand version — it is worth doing and achievable today.** No new dependencies, no
new credential storage: capture a machine version at attach, let whoever has the file open
(normally the submitter) run a check, store it, and show the manager a dated badge. That genuinely
answers "did this change after I approved it?", with an honest "as of when".

**Do not build view-time / automatic detection now.** The deep exploration lands on one fact: *no
unattended surface in teamctx holds a cloud credential* — not the page, not an agent. Giving one a
credential (option B, and C/D on top of it) is a real hosted token store, server-side OAuth per
provider, and a consent question about the server reading a member's file unprompted. That is a
large, privacy-sensitive subsystem for a flag the issue itself files as low-priority. Name it for
the maintainer; do not build it under this issue.

**Not achievable at all:** nothing here. The feature is achievable; only its *fully automatic*
form is gated behind a credential subsystem we are choosing not to build yet.

So: ship the on-demand flag, document E′ (member-scheduled checks) for anyone who wants it more
automatic without B, and leave B written down as the known path to view-time detection.
