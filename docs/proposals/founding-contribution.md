# Proposal: the founding contribution

**Status:** Proposal (suggestion, not committed) · **Serves:** Managers in control ·
**Rough size:** Small — two paragraphs of prose, no code

## Problem

A project's `main` workstream is created with `whys: []`, and nothing pushes it
out of that state on its own. Until somebody calls `contribute`, the rendered
context is literally *"No context yet."*

That emptiness — not any single screen — was the most repeated complaint in the
2026-09-01 walkthrough ([#70](https://github.com/StatsLateral/teamctx/issues/70),
step 8 of [#66](https://github.com/StatsLateral/teamctx/issues/66)). A manager
finishes setup, connects a client, and finds a project that knows nothing. The
thing they have to do next is the one thing nothing tells them to do.

## Why this needs no code

Every mechanism is already here:

| Piece | Where |
| --- | --- |
| Write immediately, skipping the queue | `contribute` already takes `apply: true` |
| Only the manager may | `assertManager`, already enforced on that path |
| The creator *is* the manager | pinned at `init` — and now pinned to an identity they can actually present |
| Free text becomes why/what/how | server-side distillation, already how every contribution works |
| Is the project empty? | `get_status` already returns `totalWhys` |

So the agent never has to structure anything or learn a schema. It only has to
know **when** `apply: true` is the right call. That is guidance, and guidance is
what `mcp/instructions.js` is for — shipped in #59 for exactly this class of
problem.

## Design

Two prose edits to `mcp/instructions.js`. No schema change, no new tool.

**1. Manager sequence, step 3.** Append: when `get_status` shows
`totalWhys: 0`, this is the founding contribution — call `contribute` with
`apply: true` rather than queueing the manager's own first message for the
manager to approve. And whether the source is a long conversation they already
had or one sentence they just typed, the call is the same: summarize what you
were told, do not ask them to restate it in teamctx's terms.

**2. The "does not land, it queues" bullet.** Carve out the one exception.
Every other contribution queues and should be reported as *sent for review*; the
first is the case where `apply: true` is correct, because the caller is already
the pinned manager and there is nothing yet to review against. And if
`apply: true` is refused, the caller is not the manager — the same gate as
`review_approve`, not something to retry.

### Why `totalWhys: 0` rather than "just after init"

It covers both the manager seeding a project in the turn they created it, and
one returning to a project created earlier and left empty. `totalWhys` sums
across workstreams, so it stays right even when a non-`main` workstream is
active.

## Out of scope

- **A dedicated tool, or an `init` parameter.** Considered in the design spec
  and rejected: `contribute`'s own description already says it is the only way
  context gets in, and a second entry point would contradict that.
- **A technical constraint.** Nothing stops a workstream staying empty through
  raw CLI or API use. This is the guided flow always asking, not the data model
  refusing to proceed — and that distinction should be stated rather than
  implied.
- **Pasting a transcript into the web page.** A possible page feature later, not
  designed here.
- **Workstream and task creation from that context** — #66 step 10, separate.

## Verification

1. `npm test` — the guidance has anti-staleness tests; extend them to assert the
   new text landed, matching `/totalWhys/` and the founding-contribution
   language, in the same style.
2. No new integration test for `contribute({ apply: true })` — that path is
   already covered by the member and hosted-init regression suites.
3. By hand, which is the only test that proves the point: connect a fresh
   client as a manager with an existing conversation, ask it to set a project
   up. It should call `contribute` with `apply: true` for the founding message,
   `totalWhys` should be greater than zero straight after, and no
   `review_approve` should appear anywhere in the sequence.

## The risk worth naming

This is prose in a field whose delivery varies by client. A host that ignores
`instructions` gets none of it — and unlike the rest of that file, this part has
no tool-description half to fall back on, because the trigger is a *condition*
(`totalWhys: 0`) rather than a tool. `contribute`'s own description can carry a
short version, and should, so the guidance degrades rather than disappears.
