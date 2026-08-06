# Proposal: Local team-productivity metrics (`teamctx stats`)

**Status:** Proposal (suggestion, not committed) · **Serves:** Prove team productivity ·
**Rough size:** Medium — splittable (data extraction → metrics → presentation)

## Problem

teamctx's core claim is that shared, approved context makes a team's AI-assisted
work more consistent — fewer redos, less divergence. Right now there is no way for
a team to *see* whether that's happening. A manager running a pilot has to argue
from anecdote. The project needs a `stats` command that turns the data teamctx
already produces into a handful of honest numbers.

Privacy constraint (hard requirement): **everything is computed locally** from the
repo's own history and files. No telemetry, no phoning home, no network calls.

## What exists today

- **Git history of `.teamctx/`** — every contribution, approval, snapshot, and
  reflect is a commit with an author and timestamp. This is the primary data
  source, and it's already versioned and free.
- **Audit log** — contributions persist author, source, workstream, and status
  (`pending` → `approved`/`rejected`) with timestamps.
- **Snapshots** — known-good states with approval metadata.
- **Tasks** — first-class objects with `open`/`done` status and compile timestamps.
- Nothing aggregates any of this.

## Suggested approach (one way to do it)

1. **`teamctx stats [--since <date>] [--workstream <id>]`** — read-only, no AI
   call, instant. Print a small table:
   - **Contribution cadence** — contributions/week, by author (is the habit
     alive? is it one person or the team?)
   - **Approval flow** — median time from `pending` → decision; approval rate
     vs. rejection rate (a proxy for first-pass acceptance of work)
   - **Context freshness** — days since last approved contribution per
     workstream; count of pending items waiting
   - **Task flow** — tasks opened/completed in the window, compile counts
2. **Data layer first** — a `src/metrics.js` that walks the git log for
   `.teamctx/` paths (`git log --follow --format=... -- .teamctx/`) plus the
   audit/queue files, and returns plain objects. Keep presentation separate so
   the same data can later feed `status`, a web page, or an MCP tool.
3. **Expose over MCP** — a read-only `get_stats` tool (Tier 0) so a manager can
   ask their AI "how is the team's context habit this month?" — the numbers are
   grounded, not hallucinated.
4. **Role-file pull tracking (optional, later)** — pulls of compiled context
   (web `GET /context/<role>`, `teamctx context <role>`) are the best signal
   that context is actually being *used*, but web fetches happen server-side.
   Start with what's in the repo; consider an opt-in local counter appended by
   the CLI/web handler as a follow-up. Don't let this block the rest.

## Where to start

- `src/git.js` — existing git plumbing helpers to build on.
- `src/storage.js` — where queue/audit/task data is read.
- Tests: build a fixture repo with a scripted history (see `src/git.test.js`
  patterns) and assert the computed metrics.

## Open questions

- Windowing defaults: trailing 4 weeks feels right for a pilot cadence.
- Should `stats` warn when cadence drops (streak-style), or stay neutral?
  Neutral first; nudges are a product decision for later.
