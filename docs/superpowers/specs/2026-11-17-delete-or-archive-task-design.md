# Let a manager delete a task before it is worked on, and archive it after (#320)

## The problem

A manager cleaning up a workstream has two blunt outcomes today:

- `removeTask` deletes a task in any state — including one that already has
  saved outputs, throwing away that work and the history that points at it.
- There is no way to retire a task that *has* work on it but should no longer be
  done. Nothing marks a task "cannot be worked on" and leaves it out of the
  approved context.

Numbers are already safe: `src/numbering.js` mints a workstream number once from
a counter and never reuses it, so a cleaned-up Workstream 1 reads 1.2, 1.4, 1.7.
This change must not touch that.

## What exists now

| Piece | State |
|---|---|
| Task state | `status` on the task record: `'open'`, and `'done'` / back to open via `setTaskStatus` (`cli/commands/task.core.js`), with a `statusLog` trail. No `'archived'`. |
| "Picked up" signal | a saved output. `saveOutput` writes one; `listOutputs(task.id)` reads them. Assigning or opening a task saves nothing. |
| Delete, task store | `removeTask({ id, reason, ... })` (`task.core.js`) — deletes whatever the state, keeps the approval/outputs as history per its own comment. |
| Delete, approved context | `removeTask` is an op in `OP_TYPES` (`src/ops.js`), applied into the compiled context tree. |
| Delete, the page | the project page's remove control posts to the same task path. |
| Reads that must hide it | `listTasksFiltered` (default list), `my_brief`, `compileTask` and the compiled prompt, and the approved-context build in `src/ops.js`. |
| MCP surface | `task_rm` tool; no archive tool. |

## Proposal

Add one task state, `archived`, and guard the paths that remove or work a task.
"**Picked up**" is defined as **has at least one saved output** — nothing else.

1. **Delete stays, but only before pickup.** `removeTask` first checks
   `listOutputs(id)`. Empty → delete as now (number stays unused — numbering is
   untouched). Non-empty → refuse with a plain message that names *archive* as
   the way to retire it. The same guard sits behind every path: the `task_rm`
   MCP tool, the `removeTask` op in `src/ops.js`, and the page — one shared
   check (`src/` helper) so no path can skip it.

2. **Archive is a new state, modelled on done/reopen.** A manager-only
   `setTaskStatus`-style operation sets `status: 'archived'`, stamps
   `archivedAt` / `archivedBy`, and appends to `statusLog`. It keeps the task's
   number and every saved output — "1.4" still means 1.4 in old links, reviews
   and history.

3. **Archived blocks further work.** `saveOutput`, `submitTask` and
   `compileTask` refuse on an archived task, each with a one-line reason.

4. **Archived drops out of the live views.** Left out of `listTasksFiltered` by
   default (a flag still shows it), `my_brief`, compiled prompts, and the
   approved context built in `src/ops.js`. It stays visible, **marked
   archived**, on the project page and wherever history or an old link lands —
   the task page still opens and says it is archived.

5. **Un-archive: yes, mirroring reopen.** Reopen already exists for finished
   work, so a manager can move an archived task back to `open` (clearing
   `archivedAt`, logging it). Same manager-only gate as archive.

## The removal paths, named

So one path cannot skip the rule, the pickup-guard and the archived-checks live
in `task.core.js` helpers and are called from all three:

- **MCP** — `task_rm` (guarded) plus a new `task_archive` (and un-archive).
- **Contribution op** — `removeTask` in `src/ops.js` honours the guard; a new
  archive op carries the state into the approved context.
- **Page** — the remove control refuses with the archive offer; an archive
  control on an archived-eligible task.

## Existing open source first

Nothing to borrow — this is a state flag on teamctx's own task model and a check
on the paths that remove or change a task, not plumbing a library provides.

## Test plan (from the issue's acceptance)

- Deleting a task with no saved output works and leaves its number unused: the
  next task in that workstream gets the next number, not the freed one.
- Deleting a task with a saved output is refused on **every** path, and the
  message names archive.
- Archiving keeps the number and outputs; `saveOutput`, `submitTask`,
  `compileTask` are refused on an archived task.
- An archived task is absent from the approved context, `my_brief`, the default
  task list and compiled prompts; an old link still opens and says archived.
- Removing 1.1 and 1.3 from a workstream of 1.1–1.7 leaves 1.2 and 1.4–1.7
  unchanged.
- Un-archive returns the task to `open` and the live views.

## Out of scope

Bulk cleanup, time-based auto-archive, and any change to how numbers are minted.
