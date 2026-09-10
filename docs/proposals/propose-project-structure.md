# Proposal: the AI proposes how a project is structured

**Status:** Proposal · **Serves:** Structured workstreams · Managers in control ·
**Rough size:** Medium — one proposal call and one accept flow, both extending
what already exists · **Issue:** [#81](https://github.com/StatsLateral/teamctx/issues/81)
· **Depends on:** [#80](https://github.com/StatsLateral/teamctx/issues/80)
· **Design spec:** `docs/superpowers/specs/2026-09-09-context-inheritance-and-membered-onboarding-design.md`

## Problem

Once #80 lands, a project has a Why/What/How tree and nothing to say about how
the work or the people are organised. The manager has to decide two things — which
parts of the tree become workstreams, and how a member's role in each is
expressed — and today they get no help with either.

`suggest_workstream_splits` proposes workstreams. `suggest_roles` proposes roles.
Neither proposes how people are *placed*, and the two run separately, so a
manager gets two disconnected lists and has to hold the relationship between them
in their head.

## What the AI proposes

One call, two answers, because they are one decision:

- **Which Whys become workstreams.** The project tree is the input; each proposal
  names a Why (or a small group), a suggested workstream name, and a one-line
  rationale.
- **Per workstream, a membership model** — `assigned-tasks`, `named-role` or
  `workstream-position` — with a one-line rationale of its own.

The membership model is proposed, never fixed by the product. One manager runs a
pure task-list project where a member's role *is* their assigned tasks; another
gives a member a whole workstream to own. Both are real, and choosing one for
everybody would be the product making a decision that belongs to the person
running the team.

## What it does not do

**Nothing auto-applies.** The manager accepts, renames or skips each proposal,
exactly as `workstream split` already works. A proposal call writes nothing;
`workstream_split` is still the thing that writes.

This matters more here than for splits. A split moves Whys; a structure proposal
also implies who works where, and a wrong guess applied silently would put people
on the wrong side of a boundary #77 then enforces.

## Shape

Extends the two existing surfaces rather than adding a third:

- `suggestWorkstreamSplits` reads the *project* tree instead of the active
  workstream, since after #80 that is where the whole tree lives.
- The proposal it returns gains a `membership` field per split.
- `suggestRoles` keeps working for a single workstream, and the combined call
  returns what it would have returned per proposed workstream, so a manager sees
  roles and workstreams together instead of in two passes.

One call, `propose_structure`, returning `{ workstreams: [{ name, rationale,
whyIds, whys, membership: { model, rationale }, roles: [...] }] }`. The accept
path is the existing one.

## Deliberately not included

- **Assigning actual people.** The proposal says *how* membership is expressed,
  not who is in it. Putting names in would make an AI suggestion look like a
  decision about a colleague, and `member_add` / `member_scope` already exist for
  the real thing.
- **Applying anything.** See above.
- **Proposing tasks.** #66 covers AI-driven task creation; this stops at
  structure so the two do not overlap.

## Open questions

1. **Does a proposal survive the tree changing under it?** `workstream split`
   already fails when the source has moved on — a proposal names `whyIds`, and
   those can be gone by the time the manager accepts. Worth deciding whether that
   is a refusal or a re-proposal.
2. **What happens on a project with no workstreams yet?** After #80 that is the
   normal state, not an edge case: a project tree and nothing else. The proposal
   is most useful exactly there, so it must not require an existing workstream to
   read from.
