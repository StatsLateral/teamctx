# Proposal: task history

**Status:** In progress · **Issue:** [#143](https://github.com/StatsLateral/teamctx/issues/143)
**Spec:** [task history](../superpowers/specs/2026-10-07-task-history-design.md) ·
**Plan:** task 6 in [the UI specs build](../superpowers/plans/2026-10-07-ui-specs-build.md)
**Base:** `main` at `818ef8d`

## What the issue asks

- Done tasks struck through in every list and in the drawer title.
- A History section in the task drawer: a status line, then one event per line
  (submitted, approved, rejected, completed, reopened), oldest first, scope-filtered.
- Store what is missing: who approved and when, who completed, rejections kept.
- Old tasks show "Added" only, never an invented approval.

## Where it starts from

| Needed | Today |
|---|---|
| Strikethrough in task lists | Done (`.trow.done .ttl`) |
| Strikethrough in the drawer title | Missing |
| Who submitted, how, when | The contribution log has author, `source`, `ts` |
| Who approved, when | **Missing for tasks.** Approval stamps `approvedBy` on records only |
| Who completed or reopened, when | **Missing.** `doneAt` is a date with no actor; reopening clears it |
| Rejections | Kept in `.teamctx/rejected/<id>.json` with `rejectedBy` (a name), `rejectedAt`, `reason` |
| Waiting submissions | The review queue |

## Design

### Stored facts

1. **Approvals:** `.teamctx/approved/<id>.json`, written when a contribution
   is approved (`review approve`, or applied by a manager), holding
   `{ id, author, source, workstream, approvedBy: { key, name }, approvedAt }`.
   It mirrors `rejected/`, so every decision leaves one small file.
   *Why not a field on the contribution, as the spec says:*
   `contributions.jsonl` is append-only. Stamping a line means rewriting the
   file, which can lose a contribution appended at the same moment. A file per
   decision can't.
   A contribution that went in under the `additive` review policy, with no
   manager, records `approvedBy: null, by: 'policy'`, and history says so
   rather than naming an approver.
2. **Completion:** `setTaskStatus` appends to a `statusLog` on the task:
   `{ did: 'completed' | 'reopened', by: { key, name }, at }`, with full time.
   `doneBy` is kept beside `doneAt`. A task completed, reopened and completed
   again keeps all three.
3. **Rejections** also keep `rejectedByKey`.

Nothing old is rewritten. Missing facts are shown as missing.

### Deriving the history

`taskHistory({ task, contributions, approvals, rejected, queue, canSee })` in
`src/task-history.js` is a pure function returning `{ status, events }`.

| Event | From |
|---|---|
| submitted | each contribution in `sourceContributionIds` (author, source, `ts`) |
| approved | its `approved/` file |
| rejected | `rejected/` items with an operation on this task |
| waiting | queue items with an operation on this task (`waiting: true`) |
| completed / reopened | `statusLog`, or `doneAt` alone for older tasks (no actor) |
| added | a task with none of the above: its `createdAt`, no actor |

**Status:** "Approved", "Approved · a new submission is waiting", "Not approved
yet" (queue only), or "Added" for a task from before approvals were recorded.

**Scope:**
- Members never see the queue, so waiting and rejected events are managers' only.
- A name that isn't on the reader's roster shows as "someone".

### View

- **Task drawer:** History sits under the details and above the assistant
  block. The status line, then one line per event (date, the person or agent
  chip, what happened), with the exact time in a tooltip. Built from data on
  the row, as text, never markup. "Show earlier" appears past ten events.
- **Done task:** the drawer title is struck through.
- **Review drawer:** a waiting item that changes an existing task shows that
  task's history, with the new submission at the end, tagged "waiting for
  approval".

### Not included

- "Moved from 3.2 to 4.1": nothing moves a task between workstreams today.
- A person's task list in an agent drawer: it doesn't exist on the page yet.

## Existing open source first

Nothing: one derived list. Activity-feed and audit libraries are far heavier.

## Plan

- [ ] `taskHistory` and its tests (the spec's cases, old data, scope)
- [ ] Approvals recorded (review approve, manager apply, additive policy)
- [ ] `statusLog` and `doneBy` on completion and reopening; `rejectedByKey`
- [ ] Page data: history per task, scope-filtered
- [ ] Drawer: History section; struck-through title for done tasks; history in the review drawer
- [ ] View tests, CHANGELOG
