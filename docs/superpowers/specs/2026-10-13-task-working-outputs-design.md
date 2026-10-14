# Working outputs: what a person produces on a task, kept, iterated and submitted

**Date:** 2026-10-13
**Status:** Design agreed in conversation, open questions decided 2026-10-13; spec pending review
**Builds on:** [task submissions and next steps](2026-10-07-task-submissions-and-next-steps-design.md) (#144, not yet built), [task history](2026-10-07-task-history-design.md), [context in the assistant](2026-10-07-context-in-the-assistant-design.md)

## Problem

A team member picks up task 1.4, "Draft the partnership LinkedIn post", in their assistant and
works until the post is good. They send it back with contribute. What happened to it, from a
real project (names generalised):

- The **whole post was submitted**, with reviewer notes, and marked "for review, not published".
- The system has no place to keep a piece of work on a task. It can only add a record (a
  decision, rule, assumption) or retitle the task. So the AI wrote a *decision describing* the
  draft ("the text beginning 'Partnering is not a concession…', about 230 words") and **dropped the
  post itself**. The task page still says "No summary recorded".
- The AI also wrote things nobody said: "the approved draft", "the draft is accepted as the
  settled content", "the task is closed". The contributor said "for review". And the change it
  proposed did not close anything; it appended "Draft complete and ready for review" to the
  task's instruction.
- The **manager sees the AI's description, not the post**, so the approval has nothing real to
  review. Their assistant, given only that description, then reviewed the description and
  misreported an example in it.
- The **contributor sees nothing** until a manager approves. Coming back to the task the next
  day, their assistant starts from the bare instruction, as if no work had been done.

This is the gap #144 already names ("a draft is work product, not context"). #144 says what
approving a submission should do. It does not say where submissions live while people iterate
on them, which is what this spec adds.

## Goals

1. A task can hold **several working outputs**, added one at a time as people iterate. An output
   is the thing itself (the post, the plan, the analysis), word for word.
2. Anyone who picks up the task, member or manager, **sees the outputs and the notes on them**,
   and their assistant works from them: it starts from the latest output instead of from nothing.
3. Saving work is **not** a context change and needs no approval. Submitting for approval is a
   separate, deliberate step, and the person chooses **which outputs** go (one, several or all).
4. The manager reviews the **actual outputs**, and their assistant can help them reach a useful
   response (approve, or reject with a reason the contributor can act on).
5. The AI never states a status nobody gave it ("approved", "settled", "closed").

## Non-goals

- Publishing or sending anything (as in #144; that is a separate task with its own approval).
- Binary files, images, or documents other than text. Text outputs only for the first version.
- Several people editing one output at once. Outputs are written once and never edited; a
  change is a new output (below).
- Automatic merging of outputs. The person says which to submit.

## Design

### 1. What a working output is

A working output belongs to one task. It holds:

| Field | Meaning |
|---|---|
| `id` | Stable id. |
| `task` | The task's id. |
| `title` | A short label for the list, assistant-written ("Draft 2, trimmed to 150 words"). |
| `body` | The output, verbatim. Text, with a size limit (decided in section 6). |
| `author` | Who made it, with how (assistant, cli, web), as contributions record today. |
| `at` | When. |
| `prompt` | The instruction the person gave that produced it, so the next round can see what was asked. |
| `basedOn` | The id of the output this one was iterated from, or none. |
| `notes` | Reviewer or author notes that came with it (the "can be trimmed to about 150 words"). Kept separate from `body`. |
| `state` | `working`, `submitted`, `accepted`. |

**Append-only.** An output is never edited in place. Iterating makes a new output with
`basedOn` pointing at the one it came from. This keeps the history honest (what was produced,
by whom, in what order) and cannot lose work when two people save at the same moment.

**Stored where the team's data already lives** (the project's repository; see the data
ownership principle), one small file per output under the task, not a field on the task and
not in the contribution log. The same reasoning as the approvals files in the task-history
spec: a file per item cannot be lost by a concurrent write.

### 2. Picking a task up

When a person (member or manager) opens a task in their assistant, the assistant is given, in
this order:

1. the task's instruction (unchanged),
2. the context that applies to it, as today,
3. **the working outputs**: the latest in full, and the earlier ones as a list (title, author,
   date, state) that the assistant can open if asked,

So "continue", "trim it to 150 words" and "go back to the first version" all work without the
person pasting anything. A new output made this way sets `basedOn` to the one it started from.

The task drawer in the project page shows the same list under a **Working outputs** heading:
title, author, date, state, newest first; opening one shows its `body` and `notes`. Visible to
everyone who can see the task (scope rules apply; an out-of-scope task shows nothing).

Saving an output does not appear in "Waiting on you" and nobody is asked to approve it.

### 3. Submitting for approval

Submitting is the point where work becomes something the manager is asked about.

- The person says which outputs go: the latest by default, or any chosen ones, or all.
  Chosen outputs move to `submitted`.
- The submission is a queue item with `forTask` (as in #144) and **the chosen outputs attached
  in full**, not a summary of them. The queue row reads as the task (#144 section 1), with the
  line "Submitted: " plus the outputs' titles.
- The person may add a message ("this one is the version I'd use"). It is shown to the manager
  as the person's own words.
- Anything the person also wants added to the project's context (a real decision, a new
  assumption) is a **separate proposal**, not something the AI infers from the output. The AI
  may offer it ("this draft assumes X; add it as an assumption?") and the person decides.

### 4. What the manager sees and does

The review drawer shows, for a task submission:

- the task (title unchanged),
- **each submitted output in full**, with its notes and the prompt that produced it,
- the person's message,
- the "Checked against what is already approved" section as today, now run on the output's
  text, so a problem like a misdescribed example is flagged against the project's own context.

Two decisions on work submitted for a task:

- **Accept** (what `review_approve` is called for such an item): the chosen outputs become
  `accepted` and the task is done and **closed**. ~~Nothing is written into the context as a record.~~ (Superseded by the accepted-work spec: accepting records the acceptance in the context, plus any facts and task changes the manager picks.)
- **Feedback** (what `review_reject` is called for such an item): the task **stays open**. The
  feedback must say what to change, because it is attached to the outputs and is what the person
  reads next. They carry on from the same outputs and submit again. Only the label and the
  requirement for a reason are new; the stored file and the tool are unchanged, and any other kind
  of item is still Approved or Rejected as before.

The task closes only after Accept. Back-and-forth can still happen outside teamctx.

### Accepted tasks are closed

Once a task has an accepted submission nobody works on it any more, the manager included: no
more outputs, no more submissions, it cannot be reopened and it cannot be removed. Anything
further is a **follow-on task**, which anyone can add as usual. Whether a task is accepted is
read off the approvals, so a task somebody simply marked done by hand is not locked. A later
version will let a manager remove an accepted task from the context (tracked as a post-MVP issue, #202).

- **Manager's assistant helps with the response.** In "Review with AI" the assistant is given
  the outputs themselves, the task and the context. It can summarise what is good and what is
  not, point to the lines that disagree with the project's context, and **draft the reason**
  for the feedback, written so the contributor can act on it. The manager edits and sends it;
  the assistant never decides.

A manager can also add an output to a task (an edited version, a counter-draft). It is a
normal output attributed to them, so nothing the contributor wrote is overwritten.

### 5. The AI's wording rule

Whatever the AI writes about a submission (the summary, the line on the queue row) states only
what the person said and what was attached:

- it never uses "approved", "accepted", "settled", "final" or "closed" for work nobody has
  approved, accepted or closed;
- it never changes a task's title or instruction to record progress (progress is the task's
  state and its outputs, not its wording);
- a summary that says something will happen on approval must match what approval does (checked
  by a test, below).

### 6. Limits

- One output body: up to a size set in code (suggest 50,000 characters, the same order as a
  contribution's limit), refused with a clear message above it, never truncated silently.
- Outputs per task: no hard cap in the first version; the assistant is given the latest in full
  and the rest as a list, so a long history does not grow the prompt.

## Related fixes this depends on or finds

- **`touchesTask`** (`src/task-history.js`) counts only `editTask`/`removeTask`. A submission
  that attaches to a task another way does not show in that task's history. With outputs and
  `forTask`, history follows `forTask` and the outputs, not the operations.
- **Item numbering** (#196) already gives a submission about one task that task's number.
  With `forTask` this becomes direct: the number is the task's number because the item is for
  that task.
- **A member's view of their own work**: today a member sees none of their waiting items. With
  outputs, a member always sees their own outputs and their state, and sees the manager's
  feedback when there is some. They still do not see other people's waiting items; the
  manager's queue stays the manager's.

## Existing open source first

- **Versioned text:** git is already the store. An output per file gives history, authorship
  and diffs for free; `jsdiff` (`diff` on npm) can render "what changed since the last output"
  if wanted. Nothing else is needed for versioning.
- **Document editors / CRDT libraries** (Yjs, Automerge, TipTap): built for several people
  editing one document live. This design deliberately avoids that: outputs are written once.
  Not borrowed; revisit only if real-time co-editing becomes a goal.
- **Review workflow engines:** same conclusion as #144: the approver chooses, not a fixed process.
- **Only teamctx should build:** linking an output to a task, what the assistant is given when
  a task is picked up, and the submit/approve/turn-down path with the output attached in full.

## Changes

- `src/storage.js`: read and write outputs (one file each, under the task); list by task.
- `mcp/server.js` and the tool descriptions: the task-read tool returns the outputs as in
  section 2; one new tool saves an output; a second tool, `task_submit`, sends the chosen
  output ids for approval. It is separate from `contribute` so that no AI classification runs on
  it and a person can submit without having to write any text.
- `cli/commands/task.core.js`: `submitTask` queues the chosen outputs for the task with no AI step,
  so no record is inferred from them. Records come only from separate proposals.
- `src/ai.js`: the wording rule (section 5); the review step receives the outputs.
- `src/review.js`: accepting or giving feedback on a `forTask` submission sets the outputs' states and
  the task's state, as in #144.
- `src/oauth/project-view.js` and the views: Working outputs in the task drawer; a member's own
  outputs; the output text in the manager's review drawer.
- `src/task-history.js`: history follows `forTask` and outputs.

## Testing

- Saving two outputs on a task keeps both; the second has `basedOn` set to the first when it
  started from it; neither is changed afterwards.
- Picking the task up gives the latest output in full and the earlier ones as a list.
- A member sees the task's outputs and the manager's reason on a turned-down one; they do not
  see another person's waiting submission.
- Submitting one of three outputs queues the item with that output attached verbatim and the
  other two still `working`.
- **No record is written** by approving a task submission; the task's title is unchanged.
- Feedback leaves the task open and needs a reason; the person can submit the same outputs again. Accepting closes the task; saving or submitting on it afterwards is refused, and so are reopening and removing it.
- The AI wording rule: a summary for a "for review" submission contains none of the banned
  status words; a summary that claims the task will close is rejected unless approval does close it.
- The real case as a fixture: a post with reviewer notes, submitted "for review", produces a
  queue item whose text is the post, whose summary says nothing was approved, and whose
  proposed change does not alter the task's title.
- Scope: an out-of-scope task's outputs are not in the page payload.

## Decisions (2026-10-13)

1. **Visibility:** a working output is visible to everyone who can see the task, before it is
   submitted.
2. **Not accepting:** the decision is called **Feedback**, not Reject, for work submitted for a
   task. The task stays open and closes only after Accept. (Replaces the earlier "no new state".)
3. **Manager's own outputs:** a manager can accept an output they wrote without a second approval.
4. **Retention:** old outputs are kept, for auditing.
5. **Accepted tasks are closed** (2026-10-14): no more work on them, follow-on tasks only. Removing
   an accepted task from the context is post-MVP. Accepting adds nothing to the context beyond the task
   being done: superseded by the accepted-work spec, where accepting records the acceptance in the
   context.
6. **The AI's wording** (2026-10-14): the AI may not say work is approved, accepted, settled, final,
   closed or done unless the contribution says so, and may not add progress to a task's title.
   Enforced in the prompt and by a check on the summary and on title edits.
