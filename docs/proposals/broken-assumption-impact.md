# Proposal: when an assumption breaks, say what rests on it

**Status:** Built · **Serves:** Managers in control ·
**Issue:** [#120](https://github.com/StatsLateral/teamctx/issues/120)
· **Design spec:** `docs/superpowers/specs/2026-10-02-governed-records-design.md`
· **Blocks:** [#118](https://github.com/StatsLateral/teamctx/issues/118) sections 1 and 2

## The moment

> We assumed enterprise buyers require SSO before a pilot. New evidence
> contradicts it.
>
> teamctx: *"We're assuming: buyers need SSO before a pilot" may be broken. The
> decisions "Build SSO first" and "Delay the Acme pilot" rest on it. Review?*
>
> The manager confirms. Every connected AI now gets the assumption marked broken
> and the two decisions flagged for review.

## Where this starts from

`links.restsOn` is already stored, already validated, and **read by nothing**:

| Piece | State |
| --- | --- |
| `links.restsOn` on the schema | `src/model.js` — present |
| Shape-checked on the way in, refs resolved | `src/ops.js:22,54` — present |
| The AI is told to fill it | `src/ai.js:156` — present |
| Marking an assumption broken | `setRecordStatus`, manager-gated — present |
| Anything that *follows* a `restsOn` | **nothing** — this issue |

So the data is there and nobody asks it the one question it exists to answer.

One piece of luck: `src/brief.js` is the single render path for every brief — the
shared page, a role file, a task prompt, `my_brief` (`src/context.js:20,101`,
`cli/commands/brief.core.js:57`). "Every AI sees it" is therefore mostly one
change rather than four.

## The design

### 1. The walk — `src/impact.js`

```js
restingOn(records, assumptionId, { onDay })  // -> { records: [...], tasks: [...] }
```

A breadth-first walk with a visited set. Start at the assumption, find active
records with its id in `links.restsOn`, recurse on each (a decision can itself be
rested on), then collect the tasks those records are attached to. The visited set
is what makes two levels of dependents list each one exactly once and keeps two
records that point at each other from looping.

It takes a flat list of records rather than a tree, because a decision in one
workstream may rest on an assumption in another — the walk has to see the whole
project or it answers wrongly, and quietly.

### 2. The flag — derived, not stamped

A record needs review when it transitively rests on an assumption whose status is
`broken`. Derived on read rather than written onto dependents, so that a record
added *after* an assumption broke is flagged too, and so that nothing has to be
kept in step.

```js
needsReviewFlags(records, { onDay })  // -> Map(recordId -> [broken assumption ids])
```

**Pruning, not filtering.** When the manager re-confirms a decision, the walk has
to stop there rather than carry on flagging the rule that rests on that decision:
they have answered that question. A record that also rests on something broken by
its own separate path stays flagged, which is why each assumption is walked on its
own. The first draft of `src/impact.js` filtered the result instead of pruning the
walk, and flagged everything underneath a repaired link.

### 3. Clearing it

The issue gives two ways out, and they cost differently:

- **Replaced** — `status` becomes `replaced`, `isActive` is false, the record
  leaves every brief. Already works; nothing to build.
- **Re-confirmed** — stays active and the flag clears. This is the only part
  needing new state, because the assumption is still broken and the derivation
  would go on flagging it.

**Proposed:** compare timestamps. `setRecordStatus` → `broken` stamps `brokenAt`
on the assumption; `setRecordStatus` → `active` on an already-active record stamps
`reviewedAt` on it. Flagged when `reviewedAt` is absent or older than `brokenAt`.

Full ISO timestamps, not the date-only `updatedAt` records already carry: a
manager who breaks an assumption and re-confirms a decision in the same sitting is
the ordinary case, and date granularity cannot tell those two apart in the right
order. Both fields are additive — `recordSchema` does not set
`additionalProperties: false`.

Re-confirming is an ordinary governed contribution, so it is manager-gated by the
same path everything else is, and no dependent's status changes on its own.

### 4. Saying it

- **Brief** (`src/brief.js`): a flagged record gets *"needs review — rests on a
  broken assumption"* on its line. `renderBrief` already threads a per-record
  `tag`; this is a second tag rather than a new shape.
- **Contribute and review results** (`mcp/server.js`): when a contribution marks
  an assumption broken, the result carries the impact list so the assistant can
  say "these N things rest on this" without a second call.
- **The page**: left to #118, which is this issue's caller.

## What this is not

Evidence intake (#122), contradiction checking (#121), and the web screen (#118).
A small graph walk with a visited set — no library, per the issue; see
[Build vs borrow](../../CONTRIBUTING.md#build-vs-borrow).

## Progress

- [x] `src/impact.js` — the walk and the flags, with 25 tests (`f895891`).
      Five mutations checked: dropping the visited set, following one level only,
      filtering instead of pruning in `skip`, ignoring `isActive`, and letting a
      missing `brokenAt` pass. Each fails at least one test.
- [x] `brokenAt` / `reviewedAt` in `src/ops.js`, and the re-confirm path
- [x] `src/brief.js` renders the flag, and `src/project-records.js` gathers for it
- [x] The impact list and its spoken sentence on contribute and review results
- [x] A test per read path, all six: `my_brief`, `get_context`, `list_records`,
      `get_record`, the compiled task prompt, the page
- [x] CHANGELOG

## What the mutation sweep found that review would not have

Two gaps, both of the same kind: a thing that was correct and unreached.

The task-prompt renderer took `flagged` and rendered it, with no test — so
removing the wiring changed nothing that failed. Once tested, its **call site**
still was not: dropping `flagged` in `task.core.js` left the renderer passing and
every real prompt silently unflagged. Each of the four read paths now fails a
test when its own wiring is removed, which is what #120's second acceptance
criterion was actually asking for.

## Settled along the way

The open question about counting a dependent a reader cannot see: the count is
only ever given to a manager, on the result of breaking an assumption. What a
scoped member gets is the flag on a record they can already see — no count, no
ids, no assumption text. So the question does not arise, and
`src/oauth/project-view.js` has a test both ways round.

## What is left for #118

The web screen. This gives it the two things its first two sections need: what
rests on a broken assumption, and which records are waiting on one. Sections 2
and 3 of #118 can be built on `restingOn` and `needsReviewFlags` without reading
`restsOn` again.
