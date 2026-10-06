# Proposal: evidence that an assumption no longer holds

**Status:** In progress · **Issue:** [#122](https://github.com/StatsLateral/teamctx/issues/122)
**Base:** `feat/contradiction-review` (#126, #127, #121) with `feat/broken-assumption-impact` (#120) merged in.

## What and why

#120 answers "an assumption broke — what rested on it?" Somebody still has to
notice that it broke. In practice that notice arrives as a meeting note, a
document or a chat — "the last three enterprise prospects all piloted without
SSO" — that never mentions the assumption by name. This is the input half: a
contribution that contradicts an active assumption proposes, for the manager,
the evidence and the break together.

## Design

**One new operation, `addEvidence`.** `{ type: 'addEvidence', id, evidence: { text } }`
appends to the assumption's `evidence: [{ text, source, at, by }]`. The distiller
supplies only the quote. `source`, `by` and `at` come from the contribution
itself, stamped server-side after the AI returns — a model does not get to say
who said something or when. The queue item therefore carries exactly what will
be written.

**Proposed with the break, never instead of a review.** The distiller emits
`addEvidence` and `setRecordStatus: broken` for the same assumption. Both are
governed: `setRecordStatus` already needs the manager under every policy, and
`addEvidence` joins it, so evidence is "added only through review" under `none`
as well. And like a #121 contradiction, a contribution carrying evidence queues
even with `apply: true` — the thing being checked is the AI's inference that
this note contradicts that assumption, and a manager's own `apply` is not a
review of that.

**Evidence lands before the break.** Operations run in a fixed order; evidence
goes ahead of status changes so it attaches to the record it was written
against. It may attach to an active or a broken assumption — a second piece of
evidence on one already broken corroborates it, and should not be lost because
somebody else broke it first. A replaced or closed assumption is history, and
evidence against it is dropped with a reason.

**The queue says it in words.** *"Evidence against 'We're assuming: …': <quote>
(from <source>)"*, with #120's impact list beside it. The impact list already
works on a queued contribution, because `restingOn` follows `restsOn` whatever
the assumption's current state.

## Limits of the MVP

The distiller sees the assumptions in the tree it is writing to, so evidence is
caught against an assumption in the same part of the work — a note contributed
to the project is checked against the project's assumptions. Evidence in one
workstream against an assumption owned by another is not caught yet; it would
need the comparison set #121 builds for decisions and rules, extended to
assumptions, and an operation that can target another tree. Agents attaching
evidence on their own, analytics feeds and "evidence missing" are out, per the
issue.

## Plan

- [ ] `addEvidence` in `src/ops.js`, ahead of status changes; `evidence` on the schema
- [ ] Governed in `src/review-policy.js`; forces a queue in `contributeCore`
- [ ] `source` / `by` / `at` stamped from the contribution, never from the AI
- [ ] The distiller is told when to propose it, and when not to
- [ ] Queue wording and impact list on the page, CLI and MCP
- [ ] CHANGELOG, and a sandbox run against both acceptance criteria

## Acceptance (from the issue)

- "The last three enterprise prospects all piloted without SSO" against the
  active assumption "buyers need SSO before a pilot" proposes evidence plus a
  broken status, and approving it triggers #120's impact list.
- Unrelated contributions don't propose evidence against unrelated assumptions.

The first is plumbing plus model behaviour; the second is model behaviour
alone. Unit tests pin the plumbing with a stubbed model; both criteria are also
checked against the real model in the sandbox.
