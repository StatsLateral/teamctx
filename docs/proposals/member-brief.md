# Proposal: the one thing a member reads before they start

**Status:** Proposal · **Serves:** Managers in control · Structured workstreams ·
**Rough size:** Small — one read across things that already exist ·
**Issue:** [#83](https://github.com/StatsLateral/teamctx/issues/83)
· **Depends on:** [#80](https://github.com/StatsLateral/teamctx/issues/80) (merged compile output)
· **Design spec:** `docs/superpowers/specs/2026-09-09-context-inheritance-and-membered-onboarding-design.md`

## Problem

Somebody is invited to a project, connects, and asks their assistant what they
should be doing. The best answer available today is `list_tasks --mine`: a bare
list of titles. No sense of what the project is for, no sense of which part of
it they are on, and nothing saying "read this before you touch anything".

So the assistant does what assistants do — it starts working. It contributes,
it marks things done, it proposes changes to a tree it has not read. The member
finds out what the project was about from the wreckage.

The design spec states this as the second of two governance rules, the pair to
the one #82 enforces. **#82 guarantees there is something to read. This is the
reading.** One is worth little without the other: a guaranteed-non-empty context
nobody opens is the same as no context.

## What changes

### 1. One view, three parts

`my_brief` over MCP, `teamctx brief` in the terminal. Read-only, and it spends
no AI call — everything in it was compiled when it was written.

- **Their work.** The tasks assigned to them, with status, grouped by where the
  work sits rather than in one flat list, because "which of these is on my
  thread" is the first thing anyone asks.
- **Their context.** The compiled view #80 already produces: the project tree,
  then their own workstream's branch beneath it. Not a dump of every workstream
  — a member scoped to one thread gets the coherent half of the project, which
  is the entire point of the inheritance model.
- **One line of framing.** Where they are and what to do with the page: read
  this, then pick something up.

### 2. It reads, it does not recompile

The brief serves what is already on disk — the compiled project page and the
compiled workstream page, plus the role file if they have a role. Regenerating
would make the cheapest and most frequent call in the product the one that
spends an AI call, and a member's assistant is told to open this first, every
time.

The consequence is that a stale compiled page shows up here. That is a reason to
keep compilation honest, which #80's recompile pass now does, rather than a
reason to make this call expensive.

### 3. It knows who is asking

No name argument. The server already knows the caller, the same way
`list_tasks --mine` does, and asking a member what they are called in a project
they just joined is the failure this whole surface exists to avoid.

A member scoped to workstreams sees those. A project-wide member sees the
project. The manager gets the same view as anybody else, which is the whole
project, and it is a reasonable thing for them to read too.

### 4. It becomes the first step in the agent guidance

`mcp/instructions.js` lists what a member's assistant does when somebody picks
up work. `list_tasks` with `mine: true` is step one today. The brief replaces it
there, and `contribute` and `task_done` move below it, so the sequence reads:
understand, then act.

## Decisions taken here

**No AI call, ever.** Stated as a property rather than a current implementation
detail, because the first person to "improve" the brief by summarising it would
turn the read-before-you-write step into the most expensive call in the product.

**The role is whatever role they hold, not a membership model.** The issue
mentions naming the role "if the manager chose a named-role model". #81 proposes
membership models but stores none — they are a proposal to a manager, not a
setting. So this reads the roles that actually exist in config and names one
bound to the member's workstream. If membership models are ever stored, this
reads them instead without changing shape.

**Grouped by workstream, including the project.** Tasks at project level are a
group like any other, named after the project rather than left unlabelled.

**It does not mark anything as read.** Tempting, and wrong: a read receipt makes
an honest "I read it" indistinguishable from an assistant that opened the page
and ignored it.

## Verification

- Returns the caller's tasks only, with no name passed in.
- Groups them by workstream, with project-level tasks under the project.
- Carries the compiled context: the project tree, then the caller's own
  workstream beneath it.
- A scoped member gets their own workstream and the project, and no sibling.
- A project-wide member gets the project.
- Spends no AI call — asserted, not assumed.
- Works on a project with no workstreams at all, which is the ordinary shape.
- Says something useful when the member has no tasks yet, rather than returning
  an empty list.
- Appears in the member sequence in the agent guidance, ahead of `contribute`.

## Out of scope

A brief for somebody who is not on the roster. A manager view of what every
member would see. Both are reasonable and neither is this.
