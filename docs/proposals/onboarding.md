# Proposal: the path from "never heard of teamctx" to "team is working"

**Status:** Proposal (suggestion, not committed) · **Serves:** Managers in control ·
**Rough size:** Large — three issues, and only two of them are one PR each

## Problem

Three issues came out of the 2026-09-01 manager-persona walkthrough. They read
as separate bugs and are actually one arc:

| Issue | What broke |
| --- | --- |
| [#59](https://github.com/StatsLateral/teamctx/issues/59) | The connected agent knew *what* 42 tools existed, not *when* to call them |
| [#58](https://github.com/StatsLateral/teamctx/issues/58) | A name collision in new-project onboarding dead-ends on GitHub's raw API message |
| [#66](https://github.com/StatsLateral/teamctx/issues/66) | There is no `/` route at all, so a first-time visitor has nowhere to land |

They are related in a specific way, and it matters for sequencing: #66 says
outright that it *depends on* #59 and does not supersede it, because steps 7–10
of its flow are the agent driving teamctx on the user's behalf. #58 is a live
bug in `/settings/new-project`, which is step 4 of #66's flow — so #66 will
build around that screen, but the dead end is reachable today either way.

**They are not one piece of work.** #59 and #58 are each a PR. #66 supersedes
six issues and describes a thirteen-step flow including video content; treating
it as a third PR is how it ends up half-built. This proposal covers the arc and
scopes only the first two for implementation.

## What is actually there today

Checked rather than assumed:

- **No `/` route.** `api/oauth-server.js` serves `/settings/*` and `/oauth/*`
  and nothing else. #66 is correct.
- **`slugifyProjectName` is not the bug.** It already lowercases, collapses runs
  of non-alphanumerics to one `-`, and trims. #58's own update says the original
  hyphen theory was wrong; this confirms it.
- **The 409 relays GitHub verbatim.** `createRepo` throws `REPO_EXISTS` carrying
  `body.message` — GitHub's wording — and the route hands that straight to
  `newProjectPage` as `error` (`api/oauth-server.js:315-319`).
- **The MCP server ships no `instructions`.** It is constructed with
  `{ name, version }` and `{ capabilities: { tools: {} } }` only. MCP's
  `initialize` response has an `instructions` field for exactly this, and
  teamctx leaves it empty across 41 tools.

That last one is the whole of #59 in one sentence: the protocol has a place to
put the guidance, and we put nothing there.

## Phase 1 — the agent knows what to do (#59)

**Why first:** #66 assumes it, and it is the cheapest thing here that changes
how the product feels. A generic agent connected to 41 tools currently guesses,
and during the walkthrough it guessed *explain the data model to the user*,
which is the opposite of the point.

Two parts, both server-side, neither requiring the user to know anything:

**Server `instructions`.** Sent once at `initialize`, ahead of any tool call.
It should say what teamctx is for in two sentences, then give the two sequences
that actually occur:

- *a manager with a new project* — `init` → `workstream_use` → `contribute` the
  context they already have → `task_add` / `task_compile`
- *a member picking up work* — `list_tasks mine` → `task_compile` → do the work
  → `contribute`

And the rules that stop the common wrong turns: never make the user learn the
words *workstream*, *why-tree* or *compile*; prefer acting over explaining; a
contribution queues for review rather than landing, so say so.

**Tool descriptions that say when, not just what.** The descriptions today are
accurate and answer "what does this do". A sequencing agent needs "reach for
this when…". This is editing prose in `TOOLS`, not changing behaviour, and it
is the half that keeps working in clients that ignore `instructions`.

**Out of scope here:** seeding context from a chat the user has already had.
That is its own issue, filed alongside #59 and dependent on it — #59 is about
the agent knowing when to reach for what already exists, not about adding a way
to import a conversation.

**Also out of scope:** per-persona tool filtering. Deciding a member should not
*see* `member_add` is an authorization question, and the manager gate already
answers it at call time. Hiding tools would mean two tool lists to keep honest.

## Phase 2 — the new-project flow stops dead-ending (#58)

A manager who names their project the same as an existing repo currently gets
GitHub's API wording on an error page. The walkthrough hit it repeatedly, which
is unsurprising: retrying the same name after any failure is what people do.

- On `REPO_EXISTS`, say it in plain language — that a project by that name
  already exists in that account — rather than relaying the API.
- Offer a name that is free. `slugifyProjectName` already produces the
  candidate; checking `-2`, `-3` and so on costs one API call each and turns a
  dead end into a click.
- Keep the form filled in. Losing what they typed is its own small insult.

`REPO_FORBIDDEN` shares the page and deserves the same treatment: "you cannot
create repositories in that organisation" is actionable; GitHub's phrasing is
not.

## Phase 3 — the connected page (#66)

Not scoped here, deliberately. It supersedes six issues, spans thirteen steps,
and includes an explainer video. What it needs first is its own spec broken into
landable pieces — roughly: the `/` route and explainer; collapsing the
two-field key setup into one field plus a share toggle; the connector-setup
step; seeding context from a chat the user has already had; proposing a
workstream and tasks from that context; the invite; and making the ongoing loop
visible rather than ending at step 12 looking finished.

Writing that spec is the next task after phase 1, and phase 1 makes several of
those steps smaller, because an agent that already knows the sequence does not
need the page to walk the user through it.

## Verification

1. `npm test` — phases 1 and 2 change prose and one error path; nothing in the
   existing suite should move.
2. Connect a fresh client to a hosted project and ask it, as a manager, to set
   up a project — without naming a tool. It should act rather than explain.
3. Ask it, as a member, "what should I work on?" — it should reach
   `list_tasks` with `mine`, not ask who you are.
4. Create a project whose slug already exists on the account. The page should
   name the collision in plain language and offer a free alternative.
5. Try to create in an org you cannot write to. Same treatment, different cause.

## Open question

**Does `instructions` reach the clients that matter?** It is in the MCP spec and
the SDK supports it, but whether a given host surfaces it to its model is that
host's business, and it is exactly the kind of thing that varies. The tool
descriptions are the half that works regardless, which is why both halves are in
phase 1 rather than one being a follow-up.
