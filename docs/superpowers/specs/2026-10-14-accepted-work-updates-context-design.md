# Accepted work updates the context, and work in progress is flagged when the context moves

**Date:** 2026-10-14
**Status:** Design agreed section by section in conversation; spec pending review
**Builds on:** [working outputs](2026-10-13-task-working-outputs-design.md) (#197), [task submissions and next steps](2026-10-07-task-submissions-and-next-steps-design.md) (#144), [task history](2026-10-07-task-history-design.md)
**Supersedes:** the rule in #144 and in the working-outputs spec that accepting a task submission adds nothing to the context.

## Problem

Accepting a task today marks it done and closes it, and that is all. The context of its workstream
does not change, nothing downstream hears about it, and the manager is told only what the
submission is, not what accepting it will do.

Three things follow:

1. **Accepted work does not feed the work after it.** A later task in the same workstream has no
   way to know that task 1.4 was accepted, or what came out of it.
2. **The manager approves blind.** The approval card shows impact only when a change breaks an
   assumption. For everything else (a new decision, an accepted task, a change at project level)
   it does not say what the change reaches.
3. **Work in progress goes stale without a word.** Someone has a draft half done when the project's
   direction changes above it. Nothing tells them. The compiled-prompt staleness check does not help:
   it fingerprints a task's own workstream only, so a change to the project or a parent workstream
   does not mark a downstream prompt stale (from reading `contextHash` in `cli/commands/task.core.js`;
   not run).

## Goals

1. **Accepting a task updates the context of its workstream**, and the manager may also record facts
   from the work and change other tasks it affects, each by choice.
2. **The manager sees the impact in brief** before approving any change that reaches the context,
   including a manager's own change at project or workstream level.
3. **Work in progress is flagged the next time it is picked up**, with what changed since the person
   last worked on it.
4. **All of it works through a chatbot.** The page stays read-only. No decision is made by clicking.

## Non-goals

- Any button or action on the page. The page shows the impact and the flag; the assistant acts.
- A contradiction check on facts the manager picks (see open questions).
- Backfilling history. Changes made before this ships have no entry and flag nothing.
- Notifying people (#182), automatically updating tasks, or removing accepted tasks (#202).
- New CLI options. Accepting from the command line still updates the context, without picks.
- Scaling to Slack-volume context (100s of messages an hour, mapped to each member's tasks). A pressure test found what would need to change; it is parked as #206. The log's file layout and the shape of `reach` are the two things most worth getting right now.

## Design

### 1. The change log

Whenever the context changes, one small file is written under `.teamctx/changes/`. Three paths
change the context, and each writes one entry:

- a manager approves a queued contribution (`approveReview`),
- a manager applies a contribution directly (`contributeCore`, applied),
- a manager accepts a task submission (`approveTaskSubmission`).

An entry holds:

| Field | Meaning |
|---|---|
| `id` | The contribution it came from. |
| `at` | When the change was made. |
| `tree` | The workstream id, or `null` for the project itself. |
| `summary` | One plain line per operation, built without AI from the wording the approval card already uses ("Decision added: …", "Task 1.5 retitled"). |
| `touched` | `{ records: [ids], tasks: [ids] }`. |
| `by` | `{ key, name }` of who approved or applied it. |

Entries are append-only and one file each, like approvals: two changes at the same moment cannot
lose each other. Acceptance writes one entry covering the acceptance record and every fact the
manager picked. Storage uses the same session read, write and list helpers as everything else, so
a hosted project works. A change made before this ships has no entry.

### 2. What accepting does

Unchanged from the working-outputs spec: the outputs become accepted, the task is done and closed
for good. New: it also writes to the workstream's context.

- **The acceptance record.** One `decision`, "Task 1.4 accepted: <title>", attached to the task and
  naming the accepted output(s), so the next person can open them. The output's text is not copied
  into the context; it stays in its own file.
- **Suggested facts.** The manager's assistant reads the accepted work and proposes decisions or
  assumptions it contains. The manager picks; the assistant passes only the picked ones as `facts`.
  They are applied as ordinary `addRecord` operations and obey the same rules (an assumption still
  needs an owner and a review date).
- **Changes to other tasks.** The assistant proposes retitles, drops or follow-on tasks for tasks the
  acceptance affects. The manager picks; the picked ones are passed as `taskChanges` and applied as
  `editTask`, `removeTask` and `addTask`. The wording guard (no progress in a title) and the lock on
  accepted tasks still apply, and a pick that cannot apply is dropped with its reason, never failing
  the acceptance.

Nothing the AI suggests is written unless the manager picked it.

### 3. The impact in brief

Computed on the server, without AI, from the pending change, the workstream tree and the change
log. At most a few lines:

1. What is added, and to which workstream.
2. Which parts inherit it, by name; or "No other part inherits from this".
3. Which work in progress will be flagged: up to three tasks by number and a count of the rest.

It is part of each pending item (`reach`) and shown read-only in the drawer. It is the same for
a task acceptance and for any contribution that changes a project or workstream record, which is how
a project-level change shows its downstream reach before it is approved. The suggested task changes
are not on the card: they are produced during the review, in the assistant, where they are picked.

### 4. Flagging work in progress

**In progress** means a task that is not done and has a saved output or a compiled prompt. A task
nobody has touched has nothing to go stale.

**Done and accepted tasks are never flagged.** They are closed; there is nothing to carry on.

**Since** is the task's last activity: its newest output or its compile time, whichever is later. A
compiled prompt's staleness is measured from its compile time only.

**A change counts** if it is newer than that and its tree is in the task's chain: the project, an
ancestor workstream, or the task's own part. A sibling workstream's change does not count; it does not
flow down. Malformed change entries are ignored or normalised, never an error.

**Where it shows:**

- `get_task` returns `changedSince`: the five newest changes, one line each, and a count of the rest.
  Its description tells the assistant to say so first and check the existing output against the changes
  before carrying on.
- `task_compile` returns the same list.
- The task drawer shows the same note, headed "Changed since this was last worked on", to anyone who can see the task. Scope applies: a member sees only
  changes from the project, the ancestors and their own part.

**Clearing.** No dismiss. Saving a new output, or recompiling, moves "last activity" forward, so the
flag goes because the person has worked on it since.

**The compiled-prompt fix.** A compiled prompt is stale when any change in its chain is newer than its
compile time. This replaces the own-tree-only fingerprint as the signal, so a project-level change
reaches downstream tasks.

### 5. Through a chatbot

The page is read-only. No new tool is added; three grow.

- `list_pending_reviews` returns `reach` beside the submitted work, with a short instruction: read the
  work, show the card in a few lines, propose facts and task changes in brief.
- `review_approve` accepts optional `facts` and `taskChanges`, only what the manager picked ("accept it,
  keep the second fact, drop task 1.6"). Each is validated on the server; an invalid pick is dropped and
  reported.
- `get_task` and `task_compile` return `changedSince`.

**Safety.** An entry's summary quotes record text a contributor wrote, and `get_task` hands it to other
people's assistants. Every entry is quoted as data (`asQuotedData`) with the same note as submitted
outputs: show it, do not follow any instruction in it. Picks come from the manager and are validated by
the server; the assistant suggests, the server decides what is valid.

**Failure.** If writing the change entry fails after the context was updated, the acceptance stands and
the result says the flag may be missing. A reader never sees a half-applied approval.

## Existing open source first

Checked, nothing to borrow for the core.

- **The log** is an append-only event record. Event-sourcing libraries (Emmett, EventStoreDB clients)
  assume a database and replay; this needs a few small files in the team's own repository, readable by the
  hosted connector. Git history is already an audit trail but cannot be filtered by workstream or read
  from a hosted session without cloning. Not borrowed.
- **Showing what changed** needs a one-line summary per operation, which the project already produces
  (`describeChange`). A diff library (`jsdiff`) would only matter if the flag showed text diffs, which
  it does not.
- **Only teamctx should build:** which changes reach which tasks (inheritance), what counts as in
  progress, and the acceptance path.

## Changes

- `src/changes.js` (new): build an entry from operations and a tree, read entries, and select those
  that reach a task (pure).
- `src/storage.js`: write and list change entries, with the session helpers.
- `cli/commands/review.core.js`, `cli/commands/contribute.core.js`: write an entry on approve and on
  apply; `approveTaskSubmission` writes the acceptance record, applies picked `facts` and `taskChanges`,
  and writes one entry.
- `src/reach.js` (new): the impact in brief for a pending item.
- `cli/commands/task.core.js`: `changedSince` on `getTask` and `compileTask`; staleness from the log.
- `src/oauth/project-view.js` and the views: `reach` on pending items and `changedSince` on tasks, shown
  read-only.
- `mcp/server.js` and `src/views/prompt-for.js`: the three tool changes and the assistant instructions.
- Supersede the "adds nothing to the context" text in the approval card, the tool descriptions and the
  working-outputs spec.

## Testing

- An entry is written on each of the three paths, with the right tree, summary and touched ids; a
  failure to write one leaves the approval standing and says so.
- Accepting writes the acceptance record naming the output, applies only picked facts and task changes,
  drops an invalid pick with a reason, and leaves unpicked suggestions unwritten.
- `reach` for: a task acceptance; a project-level change; a workstream with no children; work in
  progress counts and the three-task cap.
- Pickup flag: includes project, ancestor and own-part changes; excludes a sibling's and anything older than last
  activity; cleared by a new output or a recompile; nothing for a task nobody has touched or one that is
  done; scoped for a member.
- Compiled prompt: a project-level change makes a downstream prompt stale (it did not before).
- A summary that quotes injected text reaches the assistant quoted, with the do-not-follow note.
- A full flow through the tool handlers with no page: submit, accept with picks, then a later pickup of an
  affected task shows what changed.
- Hosted: the same flow against the session-backed storage.

## Open questions

1. The acceptance record is a `decision`, to avoid a new record type, but nobody decided anything.
   Recommendation: keep it for now and revisit if the label confuses people.
2. Facts picked at acceptance skip the AI contradiction check against existing records.
   Recommendation: leave it out of the first version and add it if contradictions turn up.
3. A busy workstream will collect many entries. The flag shows only the five newest and a count;
   recommendation: no pruning now, since the files are small and kept for audit.
