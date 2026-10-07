# Task history: completed tasks struck through, and an audit trail in every task drawer

**Date:** 2026-10-07
**Status:** Design confirmed in the demo conversation (UI fix 6 of a series); spec pending review
**Builds on:** [context model and numbering](2026-10-07-context-model-and-numbering-design.md) (section 5, auditability), [Waiting on you icons](2026-10-07-waiting-on-you-icons-design.md)
**Prototype:** the internal prototype (synthetic data)

## Problem

A task's drawer says who owns it and what state it is in. It does not say where it came
from, who proposed changes to it, who approved it, or when. In a product whose point is
governance and auditability, the most basic question a manager or an auditor asks about a
piece of work ("who asked for this, and who said yes?") has no answer on the page. Completed
tasks also look like open ones that happen to be faded, so a finished task is easy to
mistake for live work.

## Goals

1. A completed task reads as completed at a glance.
2. Every task drawer shows its history: every submission (there can be several) with who made
   it and how, who approved it and when, and when it was completed.
3. A task that is not yet approved shows the same history with no approval line yet.
4. Simple data, simple display. No new screen.

## Non-goals

- A full change-log view with before and after text. That is the audit views in the
  [context-model spec](2026-10-07-context-model-and-numbering-design.md) (section 5.3).
  This fix is the per-task slice of the same data.
- Editing or deleting history. It is append-only.
- Comments or discussion on a task.
- History for records. Records are covered by the audit views later.

## Design

### 1. Completed tasks are struck through

- In every task list (including "Show history"), a done task's title has a line through it,
  on top of the existing faded style. The key (for example `2.3`), owner and status stay
  readable.
- In the task drawer, a done task's title has the same line through it.
- Done tasks in a person's task list (in the agent or external-talent drawer) are struck
  through the same way.

### 2. History section in the task drawer

**Where:** directly under the task's details (owner, where, status, where it came from) and
above the assistant buttons, so the audit is visible without scrolling and does not push the
main action far down.

**What it shows:**

1. A one-line **status**:
   - "Approved"
   - "Approved · a new submission is waiting" (an approved task that has a pending change in
     the review queue)
   - "Not approved yet"
2. A **list of events**, oldest first, one per line: the date, who, and what happened.

| Event | Reads as |
|-------|----------|
| Submitted | "**Jordan** submitted it through an assistant" (also: as an agent, from the command line, on the web, by import) |
| Approved | "**Maya** approved it" |
| Rejected | "**Maya** rejected it" (shown when a submission about this task was turned down) |
| Completed | "**Alder Health Agent** marked it done" |
| Reopened | "**Maya** reopened it" |

- Names use the same person and agent chips used elsewhere, so an agent is visibly an agent.
- A submission still waiting in the review queue appears in the list with a "waiting for
  approval" tag and no approval line below it.
- A task can have **several submissions**: the original, and every later proposed change
  (for example a draft from an agent). Each is its own line, each followed by its own
  approval, rejection or "waiting".
- The date shows as a date; the exact time is available as a tooltip.

**Unapproved items.** An item still in "Waiting on you" has an item number from its workstream's running list (for example `1.6`) but is not a task yet, and shows
the same History section in its review drawer: "Not approved yet", then its submission with
the "waiting for approval" tag. A proposed change to an existing task shows that task's whole
history, with the new submission at the end.

Mockup:

```
HISTORY
Approved · a new submission is waiting
2026-09-30  [Maya] submitted it through an assistant
2026-09-30  [Maya] approved it
2026-10-06  [Content Writer] submitted it as an agent   (waiting for approval)
```

### 3. Data: one flat list of events per task

An event is:

```
{ at, by, did, via?, contribution? }
  at            when (date and time)
  by            the person or agent id
  did           submitted | approved | rejected | completed | reopened
  via?          assistant | agent | cli | web | import      (submitted only)
  contribution? the contribution it belongs to              (submitted, approved, rejected)
```

Nothing new is stored on top of what the product already keeps. The list is **derived**:

| Event | Comes from |
|-------|------------|
| submitted | each contribution that touched the task (`sourceContributionIds`; the contribution holds author, source and time) |
| approved / rejected | the approval or rejection of that contribution (see "What is missing") |
| completed / reopened | the task's done state change (`doneAt` today) with who made it |
| waiting | the review queue, for any queued item that targets this task |

When the audit change-set log exists (`changes.jsonl` in the context-model spec), the task
history **is** that log filtered to the task, and nothing here needs to change in the display.

### 4. What exists today and what is missing

Per a read of `src/ops.js` and `cli/commands/task.core.js` (not run in this session): a task
already stores its creation date, the contribution that created it and later ones
(`sourceContributionIds`, `createdBy`), and when it was completed (`doneAt`). Contributions
carry author, source and time. Missing:

- **Who approved, and when.** Tasks and contributions do not record the approver. Add
  `approvedBy` and `approvedAt` to the contribution when it is approved (by review, or by a
  manager who sends it with apply).
- **Who completed or reopened it.** Today `doneAt` has no actor. Add `doneBy` (and a reopen
  event).
- **Rejections.** A rejected contribution should keep its reason and approver, so it can be
  shown (the review step currently drops it).

These are three small fields on data that already exists, and they are what the context-model
spec's change sets need anyway.

### 5. Scope and visibility

A person who can open a task sees its history. The history never reveals more than the task
already does: names of people or agents the reader may not see are shown as "someone", and a
rejected or pending submission that the reader would not otherwise see is not listed to them.

### 6. Edge cases

| Case | Behaviour |
|------|-----------|
| Task created before history existed | One line: "Added" with the date, plus "Approved" only if the data has it. No invented events. |
| Task moved to another workstream | A line "moved from 3.2 to 4.1" by who and when, using the number alias in the context-model spec. |
| Several approvals on one day | Listed in order; the time tooltip separates them. |
| Reopened then completed again | Both pairs listed. |
| Very long history | Show the latest events and a "Show earlier" link; nothing is dropped. |

### 7. Why this is right for the next 6 to 12 months

- Work will increasingly be proposed by agents. "Which agent asked for this, which human
  approved it, and when?" has to be one glance away, not a search through logs.
- It is the smallest visible piece of the audit trail, and it uses the same events the full
  change log will, so it grows into it instead of being replaced.

## Existing open source first

Nothing to borrow. It is a list of events built from data the product already stores, and a
small list in the existing drawer. Activity-feed and audit libraries are far heavier than one
derived list. The "git log for a file" idea is the model, and on GitHub the same facts are in
the commit history, but the page reads the product's own events so it works on any storage.

## Changes

- `src/views/project.js` and the drawer script: strike through done tasks in lists and the
  drawer title; add the History section to the task drawer and to the review drawer.
- A function that builds the event list for a task from its contributions, the approval
  records, the done state and the review queue (server side, scope-filtered).
- Data: `approvedBy` / `approvedAt` on contributions at approval; `doneBy` with `doneAt`;
  keep rejected contributions with their approver and reason.
- No change to the review policy, scope enforcement or the connector.

## Testing

- View test: a done task row and drawer title are struck through; an open task's are not.
- History test: a task with one submission and one approval lists both, oldest first, with
  the approver and date; the status line reads "Approved".
- History test: a task with an approved submission and a queued one shows "Approved · a new
  submission is waiting" and the queued one tagged "waiting for approval".
- History test: an item only in the review queue shows "Not approved yet" and no approval line.
- History test: completion shows who and when; reopening and completing again lists both.
- Old data: a task with no approval data shows "Added" and no invented approval.
- Scope test: a reader who cannot see an agent or person sees "someone" and no pending item
  they cannot see.
- Regression: the drawer's assistant buttons, sources and context sections are unchanged.

## Open questions

1. Should rejected submissions be shown on the task, or only in the review queue's own history?
   Recommendation: show them, since the audit question includes "what was turned down".
2. How long are "Show earlier" and the time tooltip needed, for a task with only a few events?
   Recommendation: only when there are more than about ten events.
