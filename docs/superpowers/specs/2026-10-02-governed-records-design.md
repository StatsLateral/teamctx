# Governed records: decisions, assumptions, rules and exceptions alongside the tree

**Date:** 2026-10-02
**Status:** Design agreed in conversation; spec pending review
**Rollout:** extend today's tree gradually — no big-bang migration
**Builds on:** decisions-first-class (2026-07-03), context inheritance (2026-09-09),
review policy / #109, workstream scope (#77/#85), context view (#103), read log (#111)

## Problem

teamctx keeps a team's context as a Why → What → How tree per workstream, plus
tasks. That captures *what the work is*, but not most of what a team actually
relies on and argues about:

- **Decisions** exist only as a `tagged: 'decision'` flag on a contribution and an
  inline marker in compiled text. Nothing records what a decision replaced, what
  it rests on, or whether it still holds.
- **Assumptions** ("about 20 people will come", "cost per lead stays near $80")
  sit in the tree as ordinary statements, with no owner, no review date, and no
  way to mark one *broken* and see what depended on it.
- **Rules** ("no nuts", "budget capped at $60k/month") and **exceptions** to them
  ("adults' cake may have chocolate frosting", "this page may name competitors
  until Nov 30") are indistinguishable from any other line — so every member's AI
  sees a rule and its exception as two contradictory statements, and an
  exception never ends.
- **Open questions** and **risks** have no owner and no way to close.

For a team where everyone brings their own AI, these are exactly the things each
AI must get right, and exactly what the manager needs to govern.

## Goals

1. Add **governed records** — typed, plain-language statements with owners,
   approval and a life cycle — **alongside** the existing tree and tasks.
2. Every member's AI receives the **active** records for its scope, with
   exceptions applied to the rules they bend, through the connector it already uses.
3. The manager can **see and act on governance**: what is due for review, what
   has broken, what is about to expire, what conflicts.
4. Ship in **phases**, each useful on its own, none breaking existing projects,
   tools or the context view.

## Non-goals (this spec)

- Replacing the Why/What/How tree. It stays; Phase 4 decides its future with
  evidence from Phases 1–3.
- Approval routed across several people (an approver per type per workstream).
  Phase 2 adds per-type control with the manager as the only approver; routing is
  a later spec.
- Agent permission profiles beyond today's agent tokens.
- Detecting edits made outside the tools (direct file edits).
- Moving storage to Google Drive / SharePoint.
- Members without an AI assistant; collaboration across organisations.

## Model

### Record

```js
{
  id: 'rec-…',                 // stable; minted when the operation is applied
  type: 'decision',            // see table
  text: 'Entry offer is a 6-week fixed-price engagement',
  why: 'Removes the "consultants are expensive" objection',  // optional, plain words
  status: 'active',            // proposed | active | replaced | expired | broken | closed
  owner: { key, name },        // required for assumption, question, risk
  attachedTo: { node: 'what-…' } | { task: 'task-…' } | null,   // null = the tree itself
  reviewBy: '2026-11-01',      // assumption (required), others optional
  expiresAt: '2026-12-31',     // exception (required), others optional
  links: {
    restsOn: ['rec-…'],        // decision → assumptions it depends on
    bends: 'rec-…',            // exception → the rule it bends (required for exception)
    replaces: 'rec-…',         // newer decision/rule → older one
    answers: 'rec-…',          // decision → the open question it closes
  },
  evidence: [{ text, source, at, by }],   // Phase 2
  sourceContributionIds: ['c-…'],         // provenance, as tree nodes have today
  approvedBy: { key, name, at } | null,
  createdAt, updatedAt,
}
```

| Type | Plain label in views and briefs | Required fields |
|---|---|---|
| `decision` | "We decided …" | — |
| `assumption` | "We're assuming … (check by <date>)" | `owner`, `reviewBy` |
| `rule` | "Rule: …" | — |
| `exception` | "Allowed: … (until <date>, instead of: <rule>)" | `links.bends`, `expiresAt` |
| `question` | "Open question: … (<owner>)" | `owner` |
| `risk` | "Risk: … — plan: <why>" | `owner` |

Goals and whys remain the tree's top level for now (Phase 4).

### Where records live

In the **same tree file** as the statements and tasks they belong to —
`project.json` for the project, `workstreams/<id>.json` for a workstream — as a
`records: []` array, the way `tasks: []` already lives there.

Why there, rather than a file per record:
- **Scope and visibility come free.** The hosted read path, `inScope`, the context
  view's "never send an out-of-scope tree" rule and snapshots already work per
  tree file. Records inherit all of it with no new access code.
- **One commit per contribution**, as today.
- **No new storage seam** before the Drive / SharePoint work, which will revisit
  file layout anyway.

Any type may be attached at project level or in a workstream from Phase 1. A
project-level record reaches every member (project context is inherited, as
today); a workstream record reaches only that workstream's members.

### Life cycle

```
proposed ──approve──▶ active ──┬─ replaced   (a newer record links `replaces`)
   │                           ├─ expired    (expiresAt passed — computed at read time)
   └─reject──▶ (rejected/)     ├─ broken     (assumption marked broken)
                               └─ closed     (question answered / risk retired)
```

`expired` is **computed when read**, never written by a timer: an exception past
`expiresAt` is simply not active. No scheduler, no background job.

A record is **active** when `status === 'active'` and it has not expired.
Only active records reach briefs.

## How records get written

Through the existing governed path only — **no new write tool that skips review**.

- **New operations** for the distiller and `applyOps` (`src/ops.js`):
  `addRecord`, `editRecord`, `setRecordStatus` (break / close / replace),
  `linkRecords`. `applyOps` keeps its add → edit → delete order; IDs are minted on
  apply and the contribution's ID is added to `sourceContributionIds`, as for
  statements (the fix #112 made for link targets applies here too).
- **The AI classifies.** When someone contributes "we're assuming about 20 people;
  confirm Wednesday", the distiller proposes an `addRecord` of type `assumption`
  with `reviewBy` filled. People never pick a type; the manager can correct it
  when reviewing.
- **Review policy:** record operations are never additive for `isAdditive()` in
  Phase 1 — every record change queues for the manager, whatever the project's
  policy. Phase 2 replaces this with per-type control.
- **Existing decision tags** (`tagged: 'decision'` contributions) are left as they
  are and keep their inline markers. A one-off, opt-in `teamctx records adopt`
  (Phase 1) proposes decision records from them as one reviewable contribution.

## How records are read

- **Briefs** (`my_brief`, `get_role_context`, `task_compile`, `get_context`): a
  "Rules, decisions and assumptions" section listing active records for the
  caller's scope — project records plus those of their workstreams — **each
  exception printed under the rule it bends**, never as a separate contradictory
  line. Assumptions show their review date; questions and risks show their owner.
- **New read tools:** `list_records` (filters: type, status, workstream, owner,
  due) and `get_record`. Both scope-filtered with the same `inScope` checks as
  `get_workstream`; out-of-scope records are absent, not hidden.
- **Context view (#103):**
  - In the drawer, a statement or task shows the records attached to it.
  - A "Rules & decisions" panel per workstream, in the plain labels above.
  - A manager-only **Needs attention** strip: assumptions past `reviewBy`,
    broken assumptions, exceptions expiring within 14 days, open questions
    without a decision (Phase 2 adds conflicts and missing evidence).
- **Deep links** (`viewUrl`, #112) gain `?record=<id>`.

## Phases

### Phase 1 — records exist, are governed, and reach every AI
- Record shape + `records: []` in tree files; validation of required fields per type.
- `addRecord` / `editRecord` / `setRecordStatus` / `linkRecords` operations;
  distiller classifies; every record change reviewed.
- Briefs include active records, exceptions under their rules.
- `list_records`, `get_record`; `viewUrl` with `?record=`.
- Context view: records in the drawer, Rules & decisions panel, Needs attention strip.
- `teamctx records adopt` for existing decision tags.

### Phase 2 — life cycle, impact and control per type
- **Impact:** marking an assumption broken returns, and shows, everything that
  `restsOn` it — records, the tree statements and tasks they are attached to.
  The manager's view lists them as "review these".
- **Contradictions:** at contribute time the distiller compares a proposed record
  with active records in the same scope and, on conflict, proposes an open
  question instead of a silent second statement.
- **Evidence:** `evidence[]` on records; agents may propose evidence (and only
  evidence and tasks) — added to `AGENT_TOOLS` behaviour via `contribute`.
  "Evidence missing" shows for assumptions marked as needing it.
- **Control per type:** `config.governance` maps type → who may make it active
  without review: `manager` (default for decision, rule, exception), `owner`
  (assumption status, question close), `anyone` (opt-in). The manager can always
  override; agents never approve.
- A record can **spawn a task** (`task_add` with `fromRecord`), linked both ways.

### Phase 3 — setup drafted by AI, and visibility per record
- `propose_structure` (#88) drafts goal, whys, workstreams, tasks, suggested
  owners **and initial records** from what the manager pastes, including open
  questions for contradictions it found. The manager edits and accepts it as the
  founding contribution (#70).
- **Visibility per record:** `visibility: { onlyFor: [keys] }` or
  `{ hiddenFrom: [keys] }`, enforced in the payload like scope; the manager is
  shown that a hidden record exists, never its text, and every change to
  visibility is attributed.

### Phase 4 — decide the tree's future (separate spec)
With Phases 1–3 in use: whether whys become records attached anywhere, whether
What/How become workstreams and tasks with flexible depth, and whether to move to
one file per record ahead of Drive / SharePoint storage.

## Errors and edge cases

| Case | Behaviour |
|---|---|
| Record missing a required field for its type | Distiller asked to fill it; if still missing, the operation is refused with the field named |
| Exception whose `bends` target is not an active rule in scope | Refused: "an exception must name the rule it bends" |
| `replaces` points at a record in another workstream | Refused in Phase 1 |
| Reviewer edits a record's type during review | Allowed; required fields re-validated |
| Expired exception | Not active; still listed in history and the manager view as "expired" |
| Old client reading a tree with `records` | Ignored; the field is additive |
| Snapshot of a tree with records | Records included, filtered by scope like trees (`visibleSnapshot`) |

## Must hold

- **No record becomes active without passing the review path** (Phase 1: the
  manager; Phase 2: the configured approver). AI pre-checks flag, never approve.
- **Out-of-scope records are absent from every payload**, not hidden by a view.
- **Exceptions never reach a brief without the rule they bend.**
- **Plain language everywhere a person or AI reads a record**; type names stay internal.
- **Storage stays the team's own**; nothing about records is kept on the
  deployment except what the read log (#111) already records.

## Existing open source first

- **Concepts, not code:** decision records follow the **ADR / MADR** convention
  (status, "superseded by"); assumptions, risks and open questions follow the
  **RAID log** used in project management. Field names stay close to those so the
  model is familiar to managers and to anyone importing from those formats.
- **Validation:** the per-type required fields are a small JSON Schema; validate
  with **[Ajv](https://ajv.js.org/)** (MIT) rather than hand-written checks if the
  rules grow past a handful.
- **Dates:** `reviewBy` / `expiresAt` are ISO dates compared as strings — no date
  library needed.
- **Nothing to borrow** for the governance itself (life cycle, impact, exceptions
  applied to rules, scoped briefs) — that is the product.

## Testing

- `src/ops.test.js`: each record operation applies, mints IDs, keeps provenance,
  validates required fields per type; record operations are never additive.
- Briefs: an exception appears under its rule and nowhere else; expired, replaced
  and broken records are absent; a scoped member gets only in-scope records.
- `list_records` / `get_record`: scope enforced in the payload (mirrors the
  #77/#85 tests); agent tokens can read their scope only.
- Context view: drawer shows attached records; Needs attention strip is
  manager-only and lists due, broken and expiring items.
- Phase 2: impact of a broken assumption lists every dependent; contradiction
  check proposes a question; per-type control honours `config.governance`.
- Upgrade: a project without `records` behaves exactly as before.

## Open questions for the plan

- Does `reviewBy` passing change anything beyond the Needs attention strip
  (e.g. a line in the owner's brief: "you said you'd check this by …")?
- How many active records can a brief carry before it needs summarising?
