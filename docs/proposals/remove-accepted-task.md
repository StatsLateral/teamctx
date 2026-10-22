# Proposal: a manager can remove an accepted task

**Status:** Implemented · **Issue:** [#202](https://github.com/StatsLateral/teamctx/issues/202)
· **Base:** `main`

## Why

A task whose submitted work was accepted is closed for good (#197): nobody can
remove it, the manager included. Sometimes it has to go: it was accepted by
mistake, or the work was superseded.

## Answers to the issue's open questions

- **Removal or reopening?** Removal. Reopening for more work is a different
  thing and stays out of this; a follow-on task still covers "more work".
- **Who, and with a reason?** A manager only, and a reason is required.
- **The accepted outputs and the approval record?** Kept. The task leaves the
  plan, not the history: outputs, the approval file, the contribution log and
  the change log all stay.
- **What was written on the strength of the task?** The acceptance record
  ("Task 1.2 accepted: …") is marked closed, so the context stops saying it is
  accepted work. Anything else the manager recorded when accepting (facts,
  other tasks) stands on its own and is left as it is; the result lists what is
  still active so the manager can decide.
- **Does the person who did the work see it?** The removal and its reason are in
  the change log and the contribution log, under the manager's name. A
  notification to that person is not part of this.

## What it does

`teamctx task rm <id> --reason "…"` and `task_rm` with `reason`:

- On a task that is not accepted: unchanged (no reason needed).
- On an accepted task, by somebody who is not a manager: refused, as now.
- By a manager without a reason: refused, saying a reason is needed.
- By a manager with a reason: the task is removed, its acceptance record closed,
  the removal logged with the reason, and the result names what still stands:
  anything the acceptance added, and any record still attached to the task.
- The rendered context is rewritten so `ask` stops showing it; role files are not
  regenerated, which would spend an AI call.
- Its id stays taken, so a new task with the same title does not inherit its
  approval and outputs.

## Reused

`assertManager`; `applyOps` with `removeTask` and `setRecordStatus` so the
change goes through the usual path; `changeEntry` / `writeChange` for the change
log; `appendContribution` for who and why.

## Code

- `cli/commands/task.core.js`: `removeTask({ id, reason, … })`.
- `cli/commands/task.js` and `cli/index.js`: `--reason`.
- `mcp/server.js`: `task_rm` takes `reason`.

## Tests

A member cannot remove an accepted task; a manager needs a reason; a manager
with one removes it, closes the acceptance record, keeps the outputs and the
approval, logs the reason, and is told what is still active; an ordinary task is
removed as before.

## Plan

- [x] `removeTask` for an accepted task; tests
- [x] `--reason` on the command line and `reason` on `task_rm`; tests
- [x] README, CHANGELOG
