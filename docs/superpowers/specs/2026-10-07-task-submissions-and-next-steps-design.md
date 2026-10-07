# Task submissions in the review queue, and AI-suggested next steps

**Date:** 2026-10-07
**Status:** Design confirmed in the demo conversation (UI fix 8 of a series); spec pending review
**Builds on:** [Waiting on you icons](2026-10-07-waiting-on-you-icons-design.md), [context model and numbering](2026-10-07-context-model-and-numbering-design.md) (4.4, item numbers), [task history](2026-10-07-task-history-design.md)
**Prototype:** the internal prototype (synthetic data)

## Problem

A person picks up task 1.2, "Write: Transfusion traceability when two lab networks become
one", in their assistant and gets a draft. They send the draft back for review. In
"Waiting on you" the same item read "Publish 'Transfusion traceability …' on LinkedIn and
the company blog." Two different descriptions of one thing, in two places, and the second
one was a guess:

- The system does not know what the next step for the approver will be. In this example the
  draft is reviewed and approved, and then **someone else** publishes it. A draft can lead to
  several follow-on tasks (publish on two channels, log the links, brief the next person), or
  none.
- Approving the item added a "decision" record to the context, which is wrong for a draft.
  A draft is work product, not context.

## Goals

1. A waiting submission reads as the task it belongs to, so the same work has the same words
   everywhere, plus a line saying **what was submitted**.
2. The approver knows exactly what approving does: it accepts the submission and completes the
   task.
3. Approving never decides the next step. The assistant (AI) suggests follow-on tasks from what
   was approved; **the approver chooses which to create**.

## Non-goals

- Automatic creation of follow-on tasks. Nothing is created without the approver's click.
- Publishing or sending anything. Approval accepts a submission; publishing or sending is a
  separate task with its own approval where policy requires it.
- Changing how proposals that are not about a task are reviewed (new records, evidence), which
  keep their own wording.
- Partial acceptance (approve some parts of a draft). Out of scope for the MVP.

## Design

### 1. A waiting submission reads as its task

For a waiting item that is a submission for an existing task:

- **Row:** the item number is the task's number (`1.2`); the title is the **task's own title**,
  unchanged ("Write: Transfusion traceability when two lab networks become one"); below it, a
  muted line **"Submitted: Draft post, 700 words"** describing what arrived. Who sent it,
  where and when stay on the usual line below. Warnings (items to check against the record)
  stay as they are.
- **Drawer:** the heading is the task's title; "What was submitted" shows the submission as
  received; the "Checked against what is already approved" and history sections are
  unchanged.
- Items that are **not** task submissions (a proposed new record, evidence against an
  assumption) keep describing the proposal, because there is no task for them to match. Their
  item number comes from the workstream's running list (context-model spec, 4.4).

Rule: the title always says what the work is; the second line says what was produced.

### 2. What approving does

The drawer's decision area replaces "What it would add" with **"What approving does"**:

> Accepts this draft for task 1.2 and marks the task done. Nothing is published or sent by this
> step. AI then suggests the next tasks, and you decide which to add.

- **Approve:** the submission is accepted, the task is marked done, and the approval is
  recorded in the task's history (task-history spec): the submission, who approved it and when,
  and the completion.
- **Reject:** the task stays open, the rejection (and reason) is recorded in its history, and the
  sender is told why.
- **Approve as suggested by AI** (after "Review with AI") behaves the same way; the AI's review
  informs the decision and never makes it.
- Approving a task submission **never** writes a record (decision, rule, assumption or
  exception) into the context. Records are added only by their own proposals.

### 3. Next steps, suggested by AI, created with permission

Right after approval the drawer stays open on an **Approved** view:

```
Approved. "Write: Transfusion traceability ..." is done.
Nothing was published or sent by this step.

NEXT STEPS, SUGGESTED BY AI
Based on what you just approved. Nothing is created until you add it.
┌────────────────────────────────────────────────────────────┐
│ Publish "Transfusion traceability ..." on LinkedIn and ...  │
│ [Maya]                                    [Add as a task] │
└────────────────────────────────────────────────────────────┘
┌────────────────────────────────────────────────────────────┐
│ Add the published links to the weekly roll-up               │
│ [Maya]                                    [Add as a task] │
└────────────────────────────────────────────────────────────┘
```

- Each suggestion has a title and a suggested owner (person or agent), and an **Add as a
  task** button. Adding creates an open task in the **same workstream**, numbered with the next
  number in it (`1.6`), and the button becomes "Added as task 1.6". The list stays so more than
  one can be added; closing the drawer ends it.
- A task created this way records in its history that it was **suggested by AI after 1.2 was
  approved**, and that the approver added it (a submission by the approver, approved at once,
  because the approver's click is the permission).
- Suggestions come from what was approved, the task, the context that applies to it, and the
  rules (for example, a rule that nothing is sent without approval turns "send the email" into
  its own task, not an automatic step). Suggestions never include anything the approver may
  not do.
- No suggestions is a valid outcome ("No follow-on tasks suggested").

### 4. Why the next step is the approver's choice

The product cannot know what follows a draft. One draft can lead to publishing on two channels
by one person, a review by a lawyer, or nothing. Hard-coding "Publish" assumes a workflow the
team never stated. Letting the approver pick from AI suggestions keeps the people in charge,
makes each follow-on task a first-class, numbered, auditable task, and lets the AI help without
acting.

### 5. Data

- A contribution that is a submission for a task carries `forTask` (the task's id). Today the
  convention is to tell the assistant "send what you produced back with contribute and tag it
  <task number>"; per a read of `cli/commands/contribute.core.js` and `mcp/server.js` there is
  no field that links a contribution to a task (not run in this session), so this adds one.
  The connector fills it from the task number the assistant was working on.
- A queued item that has `forTask` renders per section 1. An optional `submitted` summary
  (short text) is derived from the contribution (assistant-written, one line).
- `nextSteps` on the review result: a list of `{ title, owner }` produced by the AI step at
  review time; not stored as tasks. They live only until the approver adds or closes them.
- Adding a suggestion is a normal task creation (`addTask`) by the approver, recorded as in
  the task history spec, with `note: suggested by AI after <task> was approved`.
- Approval of a task submission writes: the task's done state with who and when, and the
  approval event. It writes no record.

### 6. Edge cases

| Case | Behaviour |
|------|-----------|
| Task already done when a submission arrives | The row says so ("task already done") and approving only records the submission. |
| Two waiting submissions for one task | Each is a row with the task's number; approving one completes the task; the other stays and is flagged "task already done". |
| Submission for a task the reader cannot see | Not shown to that reader (scope rules). |
| AI finds nothing to suggest | The Approved view shows "No follow-on tasks suggested." |
| Owner suggested is outside the approver's scope | Shown without the owner; the approver picks one when adding. |
| Approver closes the drawer without adding | Nothing is created. The suggestions are not kept; the next step is theirs to file later. |

## Existing open source first

Nothing to borrow. It is a change to what a queue row and review drawer say, a flag on a
contribution, and a list of AI-produced suggestions rendered with the existing AI step. Workflow
or BPMN engines (Camunda, Temporal) would model next steps as a fixed process, which is what this
design deliberately avoids; the approver chooses.

## Changes

- Contribution handling (`cli/commands/contribute.core.js`, `mcp/server.js`): add `forTask`;
  have the connector fill it from the task being worked on.
- `src/review.js` and the review step: for a `forTask` item, approval accepts the submission and
  marks the task done instead of applying a record; rejection keeps the task open; both record
  history events.
- AI review (`src/ai.js`): produce `nextSteps` from the approved submission, the task and the
  context that applies.
- `src/views/project.js` and the drawer script: queue row shows the task title and the
  "Submitted:" line; the drawer shows "What approving does"; the Approved view with
  "Add as a task".
- No change to scope enforcement or to how non-task proposals are reviewed.

## Testing

- Queue test: a `forTask` item's row shows the task's number and exact title, plus the
  "Submitted:" line; a non-task proposal keeps its own wording.
- Review test: approving a task submission marks the task done, records submission, approval
  and completion in the task history, and adds **no** record to the context.
- Review test: rejecting leaves the task open and records the rejection.
- Next-steps test: suggestions appear only after approval; none is created until added;
  adding one creates an open task in the same workstream with the next number and a history that
  says it was suggested by AI; adding the same suggestion twice is prevented.
- Edge tests: two submissions for one task; a submission for an already-done task; no suggestions.
- Scope test: an item for a task the reader cannot see is not listed to that reader.
- Wording check: the same task has the identical title in the open list, the queue row and
  both drawers.

## Open questions

1. Should approving always complete the task, or should the approver choose "approve and keep
   the task open" for tasks that need several submissions (for example a multi-part report)?
   The prototype always completes; recommendation: add the choice only if real use needs it.
2. Who generates the suggestions when no AI key is configured? Recommendation: none, show
   "No follow-on tasks suggested", never invent them.
3. Should adding several suggestions be one click ("Add all")? Recommendation: no, so each is
   a deliberate choice.
