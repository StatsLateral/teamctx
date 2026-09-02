# Design: the founding contribution — seeding a project's goals from an existing chat (part of #66)

**Roadmap item:** Single-page onboarding, step 8 — "set initial project goals and
objectives (option to deduce objectives from an existing chat)" (#66)
**Status:** Approved, ready for planning

## Problem

A project's `main` workstream is created with `whys: []` and nothing forces it
out of that state (`cli/commands/init.core.js:114-121`). If nobody ever calls
`contribute`, `serializeToMd` renders *"No context yet. Run `teamctx contribute`
to add the first contribution."* — the exact empty state that caused the most
repeated frustration in the 2026-09-01 manager-persona walkthrough (see
[[teamctx-onboarding-ux-audit-2026-09-01]]).

The question this spec answers: once a manager is connected to a brand-new,
empty project via a chat client, and they already have a long-running
conversation (or just a first message) describing what they're trying to do,
how does that become the project's initial goals — with zero required
technical vocabulary?

Surfaced during a 2026-09-01 manager-persona walkthrough of the hosted
onboarding flow (real accounts, production deployment) — see the "Onboarding
UX audit 2026-09-01" project notes for the full session.

## What exists today (relevant prior art)

- `mcp/instructions.js` — `INSTRUCTIONS`, sent once at MCP `initialize`
  (landed in #67/#59). Already tells a connected agent the manager sequence
  (`init` → `workstream_use` → `contribute` → `task_add` → `member_add`) and
  the rule "act, don't explain." This spec extends step 3 of that sequence
  rather than adding a new sequence.
- `cli/commands/contribute.core.js` — `contributeCore({ text, apply, ... })`.
  `apply: true` writes straight to shared context instead of queuing,
  gated by `assertManager(config, { actor, displayName })` (line 80). This
  already exists and is already safe to use here — no new gate needed.
- `cli/commands/init.core.js` — pins the project creator as manager
  (`config.managerKey = actor.key`) at creation time (the #49 fix). The
  person who will make the founding contribution is, by construction,
  already the one `assertManager` will accept.
- `src/context.js` (`updateShared`) → `src/ai.js` (`proposeDiff`) — `contribute`'s
  free-text `text` is already run through server-side AI distillation into
  why/what/how nodes. The connected agent hands over prose; it does not need
  to construct tree structure itself.
- `mcp/server.js`'s `get_status` tool already returns `totalWhys` (summed
  across all workstreams) — a ready-made signal for "has this project ever
  had anything contributed to it," with no new field needed.
- `mcp/instructions.test.js` — anti-staleness tests for `INSTRUCTIONS`. The
  invented-tool-name check only matches lowercase-with-underscore backtick
  tokens (`` `([a-z_]+)` ``), so `` `apply: true` `` and `` `totalWhys: 0` ``
  are not picked up by it — confirmed no collision before writing this spec.

## Explicitly out of scope

- **No code or schema change.** `contribute`, `assertManager`, `init`, and the
  review pipeline are untouched. This is a prose-only change to
  `mcp/instructions.js`.
- **No new MCP tool.** Considered and rejected (see below) — `contribute`'s
  own tool description already states "there is no separate import step,"
  and a second entry point would contradict that.
- **Not a hard technical constraint.** Nothing prevents a workstream from
  staying empty via raw CLI/API use. "Mandatory" is enforced by the guided
  agent flow always asking, not by the data model refusing to proceed.
- **Not the web-page paste-a-transcript flow.** Explicitly deferred to a
  possible future page feature if the live-agent approach turns out to be
  insufficient for a host that ignores `instructions` — not designed here.
- **Not workstream/task creation from context** (#66 step 10) — that's a
  separate, later step in the flow and a separate design.
- **Not the earlier-considered "restrict `apply: true` to only the founding
  moment" guard.** `apply: true` is an existing, general "manager writes
  directly" mechanism already used elsewhere; narrowing it would be a
  regression to already-established behavior, not a safety improvement.

## Rejected alternative: a dedicated tool or `init` parameter

Considered wrapping this in a new `seed_context` tool, or an optional
`initialGoals` argument on `init` that internally calls
`contributeCore({ apply: true })` right after project creation.

Rejected because: (1) `contribute`'s existing description explicitly claims
to be the *only* way in — a second path contradicts a stated architectural
decision and would need its own anti-staleness coverage; (2) folding
AI-distillation into `init` changes a currently pure, fast,
filesystem/config-only operation's latency and failure modes; (3) it doesn't
generalize to the case where a project was created in an earlier session and
is only being seeded now — the guidance-based trigger (`totalWhys: 0`)
already covers that for free, a positional "right after init" parameter does
not.

## Design

### `mcp/instructions.js` changes

Two edits, both prose, both within the existing manager sequence and "Things
worth knowing" section — no new section added.

**Step 3 of the manager sequence**, from:

> `3. \`contribute\` — put what they have told you into the shared context. This is how context gets there; there is no separate import step.`

to:

> `3. \`contribute\` — put what they have told you into the shared context. This is how context gets there; there is no separate import step. If \`get_status\` shows \`totalWhys: 0\`, this is the project's founding contribution — call it with \`apply: true\` so it lands immediately instead of waiting on the manager to review their own first message. Whether that content is a long conversation they already had or one sentence they just gave you, the call is the same: summarize what you were told, don't ask them to restate it in teamctx's terms.`

**The "does not land, it queues" bullet**, from:

> `- **A contribution does not land, it queues.** Say so. "Sent for review" is true; "added to the project" is not.`

to:

> `- **A contribution does not land, it queues — except the founding one.** Say "sent for review", not "added", for every contribution but the first. The first (\`totalWhys: 0\`) is the one case where \`apply: true\` is correct: the caller is already the pinned manager, and there is nothing yet to review against. If \`apply: true\` is refused, the caller isn't actually the manager — that's the same gate working as \`review_approve\`, not an error to retry.`

### Trigger condition

`totalWhys: 0` (from `get_status`), not "immediately after `init`" — this
correctly covers both a manager seeding a project in the same turn it was
created, and a manager (or a returning session) seeding a project that was
created earlier and left empty. `totalWhys` sums across all workstreams, so
it stays correct even if a non-`main` workstream is active when the founding
contribution happens.

## Error handling summary

| Case | Behavior |
|---|---|
| No AI provider key configured | `proposeDiff` refuses; already covered by the existing "some tools need an AI provider key → project settings page" bullet — no change needed |
| Caller isn't the pinned manager | `assertManager` throws on `apply: true`; new bullet text explicitly says this is the gate working, not a retry case |
| `totalWhys: 0` but a non-`main` workstream is active | Still correct — `apply: true` targets whichever workstream is active, emptiness is checked project-wide |
| Two people hit the founding moment concurrently | Not handled — accepted risk. The flow sequence (invites happen at #66 step 11, after goals at step 8) means nobody else is normally connected yet |
| Distillation succeeds, git commit/push fails | Pre-existing generic `contributeCore`/`commitAndOptionallyPush` error handling, unrelated to this change |

## Testing

- Extend `mcp/instructions.test.js` with one or two assertions that the new
  text is present (e.g. matches `/totalWhys/` and founding-contribution
  language), same style as the existing anti-staleness tests. No new test
  infrastructure.
- No new integration test for `contribute({ apply: true })` itself — that
  code path already has regression coverage from #49/#50; this change is
  prose-only.
- Add one line to `docs/proposals/onboarding.md`'s existing "Verification"
  list: connect a fresh client, as a manager with an existing conversation,
  and ask it to set up a project. It should call `contribute` with
  `apply: true` for the founding message, and `totalWhys` should be `>0`
  immediately after, with no `review_approve` step involved.
- `npm test` — this touches prose read by existing assertions; nothing else
  in the suite should move.
