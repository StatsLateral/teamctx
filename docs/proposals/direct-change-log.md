# Proposal: log the direct changes that move what people work under

**Status:** Implemented · **Issue:** [#207](https://github.com/StatsLateral/teamctx/issues/207)
· **Base:** `main` · **Builds on:** the accepted-work design (#204,
`docs/superpowers/specs/2026-10-14-accepted-work-updates-context-design.md`)

## Why

The change log is written on three paths: approving a queued contribution,
applying one directly, and accepting a task submission. A task added or removed
with `task_add` or `task_rm` writes nothing, so nobody with work in progress
below it is told the plan moved.

## What each direct change does to someone's work

What a compiled prompt is built from decides it (`renderBrief`, `contextHash` in
`cli/commands/task.core.js`): the goal and records of the project, every
ancestor and the task's own part, and the **number and title of every task** in
those parts. Owner and status are shown but left out of the fingerprint on
purpose: "a task's own status changes constantly and has no bearing on whether
the prompt is stale".

| Direct change | Changes what tasks below it work under? | Entry |
|---|---|---|
| `task_add` | Yes: a new task in the part, and in every prompt below it | **Yes** |
| `task_rm` | Yes: a task gone from the part and the prompts below | **Yes** |
| `task_done`, `task_reopen` | No: status, kept out of the fingerprint already | No |
| `task_assign` | No: owner, kept out of the fingerprint already | No |
| `workstream_add` | No: a new part is below its parent, and nothing flows up; nobody has work in it yet | No |
| `role_add`, `role_assign`, `config_set`, members, snapshots | No: none of these is part of the context a task works under | No |
| `init` | The founding write; nothing is in progress yet | No |

Retitling a task by hand has no direct path: it goes through a contribution
(`editTask`), which is logged already. There is no rename, move or removal of a
part yet; when one is added it should log, by the same rule.

## What changes

- **`addTask` and `removeTask` write one entry each**, in the same commit as the
  change, through the same `changeEntry` the other paths use. The change is
  described as the operation the approval card already has words for (`addTask`,
  `removeTask`), so the summary reads the same as it would on a card ("Add a
  task: …", "Remove the task "…""), with no AI and no new wording.
- **The entry's part is the task's part**; `touched` names the task; `by` is who
  did it. An added task is not flagged by its own entry: its compile time comes
  after it.
- **A failure to write the entry does not undo the change.** As on the applied
  contribution path, the result carries a warning instead.
- **Nothing else changes**: who sees an entry, how the flag reads and when a
  compiled prompt goes stale are as they are now.

## Tiers (#206)

#206 counts plain additions instead of listing them. Because these entries are
built from the same operations, they get the same treatment when both are in: an
added task is a plain addition, counted; a removed one is shown to anyone whose
own task it was. Nothing extra is needed here.

## Not now

- **Status and assignee changes.** Noise for the flag, and already deliberately
  outside the staleness fingerprint.
- **#202's removal of an accepted task** writes its own entry on its branch; the
  two meet in `removeTask` and are merged when both land.

## Tests

`task_add` and `task_rm` each write one entry, in the task's part, naming the
task and who did it, in the approval card's words; a task in progress in that
part or below is flagged, a sibling part's is not; the added task is not flagged
by its own entry; done, reopen and assign write nothing; a failed entry write
leaves the change in place with a warning; the hosted server writes the entry in
the same commit.

## Plan

- [x] Entries for `addTask` and `removeTask`, with tests
- [x] CHANGELOG
