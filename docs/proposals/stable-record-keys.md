# Proposal: a key you can say out loud

**Status:** In progress · **Serves:** Managers in control ·
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

— and the caller writes them **only when it writes the tree**. That falls out
right for the queued path without any special case: `contributeCore` runs
`applyOps` once to work out what a contribution would do, then throws that tree
away and writes a queue item. The counters go with it, so a contribution waiting
on review has burned no keys, and one that is rejected burns none ever. Keys are
assigned when a record actually lands, in the order records land — which is the
only order that means anything to a reader.

The other path, `cli/commands/task.core.js`, already has `config` and is
straightforward.

### Backfill

Existing projects get keys on first write, in creation order, as one idempotent
pass. Creation order is `createdAt`, then the first `sourceContributionIds` entry
(contribution ids carry a timestamp), then position in the file — so it is
deterministic for records written on the same day, which is most of them.
Idempotent because anything already carrying a key is left alone, and the
counters resume above the highest key found rather than above the count.

### Links

`src/view-url.js` keeps taking the internal id. A key is accepted as an alias and
resolved server-side, so `?task=T-14` and `?item=R-2` reach the same thing as the
id — and an id that looks like a key cannot be confused for one, because
`[TDRAX]-<digits>` is not a shape `mint()` produces.

## Plan

- [ ] `src/record-key.js` — the vocabulary, minting, parsing, and `isKey`
- [ ] Mint on both creation paths; counters in `config.json`
- [ ] Backfill, idempotent, on first write
- [ ] Key accepted as a link alias in `src/view-url.js`
- [ ] The key shown in prompts and in `contribute` / `task_done` results
- [ ] CHANGELOG

## Existing open source first

Nothing to borrow: this is teamctx's own data model, and a sequence counter per
project is three lines. See
[Build vs borrow](../../CONTRIBUTING.md#build-vs-borrow).

## Acceptance (from the issue)

- A new task or record gets the next key; keys are never reused after a delete.
- An existing project is backfilled once, in creation order, and a second run
  changes nothing.
- `?task=T-14` and `?item=R-2` resolve to the same thing as the internal id.
