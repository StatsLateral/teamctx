# Proposal: nobody is brought onto an empty project

**Status:** Proposal · **Serves:** Managers in control · Structured workstreams ·
**Rough size:** Small — one check, two call sites, no new storage ·
**Issue:** [#82](https://github.com/StatsLateral/teamctx/issues/82)
· **Depends on:** [#80](https://github.com/StatsLateral/teamctx/issues/80) (project context layer)
· **Design spec:** `docs/superpowers/specs/2026-09-09-context-inheritance-and-membered-onboarding-design.md`

## Problem

A manager can add someone to a project the moment it exists, before a single
sentence of context has been written. That person connects, their assistant
pulls their brief, and the brief says *"No context yet."*

That is the worst possible first impression of the product, and it is entirely
avoidable: the manager is right there, mid-conversation, and adding the missing
context is one sentence of work. Nothing asks them for it.

The design spec states this as a governance rule: **context cannot be empty when
a person is brought on.** #72 enforced the spirit of it at project founding, by
applying a manager's first contribution immediately instead of queueing it for
their own review. Nothing enforces it at the point where it actually matters —
the moment someone else is invited in.

After #80 the rule has two halves, because a member now reads two trees. Their
compiled view is the project's context with their workstream's own beneath it.
Either half being empty produces a brief that does not stand up.

## What changes

### 1. A check in front of joining the roster

One function, `assertJoinableContext`, answering: is there enough written down
for this person to read on their first day?

- **Project context must be non-empty.** Always, for every member.
- **Each workstream they are being scoped to must be non-empty too.** Only for
  a scoped member.
- **A project-wide member is gated on project context only.** They inherit the
  whole project, so there is no second half to check.

Non-empty means at least one Why. Not a What, not a How — a Why is the smallest
thing a person can open and understand, and requiring more would make the gate
an opinion about how much detail is enough.

### 2. Two call sites, one implementation

`addMember` and `setMemberWorkstreams` both call it, and every surface routes
through those two. The CLI `member add`, the `member_add` tool, the
`member_scope` tool and the hosted server all inherit the gate without knowing
it exists.

This is deliberate after #75, where `contribute` was implemented twice and the
CLI silently bypassed a policy the tool honoured. A rule that lives in the core
cannot be walked around by picking a different door.

In `addMember` the check runs **before the GitHub invite**, not after. Inviting
somebody to a repository and then refusing to put them on the roster is a worse
outcome than either succeeding or failing cleanly.

### 3. The refusal names the fix

No teamctx vocabulary, per the agent guidance in `mcp/instructions.js`. The
person reading this asked their assistant to add a colleague; they should not
have to learn what a Why node is to understand what went wrong.

> **Project empty:** "This project has nothing written down yet. Tell me what
> it's about and I'll add it, then we can bring Priya on."

> **Workstream empty:** "\"Delivery\" has nothing written down yet. Tell me what
> that part of the work involves and I'll add it, then we can put Priya on it."

Both name the next action, and both are things the assistant can then do
immediately with `contribute` — no new tool, no second step for the manager.

### 4. Said honestly, like #77

The gate holds wherever the command runs, which is every path the product
offers. It is not a wall against someone holding a clone, who can write a
roster entry into `config.json` by hand and commit it.

That is worth stating rather than implying, the same way workstream scoping
states where it stops. This guards against an accident — a manager moving fast,
inviting someone before there is anything to read — not against a person
determined to get around it.

## Decisions taken here

**An empty workstream fails the whole call, not part of it.** Adding someone to
two workstreams where one is empty could put them on the other and report it.
It will not. A member silently scoped to less than the manager asked for is a
worse failure than a refusal, because nobody finds out until that person cannot
see something they were supposed to.

**No override flag.** A governance rule with a bypass argument in the same call
is not a rule. If a project genuinely needs someone on it before there is
anything written, one sentence of context is a smaller ask than a flag that
would then exist forever.

**Removing a member is not gated.** Taking somebody off a roster does not put
them in front of an empty brief.

**Nothing new is exposed to see it coming.** `get_status` already reports the
project's Why count and a per-workstream count, so an assistant that checks
before acting can already tell. The gate is the backstop, not the only signal.

## Verification

- `member_add` refused, with the plain-language error, when project context is
  empty.
- Refused when the named workstream is empty, even though the project is not.
- Allowed once both are non-empty.
- A project-wide member is gated on project context alone, and goes through on
  a project with no workstreams at all.
- `member_scope` is gated the same way when it moves someone onto a workstream.
- Clearing a scope back to project-wide is gated on project context only.
- The refusal happens before any GitHub invite is attempted.
- The wording contains no teamctx vocabulary.

## Out of scope

The member's brief itself — one read-only pull of their tasks plus their
compiled context — is #83. This proposal only guarantees there is something
worth reading when they get there.
