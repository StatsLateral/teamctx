# Flag possible impact on sibling workstreams when a record changes (#266)

## The moment

A project holds several related parts of the work (A, B, C). The goals for A
change. Nobody is prompted to check B and C — so a decision in B that quietly
depended on A's old goal drifts out of line, and no one notices until it bites.

## What exists now (grounded)

- **Contradiction check** rides the contribution's own model call (`src/ai.js`
  `proposeChanges`): it compares each record-changing op against
  `comparisonRecords` — the project plus the target's **ancestor** chain
  (`src/contradictions.js`), **never a sibling branch** — and returns
  `contradictions: []`. `normalizeContradictions` validates the model's output
  against real records (identity and text are ours, never the model's).
- The result attaches to the queue item (`q.contradictions`, read in
  `src/oauth/project-view.js`) and shows at review.
- `links.restsOn` impact (`src/impact.js`) only reaches where someone wrote the
  link; free-text goals and plans carry none. Changes reach the tasks **below** a
  record (#206), not sibling workstreams.

So the machinery to (a) gather a comparison set, (b) ask the model in the same
call, (c) validate its answer, and (d) carry it to review already exists — for
ancestors and for *contradiction*. #266 adds a **sibling** set and a softer,
*advisory* relationship.

## Design

### 1. A sibling comparison set
A `siblingRecords({ config, target, teamctxDir, scope })` beside
`comparisonRecords`: the active decisions and rules in the target's **sibling**
workstreams (same parent, not the target, not its ancestors). **Scope-filtered
to the reviewer** — a sibling they cannot see is never read or named (acceptance).
A project with one workstream yields an empty set, so nothing changes there.

### 2. Ask in the same model call
Extend the `src/ai.js` proposal prompt to also return, for each record-changing
op, which **sibling** records it may affect and a one-line reason:

```
"impact": [ { "operationIndex": 0, "recordId": "...", "workstream": "...", "reason": "..." } ]
```

This is *possible impact*, not contradiction: "the goal A changed in a way that
may affect this decision in B." A `normalizeImpact` (mirroring
`normalizeContradictions`) validates every hit against the real sibling set and
drops anything the model invented; the reason is the model's, the identity ours.
No new library — the issue's "same model call pattern."

### 3. Carry it to review
The queue item gains `impact` alongside `contradictions`, surfaced in
`list_pending_reviews` / `reachLines` as "Possible impact on «record» in
«workstream» — «reason»". Advice, never a block: approval is not gated on it.

### 4. Confirm or dismiss, and record the dismissal
At review the manager, per impact item:
- **Confirm** → opens a follow-up contribution against the sibling workstream (a
  prompt to reconcile that record), the way a suggested task is created.
- **Dismiss** → recorded against the change so it is not raised again for the
  same edit (a small marker, not a governed record).

Passed through `review_approve` (like `replaces`/`taskChanges` today): the
manager picks per item, the server never decides for them.

## Phasing (suggested)
- **v1** — the sibling set, the model `impact` output, validation, and surfacing
  at review (acceptance lines 1, 3, 4). Confirm opens a follow-up.
- **v2** — persist dismissals so a dismissed item stays dismissed; optional cheap
  pre-filter (embeddings/BM25) if sibling sets grow large (issue: not needed
  first).

## Not in this issue
Separate projects / cross-project links (team layer, deferred); automatic edits
to the other workstreams.

## Acceptance
- A change in A produces a list of possibly-affected records in B and C, each
  with the model's reason.
- The manager can confirm (opens a follow-up contribution) or dismiss, and the
  dismissal is recorded.
- Siblings outside a reviewer's scope never appear.
- A one-workstream project behaves as today.
