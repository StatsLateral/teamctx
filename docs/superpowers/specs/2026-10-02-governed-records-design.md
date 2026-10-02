# Governed records: goal, workstreams, tasks and typed records

**Date:** 2026-10-02
**Status:** Model and sequence approved in conversation; spec pending review
**Rollout:** clean break. teamctx is pre-launch, so the Why → What → How tree is
replaced outright, with no migration and no compatibility layer.
**MVP narrowing (2026-10-02, maintainer decision):** records are limited to four
types — `decision`, `assumption`, `rule`, `exception`. *Why* becomes the goal's
`why` and each record's `detail`; *question* and *risk* are dropped until the
experiment shows they are needed. Sections below that list seven types describe
the full design; the code implements the four.
**Builds on:** decisions-first-class (2026-07-03), context inheritance (2026-09-09),
review policy (#109), workstream scope (#77/#85), context view (#103), read log (#111)

## Problem

teamctx stores a team's context as a fixed three-level Why → What → How tree per
workstream, plus a separate list of tasks. Two things are wrong with that:

1. **"Why" is forced to be a level**, when it is really an explanation that can
   belong to anything — the goal, a part of the work, a single task. And a How
   ("document ROI from 3 clients before Q3") is a task without an owner, so the
   same thing gets written twice.
2. **What a team relies on has no shape.** Decisions are a tag on a contribution;
   assumptions, rules, exceptions, open questions and risks are ordinary lines in
   the tree, with no owner, no approval of their own, no review date, no expiry,
   and no way to mark one broken. Every member's AI sees a rule and its exception
   as two contradictory statements.

For a team where everyone brings their own AI, those records are exactly what
each AI must get right and what the manager must govern.

## The model

```
Project
├─ goal (one line) + why records
├─ Workstream 1                 nestable, any depth (1, 1.2, …)
│   ├─ Workstream 1.2           members are assigned to workstreams;
│   │   └─ Task 1.2.1           scope carries down to everything below
│   └─ Task 1.1                 owner, open/done, compiled prompt
└─ Records, attached to the project, a workstream or a task:
   why · decision · assumption · rule · exception · question · risk
```

- **What → workstreams** (nested), **How → tasks**, **Why → why records** that can
  explain the goal, a workstream or a task.
- **Numbering** is for display and for people to point at things in chat:
  workstreams by their order in the project (1, 1.2, …), tasks after the
  workstream that holds them (1.2.1). It's recomputed on read, so moving or adding
  things renumbers them. Stable IDs sit underneath for links and history.

### Storage

The access boundary stays one file per workstream, as today:

```
.teamctx/project.json           { name, goal, records: [], tasks: [] }
.teamctx/workstreams/<id>.json  { id, name, parent, order, records: [], tasks: [] }
```

- `parent` is a workstream ID or `null` (directly under the project).
- A workstream's records and tasks live in its own file. A record attached to a
  task lives in the file of the workstream that holds the task.
- Scoping, the hosted read path (`GithubSession` prefetch), "never send a tree the
  reader isn't on" (#108) and snapshots keep working on the same file boundary.
- Compiled task prompts stay in `context/tasks/<id>.md`.

### Goal

```js
goal: { text, sourceContributionIds: [], updatedAt }   // one per project
```

### Task (today's task, unchanged apart from where it sits)

`{ id, title, owner, ownerKey?, status: 'open'|'done', createdAt, doneAt,
compiledAt, sourceContributionIds }`. Depth comes from nested workstreams, not
subtasks.

### Record

```js
{
  id: 'rec-…',                  // minted when the operation is applied
  type: 'decision',             // why | decision | assumption | rule | exception | question | risk
  text: 'Entry offer is a 6-week fixed-price engagement',
  detail: 'Removes the "consultants are expensive" objection',   // optional
  status: 'active',             // active | replaced | broken | closed
  owner: { key, name } | null,  // required for assumption, question, risk
  attachedTo: { kind: 'project' } | { kind: 'workstream', id } | { kind: 'task', id },
  reviewBy: '2026-11-01',       // assumption: required
  expiresAt: '2026-12-31',      // exception: required
  links: { restsOn: [], bends: null, replaces: null, answers: null },
  sourceContributionIds: [],
  approvedBy: { key, name, at } | null,
  createdAt, updatedAt,
}
```

| Type | Read as | Required |
|---|---|---|
| `why` | "Why it matters: …" | — |
| `decision` | "We decided: …" | — |
| `assumption` | "We're assuming: … (check by <date>)" | `owner`, `reviewBy` |
| `rule` | "Rule: …" | — |
| `exception` | "Allowed: … (until <date>, instead of: <rule>)" | `links.bends`, `expiresAt` |
| `question` | "Open question: … (<owner>)" | `owner` |
| `risk` | "Risk: … — plan: <detail>" | `owner` |

**Life cycle.** A record enters as a proposal in the review queue, and becomes
`active` when approved. It leaves as `replaced` (a newer record `replaces` it),
`broken` (an assumption marked broken) or `closed` (a question answered, a risk
retired). **Expiry is computed when read:** an exception past `expiresAt` counts
as expired and is not active, with no timer or background job. Only active,
unexpired records reach briefs.

## Writing: one governed path

Everything that changes context still goes through `contribute` → distiller →
operations → review queue → `applyOps`. No tool writes records without review.

**Operations** (`src/ops.js`, replacing `addWhy`/`addWhat`/`addHow`/
`editStatement`/`deleteStatement`):

| Operation | Does |
|---|---|
| `setGoal` | Set or reword the project goal |
| `addRecord` | Add a record of any type, attached to project / workstream / task |
| `editRecord` | Change text, detail, owner, dates or links |
| `setRecordStatus` | Mark replaced / broken / closed |
| `addTask` | Add a task to a workstream or the project (no owner unless given) |
| `editTask` | Retitle a task |
| `removeTask` | Remove a task |

IDs are minted on apply, and the contribution's ID is added to each touched
item's `sourceContributionIds`.

**The AI classifies.** The distiller prompt (`src/ai.js` `proposeDiff`) is
rewritten for the new operations. People never choose a type: "we're assuming
about 20 people, confirm Wednesday" becomes an `addRecord` of type `assumption`
with `reviewBy` filled in. The manager can correct the type during review.
Documents (`import`, `intent: 'document'`) are mined for durable records:
decisions, rules, assumptions.

**Review policy** (`src/review-policy.js`). `isAdditive` treats `addTask` and
`addRecord` as additive **except** records of type `decision`, `rule` or
`exception`, which always queue. Edits, status changes and removals are never
additive. New projects default to `all` (#109).

**Structure changes are manager tools, not contributions:**
- `workstream_add` (new, manager-gated): name, optional `parent`.
- `workstream_split` and `suggest_workstream_splits` are **removed**. They split a
  Why/What/How tree.
- `propose_structure` is rewritten to return a **draft** in the new model (goal,
  whys, workstreams, tasks, suggested owners). It stays read-only in #A; applying
  a draft in one step is parked.
- `reflect` (a whole-tree rewrite) is **removed**. It has no meaning for records.
- `init` sets the goal from the founding contribution (#70, #99).

## Reading

- **Scope** (`src/member-scope.js`). A member on workstream W reaches W and every
  workstream below it. `inScope` checks a workstream's ancestors. Project level is
  always in scope, as today.
- **Briefs** (`src/context.js`: shared Markdown, role files, `my_brief`,
  `task_compile`, `get_context`). These follow the path from the project down to
  the reader's workstreams:
  1. The goal and its whys.
  2. For each workstream on the path: its whys, then "Rules, decisions and
     assumptions", **each exception printed under the rule it bends, never on its
     own**, then open questions and risks with owners.
  3. Tasks, with each task's attached records.

  All of it in the plain labels above; type names never appear.
- **`tree-digest.js`** (the founding contribution read-back) summarises goal,
  whys, workstreams, tasks and counts of records by type.
- **`provenance.js` / `ask`**: walk goal, records and tasks instead of
  why/what/how nodes. Citations name records and tasks.
- **New tools:** `list_records` (filters: type, status, workstream, owner, `due`)
  and `get_record`, scope-filtered in the payload. `workstream_add`.
- **Changed tools:** `get_workstream` and `get_context` return the new shape.
  `get_stats` counts records and tasks. `viewUrl` (#112) takes `?item=` for any
  workstream, task or record ID.

## Read-only MVP UI (#B, built after #A)

Replaces the Why/What/How columns on `/project/:owner/:repo` (#108) with lenses
on the new model, keeping #108's guarantees (scope enforced in the payload,
escaping, deep links, no AI calls from the page):

1. **At a glance** (the default): the goal and its whys in plain words. A
   manager-only **Needs attention** strip: assumptions past `reviewBy`, broken
   assumptions, exceptions expiring within 14 days, open questions, items waiting
   for review. One line per workstream with open tasks, owners and record counts.
2. **Outline:** the numbered, collapsible structure (workstreams → tasks), with
   each item's records shown as short plain-label lines under it.
3. **Rules & decisions:** every active rule (with its exceptions beneath),
   decision and assumption in scope, grouped by workstream.
4. **Who's on what:** people and agents against workstreams and tasks.

Clicking any item opens a drawer with its records, who contributed, and the
copy-a-prompt button (#108). `?item=` opens the item; an unknown item shows "That
item isn't here anymore", which closes the first two #115 items.

## Removed in #A

`addWhy`/`addWhat`/`addHow`/`editStatement`/`deleteStatement`; the Why/What/How
renderers and prompts; `reflect`; `workstream_split`; `suggest_workstream_splits`;
`normalizeSubworkstreamProposal`; `preserveSourcesThroughReflect`; the
project-layer `main` migration (`src/migrate-project-layer.js`, `LEGACY_MAIN`).
Any README and docs text describing Why/What/How is rewritten in #A, at least
the parts describing the model.

**Existing data:** none is migrated. A tree file containing `whys` is reported
clearly ("this project uses the old format; run `teamctx init` again") rather than
read as empty.

## Must hold

- No record or task becomes part of the shared context without the review path;
  decisions, rules and exceptions always need the manager. AI pre-checks flag,
  never approve.
- Out-of-scope workstreams, with their records and tasks, are absent from every
  payload, including through nested workstreams.
- An exception never reaches a brief without the rule it bends.
- Plain language wherever a person or AI reads a record. Type names stay internal.
- Storage stays the team's own repository.

## Existing open source first

- **Concepts:** decision records follow the ADR / MADR convention (status,
  "superseded by"). Assumptions, risks and open questions follow the RAID log used
  in project management. Field names stay close to these.
- **Validation:** goal, workstream, task and record shapes are JSON Schemas,
  validated with **[Ajv](https://ajv.js.org/)** (MIT), not hand-written checks.
  Ajv is the one new dependency.
- **Dates:** ISO date strings compared as strings, so no date library.
- **Nothing to borrow** for the governance itself (life cycle, exceptions applied
  to rules, scoped briefs). That's the product.

## Testing

Test-driven throughout:
- Schemas: every type's required fields, plus rejection of malformed shapes.
- `applyOps`: each operation, ID minting, provenance, the add → edit → remove
  order.
- `isAdditive`: decision/rule/exception adds always queue.
- Scope: nested workstreams inherit, siblings don't. A payload never contains an
  out-of-scope workstream, record or task.
- Briefs: exceptions under their rules only; expired, replaced, broken and closed
  records absent; plain labels, never type names.
- Tools: `list_records`, `get_record` and `workstream_add` (manager-gated);
  removed tools are gone from `TOOLS`.
- Old-format detection message.
- The 47 test files built on Why/What/How fixtures are rewritten to the new
  model, not deleted, so the behaviour they protected stays covered.

## Delivery

| Issue | Who | Contents |
|---|---|---|
| **#A Data model** | Claude | Everything above except the UI section; one PR |
| **#B Read-only MVP UI** | Claude | The UI section; one PR, after #A |
| Parked | contributors | Control per type (who may approve which type); impact when an assumption breaks; contradiction check at contribute time; evidence from agents and analytics; visibility per record; applying an AI-drafted setup in one step; the #115 identity-link expiry |

Claude's PRs are reviewed by another maintainer (satyagyasingh) before merge.
