# Proposal: a key you can say out loud

**Status:** Implemented on `feat/stable-record-keys` · **Serves:** Managers in control ·
**Issue:** [#126](https://github.com/StatsLateral/teamctx/issues/126)
· **Spec:** `docs/superpowers/specs/2026-10-04-agent-first-project-view-design.md` (PR #125)
· **Blocks:** #127, #128, #129, #130, #131

## Problem

A task's id is `task-1a2b3c4d` and is never shown. What is shown is a position —
`1.2`, `3` — worked out at render time. So the number against a thing changes when
something is added above it: the task somebody wrote down this morning is a
different number this afternoon, and a record referred to in a meeting cannot be
found again. Records have the same problem.

## The design

**Stored, not derived.** A per-project sequential key minted at creation and never
reused: `T-14` task, `D-3` decision, `R-1` rule, `A-2` assumption, `X-1`
exception. The random `id` stays the internal identity; the key is the human
handle.

**Counters in `config.json`** as `nextKey: { T, D, R, A, X }`.

### Where keys are minted, and when

Two creation paths, and the awkward one is `src/ops.js`: `applyOps` works on a
tree and has never seen `config`, where the counters live. So the counters travel
in and out —

```js
applyOps(tree, ops, contributionId, { nextKey }) -> { tree, dropped, nextKey }
```

— and the caller persists them only on an actual context write. The preview
run is discarded. At apply time, `withRecordKeys` backfills existing trees and
re-reads config; `applyOps` runs again against the latest tree and counters.
This preserves changes that landed while the AI was thinking. Queued and
discarded proposals reserve nothing. Approval takes the next available keys.

Direct task creation allocates inside `writeTask`, using the same write boundary.
Local allocations hold a short exclusive file lock under `.teamctx/.local/`.
Counters are reserved before trees are written: a failed disk write can leave a
gap, but cannot make the next writer reuse a key. A stopped process can leave
the lock file behind; the error explains how to remove it after that process
has stopped. Hosted writes buffer trees and config in one commit and reject a
conflicting ref update instead of replaying stale counters; retry the operation.

### Backfill

Existing projects get keys on their first context write, in creation order, as
one idempotent pass across the project and all workstream files. Reads and queue
submissions do not migrate the project. Creation order uses the `createdAt` day,
then its full timestamp when available, otherwise the timestamp in the first
`sourceContributionIds` entry, then file position. CLI (`c-`) and MCP (`mcp-`)
prefixes do not affect ordering. Missing times sort first within their day;
ties use project-first, sorted workstream-file order and then array position.
Idempotent because anything already carrying a key is left alone, and the
counters resume above the highest key found rather than above the count.

### Links

`src/view-url.js` keeps taking the internal id. A key is accepted as an alias and
resolved server-side, so `?task=T-14` and `?item=R-2` reach the same thing as the
id — and an id that looks like a key cannot be confused for one, because
`[TDRAX]-<digits>` is not a shape `mint()` produces.

## Plan

- [x] `src/record-key.js` — the vocabulary, minting, parsing, and `isKey`
- [x] Mint on both creation paths; counters in `config.json`
- [x] Backfill, idempotent, on first context write
- [x] Key accepted as a link alias by the project page route
- [x] Keys shown in briefs, prompts, page rows and `contribute` / `task_done` results
- [x] Task commands and record lookup accept keys while retaining internal ids
- [x] CHANGELOG

## Existing open source first

Nothing to borrow: this is teamctx's own data model, and a sequence counter per
project is three lines. See
[Build vs borrow](../../CONTRIBUTING.md#build-vs-borrow).

## Acceptance (from the issue)

- A new task or record gets the next key; keys are never reused after a delete.
- An existing project is backfilled once, in creation order, and a second run
  changes nothing.
- `?task=T-14` and `?item=R-2` resolve to the same thing as the internal id.
