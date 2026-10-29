# Proposal: tasks the AI proposes read as work a person picks up

**Status:** Implemented · **Issue:** [#175](https://github.com/StatsLateral/teamctx/issues/175)
· **Base:** `main`

## What goes wrong

When a brief comes in, the distiller (`proposeDiff` in `src/ai.js`) may propose
`addTask`s. All it is told about one is `"title": "a concrete piece of work"`.
Given a brief whose rules describe an editorial workflow, it turns the workflow's
steps into tasks: "Score and rank the seven extracted content atoms…", "Draft
native posts for the top-ranked atoms…". Those are steps for an assistant, not
work somebody picks up and finishes. And a brief sent as source material, which
says so, still gets tasks.

#154 already made the tasks a separate decision at approval. This is about what
they say.

## What changes

1. **What the distiller is asked for.** A task is one piece of work a person
   picks up and finishes, in one plain sentence that starts with what they do
   and names the thing ("Write the launch post for article 1"). Not a step in an
   assistant's or an AI's process, never addressed to one, and no internal
   words. A rule that describes how work is done is not a list of tasks: its
   steps are not proposed as tasks. `owner` is set only when the input names who
   will do it.
2. **Where a task came from.** `addTask` takes `from`: the id of the decision or
   rule it comes from, or the `ref` of one proposed alongside it. The proposal
   keeps that record's wording beside the task, so the manager sees why it's
   proposed, on the page and in the chat read-back: *Add a task: Write the
   launch post — from Rule: "Every article gets a launch post"*. On approval the
   task keeps `from` as the record's id. A `from` that names nothing is dropped,
   the task is kept.
3. **"No tasks" is honoured.** The distiller is told to propose none when the
   input says it is only source material or says not to make tasks. Because
   that is an instruction from the person, it is also enforced in code: when the
   text says so, every `addTask` is removed from the proposal.
4. **A check on what comes back.** `taskTitleProblem(title)` in
   `src/task-wording.js` returns why a title is not a person's task, or `null`:
   - it addresses an assistant (`you`, `your`, `Claude`, `the AI`, `the
     assistant`, `the model`, …);
   - it doesn't start with something a person does: it starts with an article,
     a pronoun, a number, or an `-ing` word ("The posts…", "Drafting…");
   - it doesn't name the thing: fewer than two words, or the thing is only "it",
     "this" or "them".

   `proposeDiff` drops a proposed `addTask` that fails it (contradiction indices
   are kept pointing at the right operations). The check is kept narrow on
   purpose: it removes only what is clearly not a person's task, never a task
   that is merely worded differently.

Not here: the existing tasks, and tasks a person adds themselves (`task_add`);
only what the AI proposes.

## Tests

- The prompt says what a task is, asks for `from` and `owner`, and says to
  propose none for source material or "no tasks".
- `taskTitleProblem` on sample titles: ones addressed to an assistant, starting
  with "The…" or "Drafting…", or naming nothing fail; plain ones pass. (The
  issue's "Score and rank the seven extracted content atoms" is a well-formed
  sentence; what keeps it out is the prompt's rule about workflow steps.)
- Sample briefs, with the model's answer mocked: an editorial-workflow brief
  whose answer addresses an assistant keeps only the person's tasks; a brief
  that says it is source material keeps none, whatever the model returned; a
  contradiction after a dropped task still points at its operation.
- `from` resolves to an existing record or one proposed with it, shows in the
  read-back, and lands on the approved task as an id.

## Plan

- [x] `taskTitleProblem`, tests
- [x] Prompt, the check and "no tasks" in `proposeDiff`, tests
- [x] `from` on `addTask`: shown in the read-back and on the page, kept on the
      task, tests
- [x] CHANGELOG
