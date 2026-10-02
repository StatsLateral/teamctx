# Proposal: new projects review everything

**Status:** Built · **Serves:** Managers in control ·
**Issue:** [#109](https://github.com/StatsLateral/teamctx/issues/109)
· **Rough size:** Small — one constant, the wording around it, and tests

## Problem

`init` records `reviewPolicy: 'additive'` for a new project
(`src/review-policy.js`, `NEW_PROJECT_POLICY`, written by
`cli/commands/init.core.js`). Under that policy a contribution whose operations
only add — `addWhy`, `addWhat`, `addHow` — becomes shared context the moment it is
distilled. No manager sees it first.

Everything around it is careful. Agents are always reviewed. Any operation that
could delete somebody else's statement queues. `reflect`, which rewrites a whole
tree, is the manager's alone. The one gap is the ordinary case: **a member's AI
can add statements straight into the context every other member's AI reads.**

That gap is where prompt injection lands. A member asks their assistant to
summarise a document or a thread; the assistant calls `contribute` with what it
read; the result is context the whole team's assistants now treat as the team's
own position. Published benchmarks put the success rate of poisoned tool output
and hidden instructions against major agents above 60%, and the consistent advice
is to keep a person in front of any AI write to shared storage
([Microsoft Security, "The state of MCP security in 2026"](https://techcommunity.microsoft.com/blog/microsoft-security-blog/the-state-of-mcp-security-in-2026/4531327),
[Aptible](https://www.aptible.com/mcp-security/mcp-prompt-injection)).

It also undercuts what the product says about itself — *nothing becomes the
team's context without the manager's approval*. The BYOAI governance review of
2026-09-30 found this to be the only place the code and that sentence disagree.

## Decision

**New projects default to `all`.** Taken by the maintainer on 2026-09-30 and
recorded on #109. This proposal is about carrying it out without breaking the two
things that currently lean on `additive`.

## What exists today

| Piece | Where |
| --- | --- |
| The policies and what each admits | `src/review-policy.js` — `POLICIES`, `isAdditive`, `needsReview` |
| What a project with nothing recorded means | `DEFAULT_POLICY = 'all'` |
| What `init` writes | `NEW_PROJECT_POLICY = 'additive'` ← the one line to change |
| Where it is written | `cli/commands/init.core.js` |
| Changing it later | `set_review_policy`, `teamctx config review-policy` |
| The queue a contribution lands in | `writeQueueItem`, `teamctx review list/approve` |

`DEFAULT_POLICY` is already `'all'`: a project that has never heard of the setting
queues everything, so upgrading has never changed anyone's behaviour. After this
change the two constants hold the same value, which is worth folding into one with
a comment saying why they were ever separate.

## The design

**1. One constant.** `NEW_PROJECT_POLICY = 'all'`. Its docblock currently argues
for `additive` — "the common case should not wait on an approval" — and that
argument has to go, replaced by the reason it lost: the axis is not whether a
contribution can destroy something, it is whether a person has seen it before the
rest of the team's assistants do.

**2. Existing projects keep what they recorded.** No migration, no rewriting
`config.json`. A project running on `additive` goes on running on it. That is not
leniency: a project already in flight has a manager who chose that, and silently
tightening it would be the same class of surprise as the gap itself.

**3. `set_review_policy` says what `additive` gives up.** A manager choosing it
should read *additions from members' AIs go live without review* in the
description, rather than discover it later.

**4. Wording follows the default** — `set_review_policy` in `mcp/server.js`,
`docs/mcp.md`, `teamctx init` output, and the CHANGELOG. Anything that says new
projects review only destructive changes becomes wrong on this commit.

## The founding contribution

The one thing this change can actually break, and the reason it is worth a
write-up rather than a one-line PR.

`contribute` with `apply: true` on an empty project writes immediately (#70,
#99). That still works, because the gate reads:

```js
const willQueue = !apply && (reviewRequired || needsReview(config, operations));
```

`!apply` short-circuits, so the policy is never consulted, and `apply: true` is
manager-gated above it by `assertManager`. **The flip does not touch this path.**

What it does remove is a safety net nobody wrote down. `apply: true` is
*guidance*, not enforcement — nothing in the code sets it, only
`mcp/instructions.js` and the `contribute` description tell the agent to. Today,
if the agent forgets, the contribution lands anyway, because the project is
`additive` and a founding contribution only adds. Under `all` it queues instead,
and a queued founding contribution leaves the project stuck:
`assertJoinableContext` (`src/context-gate.js`) reads the *shared* tree, not the
queue, so `member_add`, `member_scope` and adding an agent all refuse with "This
project has nothing written down yet" until the manager notices a queue and
approves their own opening message. The manager can still get a connector link —
`get_connect_url` is not gated on context — which makes it worse rather than
better: they can send somebody a link to a project that will not let them in.

Three ways to answer that. **The third is what was built**, and it is the one
nobody listed at first: the two above both leave `apply` as something a caller can
get wrong, and only differ in who pays for the mistake.

**Asking for `apply` without being the manager no longer fails.** The flag is
simply dropped. The contribution is logged and takes the ordinary path, and the
result carries `applyRefused: true` so the assistant says where it went. Nothing
is granted by asking — `writeTree` is never reached — and nothing is lost by
asking, which is the part that was wrong before: `assertManager` threw at
`contribute.core.js:98`, before `appendContribution` at line 121, so a member
whose assistant guessed wrong lost their text and had to write it again.

That makes the gate hold without the client having to be careful. `apply` becomes
a request rather than an assertion, which is the ordinary shape for a privileged
flag: refuse the privilege, keep the work.

The two originally weighed, kept here for the record:

**Guidance alone.** Leave the gate alone and make the instruction harder to
miss. The trigger stays the machine check, `totalWhys: 0` — not a question to the
user, because the agent already knows the answer and a user can get it wrong: a
member on an established project who answers "yes, this is my first time" would
meet a hard refusal. Two edits:

- `contribute`'s description says `apply: true` is for `totalWhys: 0` and **not**
  for bulk import. Importing a long prior conversation is the case review exists
  for — the largest body of unread text anyone will send, and the exact surface
  this change is closing. Without that sentence the flip is quietly undone for the
  biggest contributions.
- On `MANAGER_GATE`, retry the same call once without `apply` and say it went for
  review. `mcp/instructions.js` already says a refusal is "the gate working, not
  an error to retry" — true, but it never says *retry without it*, and
  `assertManager` throws before `appendContribution`, so a literal reading drops
  the member's text and makes them write it again.

**Exempt founding in the gate.** `!apply && !foundingByManager && (…)`. The
`founding` flag already exists in `contributeCore` — it is computed for the return
digest and never read by the gate — so this is two lines. It would need its own
`assertManager`, since the existing one runs only under `apply`; otherwise any
member could found a project unreviewed.

Neither was taken. Exempting founding in the gate carves a hole for a case that
no longer hurts anybody, and guidance alone leaves a client's mistake costing a
member their words. With a refused `apply` now harmless, the remaining exposure is
only that a client which forgets the flag leaves a project waiting on its manager
to approve their own opening message — recoverable, visible in the queue, and
covered by the description and `mcp/instructions.js`. Pinned by a test either way.

The wording was sharpened alongside it: `apply: true` is for `totalWhys: 0` and
**never** for bulk content. Importing a long conversation or a document is the
case review exists for, and without that sentence the new default would be quietly
undone for the largest contributions anybody sends.

## Tests

- `teamctx init`, CLI and hosted, writes `reviewPolicy: 'all'`.
- A member's add-only `contribute` on a new project comes back queued, and the
  manager sees it in the queue and in "Waiting on you" on the project page.
- A project recorded as `additive` still behaves exactly as before, and
  `needsReview` still returns `false` for additive operations under it. This is
  the regression test for point 2 — without it, "existing projects keep their
  policy" is an intention rather than a fact.
- The founding contribution with `apply: true` still lands immediately on an empty
  project under `all`.
- Whichever answer the section above gets, a test for the case where `apply` is
  *absent* on an empty project — so the behaviour is pinned rather than left to
  whether a client read the instructions.

## Existing open source first

Nothing to borrow. This changes one default in teamctx's own governance logic,
which is the product. The queue, the policies and the manager gate already exist;
see [Build vs borrow](../../CONTRIBUTING.md#build-vs-borrow).

## What was built

| Change | Where |
| --- | --- |
| `NEW_PROJECT_POLICY` folded into `DEFAULT_POLICY`, both `all` | `src/review-policy.js` |
| `apply` from a non-manager degrades instead of throwing | `cli/commands/contribute.core.js` |
| `applyRefused` on every outcome, and in `reportBack` | `cli/commands/contribute.core.js`, `mcp/server.js` |
| `apply` is for the founding one, never bulk import | `contribute` description, `mcp/instructions.js`, `docs/mcp.md` |
| `set_review_policy` says what `additive` gives up | `mcp/server.js` |
| New-project, no-migration, and founding tests | `cli/commands/contribute-policy.test.js`, `contribute.core.test.js`, `src/review-policy.test.js` |
