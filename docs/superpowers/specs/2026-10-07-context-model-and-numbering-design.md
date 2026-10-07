# Context model: what an agent loads, simple numbering, and an auditable change history

**Date:** 2026-10-07
**Status:** Design agreed in conversation; spec pending review. Not scheduled. All issues are parked (see the repo's `parked` label), so this is direction, not a work order.
**Supersedes:** the visible record keys (`D-1`, `R-2`, `A-3`, `X-1`) and task keys (`T-14`) from the stable-record-keys work (#126/#133), and the key scheme in the [agent-first project view spec](2026-10-04-agent-first-project-view-design.md) (#125) where they conflict.
**Builds on:** the governed-records model (#117), context inheritance (#80), assumption impact (#120/#132), the [goal text](2026-10-07-project-goal-text-design.md), [settings block](2026-10-07-project-settings-block-design.md) and [Waiting on you icons](2026-10-07-waiting-on-you-icons-design.md) specs.

## Problem

Three things are tangled together, and the prototype work in this series exposed
all of them:

1. **What does an agent or person working on one task need to load?** The
   project's context, its workstream's, and the task's own, and nothing from the
   ten other workstreams. Cross-cutting dependencies need a clear home.
2. **Numbering is more complex than anyone can use.** Prefix letters (`T`, `D`,
   `R`, `A`, `X`, `Q`) with separate counters are something to learn. At the scale
   a three-person team reaches in a few months (thousands of records), nobody
   finds a record by its number, and numbers say nothing about whether it is
   current or who approved it.
3. **Governance and auditability is the product.** When a few decisions change,
   and twenty-five other entries are affected, can anyone see what changed,
   where, why, who approved it, and what it touched? In a fifty-page document the
   answer is a text diff that shows that words moved, not why or what depended on
   them.

## Vocabulary

- **Record:** a statement of context that governs the work. Four kinds today:
  decision, rule, assumption, exception. Records belong to the project, a
  workstream, or occasionally a task.
- **Workstream:** a part of the work. Workstreams can nest (Launch contains
  Pricing and Outreach). The prototype shows them flat.
- **Task:** a piece of work to do. A task always lives in a workstream.
- **Change set:** one approved contribution and everything it did.

## Goals

1. A task compiles to exactly the context that applies to it, and says what it
   did not load so nothing is hidden by omission.
2. Numbers are only for workstreams and tasks, are simple (`1`, `3.2`), and are
   stable.
3. Every change to context is recorded with who, when, why, from what source, what
   changed and what it affects, so a person or an agent can trace it the way
   a developer traces a change with `git log` and `git blame`.

## Non-goals

- Visible numbers on records, and a letter-prefix scheme of any kind.
- Automatically discovering dependencies that nobody wrote down (see 3.4).
- Replacing git or the customer's storage; the change history lives alongside the
  context, in the customer's own store.
- A limit on the length or number of records (nothing here rejects text).
- Building the change-log view in the MVP. It is specified here so the open source
  project has the design; the MVP keeps what exists today (section 4.5).

## Design

### 1. What a task loads

For a task at workstream path P (project → ... → its workstream) the compiled context
is, in this order:

1. **The project's context**: the project goal and the active project-level
   records.
2. **Each workstream on the path down to the task's workstream**: their active
   records, outermost first. Nothing from sibling or unrelated workstreams.
3. **The task's own records** (exceptions and the like attached to that task).
4. **Linked items**, read-only and one at a time: a record or task elsewhere that
   this task explicitly points to. The item is loaded, not its whole workstream.
5. **An index of everything else**: one line per workstream outside the path
   (number, name, count of active records, open tasks), plus "ask for more through
   the connector". The agent knows what exists and can fetch it, so "I wasn't shown
   it" can never be mistaken for "there is none".

Scoped members and agents get the same rule, filtered by what they may see. A
workstream a person cannot read appears in the index only as "1 part you cannot
see", never by name.

Active records only: replaced, broken, closed and expired records leave the loaded
set and stay in history. That keeps the loaded context in the tens per workstream
however many thousands exist in total.

### 2. Cross-workstream dependencies live one level up

- A constraint that applies to two or more workstreams belongs to their **nearest
  common ancestor**. If Pricing and Outreach share a rule, it lives on their
  parent, Launch; if two top-level workstreams share one, it lives on the project.
- When a contribution adds a record that obviously touches several workstreams,
  review proposes the common ancestor ("this applies to Pricing and Outreach: put
  it on Launch?"). A manager can overrule.
- **A dependency on one specific item elsewhere** (task 3.2 needs the output of 5.1,
  or a decision rests on an assumption in another workstream) is an explicit link,
  not a move upward. It loads that item read-only (loading rule 4) and is followed by
  the impact walk (section 3).
- **Keep the project level small.** Pushing everything shared up would make
  every agent load all of it every time. The page shows the active project-level
  count; the review step flags a record that would better sit lower. This is
  guidance and visibility, not a limit.

### 3. Dependents are surfaced, not guessed

People and agents only know what is put in front of them. So:

1. **Impact is computed from declared links** (`restsOn`, `bends`, `replaces`,
   task links), following them all the way down. This exists today (#120/#132).
2. **Surfaced everywhere the context is read**: the page, the brief, the compiled
   task prompt, the review queue, and the change log. A dependent of a broken
   or replaced record is marked "needs review" until a manager re-confirms or
   replaces it.
3. **Never silently edited.** A change set that touches a decision does not rewrite
   the records that rest on it; it flags them, and each is decided on its own, with
   its own trail.
4. **Limit, stated plainly:** a dependency nobody wrote down is not flagged. A prose
   document has the same blind spot. Mitigations, in order of effort: the assistant
   is asked to name what a new record rests on when it writes one; the review step
   shows a suggested "this may rest on ..." that a manager can accept or ignore (a
   suggestion, never an automatic link); and the change log makes late discoveries
   cheap to record ("also rests on ...").

### 4. Numbering

#### 4.1 Workstreams

- Flat numbers `1, 2, 3, ...` across the whole project, in creation order.
  Nesting is shown by indentation only, never in the number. If Launch is `2`, its
  children are `3` (Pricing) and `4` (Outreach), and the next top-level workstream is `5`.
- Assigned once, never reused, never renumbered. Deleting a workstream leaves a
  gap. (Stability is the property that makes a number safe to say in a meeting.)

#### 4.2 Tasks

- `workstream.task`: `3.2` is the second task created in workstream 3. A task number
  is therefore always distinguishable from a workstream number (`3`).
- One counter per workstream, never reused after a delete.
- **Moving a task to another workstream** gives it the next number there. The old
  number is kept in its history as "was 3.2" and still resolves to the task, so
  old links and chat references keep working.
- Every task must live in a workstream. **Project-level tasks are not allowed.** The
  project's own work is expressed as a workstream (for example "Overall" or
  "Setup"). A project with no workstream has no tasks; the assistant proposes a
  workstream first. See migration (4.6).

#### 4.3 Records

- **No visible number.** A record keeps an internal id that never changes and is
  never shown to people; tools and links use it. People find records by
  workstream, wording, type and date, by search, and by asking the assistant.
- A record is cited by a stable link (deep link by internal id), or in prose by
  workstream plus wording ("the HubSpot rule in Launch"). Tool results always
  carry the internal id, so an assistant can refer to a record precisely without a
  human-readable number.
- Rejected here on purpose: a shared counter with tasks (it reads as tasks and
  records being one thing), a lettered counter (brings the prefixes back), and
  numbering generally (impractical at thousands of records, and unrelated to
  whether a record is current).

#### 4.4 Review queue (Waiting on you)

Every waiting item has a plain item number, from the same running list as tasks. No
tags, no separate queue counter, no `Q-` prefix.

- An item about an **existing task** shows that task's number as is (`3.2`).
- Any other item (a new task, a new record, evidence) takes the **next number in the
  workstream it is for**: if Content already has tasks `1.1` to `1.5`, the next waiting
  item there is `1.6`.
- The number belongs to the item from the moment it is submitted, so it can be referred to
  while it waits ("approve 1.6").
- **If it is approved as a task, the task keeps that number.** If it is approved as a record
  or as evidence (records are not numbered, 4.3), the number stays in the history as the
  submission's reference ("submitted as 1.6") and the record itself stays unnumbered.
- **Numbers are never reused.** A rejected item leaves a gap, the same as a deleted
  task. Gaps are accepted; stability is the point of a number.
- **Changes in the shape of the work do not renumber anything.** An AI step may propose that an
  item belongs in another workstream, or should be split. That follows the moved-task rule
  (4.2): the item gets the next number in the new place and keeps "was 1.6" as an alias.
  Existing numbers are never renumbered automatically, because a number said in a meeting
  must still mean the same thing next week.

#### 4.5 Where numbers appear

Workstream numbers in the left tree and breadcrumbs; task numbers in the task list,
the drawer, briefs, compiled prompts and links; an item number in the queue (the task's number, or the next number in the workstream).
Records show type, owner, status and wording; no number column.

#### 4.6 Migration

- Existing task keys (`T-14`) are replaced by `workstream.task`, assigned by the
  existing creation-order backfill, per workstream. The old `T-n` key is stored as a
  legacy alias so existing links and prompts resolve, and is dropped from display.
- Existing record keys (`D-/R-/A-/X-`) stop being displayed. They stay as legacy
  aliases for lookup for one release, then are removed.
- Existing project-level tasks must be placed in a workstream. Migration creates or
  asks for one (default name "Overall") and moves them there, recording the move in
  the change history.
- Counters are stored in `config.json` as the key counters are today, now
  one per workstream plus the workstream counter.

### 5. Auditability

Auditability comes from four properties, none of which is a visible number.

#### 5.1 Stable internal identity

Every record, task and workstream has an internal id that never changes. All links
(`restsOn`, `bends`, `replaces`, task links) and every history entry refer to ids.

#### 5.2 Every change is a change set

One approved contribution is one change set, written as one atomic unit with the
context change (on GitHub it is already one commit). Each change set records:

- **When** and **who approved** it.
- **Who or what proposed it**: person or agent, and the **source** (chat, a Read.ai
  call, an imported document), with a link to the original contribution.
- **What changed**: each affected record or task with its **before and after**
  (replaced, added, edited fields, status change, evidence added).
- **What it affects**: the dependents it flagged for review.
- **Why**: the stated reason or the quoted evidence.

Old versions are kept; nothing is overwritten.

Stored as an append-only `changes.jsonl` in the project's context folder, written in
the same commit or write as the change. A log file in the context folder, not git
itself, is the source of truth because the data-ownership principle allows other
stores later (Google Drive, SharePoint) and the audit trail must travel with them.
On GitHub the git history is an independent check: each change set is one commit
whose message carries `Change-Set:` and `Approved-by:` trailers, so `git log` and
`git blame` work on the context files for anyone who prefers them.

#### 5.3 Audit views (specified now, built after the MVP)

Modelled on tracing a change in code: `git log`, `git show`, `git blame`, `git diff`.

- **Change log:** change sets newest first. Each row: time, approver, proposer and
  source, a one-line summary ("replaced 2, flagged 6 for review, added 1 piece of
  evidence"), and the workstreams touched. Filters: workstream, record type,
  person or agent, source, date range, "still needs review".
- **Change set detail:** every operation with a before / after view (word-level
  diff of the text, field changes listed), the evidence or reason, and the
  dependents it flagged with their current state (still flagged, re-confirmed,
  replaced). One click from any dependent back to the change that flagged it.
- **Record timeline (blame):** all versions of one record in order, each linked to
  its change set, and the chain `replaces` / `restsOn` / `bends` both ways.
- **As of a date:** the active context as it stood on a given day, so "what was
  true when this decision was made?" has an answer. This is also how an agent
  run is audited: each compiled task prompt records the context version it was
  built from (the task already stores a hash of what it compiled from), so "what
  did the agent see when it ran task 3.2?" is answerable.
- **Export and MCP:** the log is exportable (JSON and CSV) and exposed through
  read-only connector tools (`change_log`, `record_history`) so an assistant can
  answer "what changed since Monday?". Scope applies: a scoped member sees changes
  in their scope, with out-of-scope dependents shown as "1 hidden item".
- **Integrity:** append-only; on GitHub, git history is the tamper check. For other
  stores an optional hash chain over the log entries is a later addition.

#### 5.4 What exists today and what is missing

Per a read of `src/model.js`, `src/ops.js` and `src/adapters/github.js` (not
re-verified in this session by running them): records already carry the
provenance fields (`sourceContributionIds`, approval and review dates, `links`,
`evidence`), contributions are appended to `contributions.jsonl`, writes land as one
commit, status changes (replaced, broken, closed) are kept, and the page has a
"Show history" toggle. Missing: before/after capture per change (history lives only
in git), a change-set grouping that can be queried, `changes.jsonl`, the views above,
and the connector tools. Those are the build.

#### 5.5 Phasing

- **MVP (what exists):** provenance fields, status history, "Show history", the
  impact flags, one commit per change. Plus the numbering change in section 4.
- **Next:** `changes.jsonl` with before/after, the change log and record timeline,
  `change_log` / `record_history` tools.
- **Later:** as-of view, agent-run audit, export, hash chain.

## Existing open source first

- **git** is already the store on GitHub and gives log, blame and diff for free;
  the design uses commit trailers rather than inventing a second history.
- **Text diffs** for the before/after view should use an existing library
  (jsdiff, the `diff` package, for word-level diffs), not a hand-written differ.
- **Event log pattern:** an append-only JSON Lines file needs no library.
- Checked: event-sourcing frameworks (for example EventStoreDB, Axon) and audit-trail
  libraries are far heavier than one JSONL file plus git, and would put a database
  between the customer and their own data, which the data-ownership principle rules
  out. Only the governed change set (what an approval means, what it flags) is
  teamctx's to build.

## Changes (by phase)

**Numbering (first):**
- `src/record-key.js`: workstream counter and per-workstream task counters; drop
  record prefixes from display; keep the legacy aliases.
- `src/storage.js`, `src/ops.js`: allocate on approval; refuse a task with no
  workstream; migration backfill including project-level tasks.
- `src/views/*`: remove the key column for records, show workstream and task numbers,
  queue items show an item number (the task's number, or the next number in the workstream).

**Loading rule:**
- `src/recompile.js`, `cli/commands/task.core.js`: add loaded linked items and the
  index of other workstreams; mark what was not loaded.

**Audit (after the MVP):**
- New `src/changes.js` (append, read, filter), `changes.jsonl`, commit trailers on
  GitHub, change log and timeline views, `change_log` / `record_history` MCP tools.

## Testing

- A task at `3.2` loads project, workstream path and task records, and nothing from
  siblings; the index lists the others; a hidden workstream shows as "1 part you cannot
  see".
- Numbering: creation order, never reused after delete, move keeps a "was" alias, a
  task with no workstream is refused, migration places project-level tasks, legacy
  `T-n` links still resolve.
- Queue: an item about an existing task shows its number; any other item shows the next number
  in its workstream; the number is kept if it becomes a task; a rejected item's number is
  never reused; an item moved to another workstream gets a new number and a "was" alias.
- Impact: replacing a decision flags every dependent through `restsOn`, never edits
  them; a flagged dependent appears in the page, brief, prompt, queue and log.
- Change log (when built): each approval writes exactly one entry with before/after;
  a scoped reader sees only their scope and a hidden-item count; a replay of the log
  reproduces the context.

## Open questions

1. **Resolved:** project-level and workstream-level context is not listed on the page in
   the MVP. It is read through the assistant, and a right-hand drawer shows the exact
   context for any level in plain English, with deep links to the assistants. See [context in the assistant](2026-10-07-context-in-the-assistant-design.md)
   (UI fix 4). The numbering in section 4 is applied in the demo.
2. Name of the default workstream created for migrated project-level tasks ("Overall",
   "General", or ask each project).
3. Is a moved task's old number kept for ever, or only for a release?
4. How long do legacy record keys keep resolving?
5. Should the as-of view and agent-run audit be in the first audit release or the
   second? Recommendation: second.
