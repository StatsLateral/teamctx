# Proposal: task submissions in the review queue

**Status:** In progress · **Issue:** [#144](https://github.com/StatsLateral/teamctx/issues/144)
**Spec:** [task submissions and next steps](../superpowers/specs/2026-10-07-task-submissions-and-next-steps-design.md) ·
**Plan:** task 7 in [the UI specs build](../superpowers/plans/2026-10-07-ui-specs-build.md)
**Base:** `feat/task-history` (#143) with `feat/waiting-on-you-icons` (#142) merged in; the plan needs both

## What the issue asks

- A contribution that is work for a task says so: `forTask`, filled by the connector.
- Its queue row reads as the task: the task's number and exact title, then
  "Submitted: …".
- Approving it marks the task done and writes no record. Rejecting keeps the task
  open, with the reason.
- After approval, AI suggests follow-on tasks; the approver adds the ones they want.

## Held: where the suggestions appear

The plan shows the suggestions in the page drawer after approving there (task 7,
step 7). Its global constraints, and #142, keep the page read-only, with
approvals in the assistant or the CLI. Asked on the issue. Until that is answered,
`nextSteps` and the Approved view are not built.

## Design (the rest)

### Sending work for a task

- `contribute` (the person's tool and the agent's) takes:
  - `forTask`: the task's number (`1.2`) or id
  - `submitted`: one line saying what was produced ("Draft post, 700 words")
- A task the caller can't see is refused exactly like one that doesn't exist, so
  its existence isn't leaked.
- A submission is not distilled. Its text is the work as received, the
  assistant's one line is the summary, and no AI call is spent. It is queued with
  the task's number and workstream. A manager's `apply` completes it at once, as
  with any contribution.
- The connector's guidance says to send work back with `forTask`, so the link
  isn't left to a free-text tag.

### Approving and rejecting

- **Approving a submission** goes through `applyTaskSubmission`, not the record
  path:
  - the contribution is added to the task's sources
  - the task is marked done, with who and when, and its `statusLog` gains the
    completion
  - no record is written
- **A task already done** only gains the submission.
- **Rejecting** is unchanged: the task stays open and the rejection keeps its
  reason.
- History (#143) then reads: submitted, approved, marked done, or submitted,
  rejected.

### The page

- **Row:** the task's number and title, a muted "Submitted: …" line, and "task
  already done" when it is.
- **Drawer:** the task's title as the heading; "What was submitted" holding the
  work as received; and in Decide, "What approving does": *Accepts this for task
  1.2 and marks the task done. Nothing is published or sent by this step.*
- Proposals that aren't task submissions keep their own wording.

## Existing open source first

Nothing. Workflow engines (Camunda, Temporal) model a fixed process, which the
spec deliberately avoids.

## Plan

- [ ] `forTask` and `submitted` on `contribute` (both tools); hidden or unknown task refused alike
- [ ] `applyTaskSubmission`; approve routes a submission through it; no record written
- [ ] Row and drawer wording; "task already done"
- [ ] Tests (the spec's cases: two submissions for one task, an already-done task, scope, identical titles); CHANGELOG
- [ ] Held: `nextSteps` and the Approved view, pending the answer on #144
