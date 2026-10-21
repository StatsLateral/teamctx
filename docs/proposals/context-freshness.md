# Proposal: show how fresh the context is

**Status:** Proposed · **Issue:** [#183](https://github.com/StatsLateral/teamctx/issues/183)
· **Base:** `main`

## Why

A stale context misleads an assistant silently. Nothing says how old the
approved context is, or how much is waiting for review.

## What it shows

Two facts, worked out from what the project already keeps, never stored:

- **last approved**: the newest `approvedAt` in `.teamctx/approved/`. A project
  with no approval files (approved before approvals were recorded) says "not
  recorded" and never guesses.
- **waiting**: how many items are in the review queue.

As one line: `Context last approved 12 days ago; 3 items waiting for review.`
"today" and "yesterday" for the last two days; "nothing waiting for review" when
the queue is empty.

## Where

- `teamctx status`: a `Freshness:` line.
- `get_status`: `lastApprovedAt` (ISO date or `null`) and `waiting`. A scoped
  member counts only the waiting items in their own parts of the work, as
  `list_pending_reviews` shows them.
- A role file, as it is read: the line goes under its title in
  `get_role_context`, `my_brief`, `teamctx context` and the `/context/<role>`
  link.

The line is added when a role file is read, not written into it. A role file is
regenerated at each approval, so a line written then would always say "today"
and go stale with the file, which is the problem this fixes.

Not on the project page: it already shows what is waiting.

## Code

- `src/freshness.js`: `contextFreshness(teamctxDir, { keep })` returns
  `{ lastApprovedAt, waiting }` from `readApprovals` and `listQueue`;
  `freshnessLine(f, now)`; `withFreshness(md, line)` puts the line under the
  first heading.
- The callers above use them.

## Tests

The date from the newest approval file; "not recorded" with none; the count;
"nothing waiting"; the line in a role file and in `get_status`; a scoped member's
count.

## Plan

- [ ] `src/freshness.js`; tests
- [ ] `teamctx status` and `get_status`; tests
- [ ] The line in a role file as it is read; tests
- [ ] CHANGELOG
