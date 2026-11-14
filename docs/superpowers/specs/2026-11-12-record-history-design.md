# Record history: keep and show a record's trail (#265)

## The moment

A strategist and a manager go several rounds on a piece of work's goals. The
manager approves a version. Weeks later: *"What did this say when we started,
what changed, and who agreed to it?"* Today part of that answer is gone, and the
rest is spread across git, the change log, and working outputs.

## What exists now (grounded)

- **Replace** (`addRecord` with `links.replaces`, `src/ops.js:68‑79`) keeps the
  old record, marks it `status: 'replaced'`, and points **new → old**
  (`links.replaces`). There is **no old → new** pointer.
- **Edit** (`editRecord`, `src/ops.js:83‑108`) builds `next = { ...current,
  ...changes }` and **overwrites** `text`/`detail` in place. The earlier text is
  dropped from the record (it survives only in git and the change log).
- Provenance already exists: `sourceContributionIds`, `createdBy`, `approvedBy`,
  `createdAt`/`updatedAt`; outputs are append‑only with feedback (#197); task
  history is derived (`src/task-history.js`). **Nothing joins these for one
  record.**

## Design

### 1. Keep the prior text on edit
In `editRecord`, when an edit actually changes `text` or `detail` (the existing
no‑op guard at `src/ops.js:99` already drops empty edits), append the *prior*
values to a new `history` array on the record before overwriting:

```
history: [ ...(current.history || []),
  { text: current.text, detail: current.detail,
    at: current.updatedAt, byContribution: c } ]
```

`byContribution` resolves to an author and time through existing provenance — no
new "who" field, no required reason. A record written before this change has no
`history`; it reads as **no earlier versions**, never an error.

### 2. Back‑pointer on replace
In `addRecord`'s replace branch (`src/ops.js:77‑79`), also set `replacedBy:
<new id>` on the record being replaced, so the chain walks **both ways**.

### 3. One view: a record's trail
A new reader (e.g. `recordTrail(id, tree, scope)`) joins, oldest → newest:
versions (from `history` + current, and the replace chain via
`replaces`/`replacedBy`), the working‑output iterations and manager feedback that
led to it, the approval (`approvedBy`), and any linked files — scoped to the
caller like every other read. Text differences in the view use a maintained diff
library (`diff` / jsdiff), not hand‑rolled diffing.

### 4. Surfaces
Exposed the three usual ways: a CLI command, an MCP read, and the record drawer
on the project page.

## Not in this issue
KPI/numeric tracking, cross‑project links, deleting history, and any "explain
what changed" narration (an assistant can already do that from the trail).

## Acceptance
- Editing a record's text leaves the earlier text readable, with who and when.
- A replaced record names its replacement.
- One call (CLI, MCP, page) returns a record's trail, in the caller's scope.
- A pre‑existing record reads as having no earlier versions, not an error.
