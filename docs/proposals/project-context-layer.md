# Proposal: project context as a layer workstreams inherit

**Status:** Proposal · **Serves:** Structured workstreams · Managers in control ·
**Rough size:** Large — a new stored tree, every compile path, and a migration
that removes `main` · **Issue:** [#80](https://github.com/StatsLateral/teamctx/issues/80)
· **Design spec:** `docs/superpowers/specs/2026-09-09-context-inheritance-and-membered-onboarding-design.md`

## Problem

A workstream is a standalone Why/What/How tree, and `workstream split` **moves**
Why nodes out of `main` into the new one. Workstreams partition; nothing is
shared.

That reads as a modelling detail until you look at one from inside. A member
scoped to a single workstream gets that workstream's tree and nothing else — a
complete tree and an incoherent brief, because the constraints its every node
depends on (who is involved, what was already decided, what is fixed) live in a
*sibling* tree they cannot see, and correctly should not, being scoped away from
it (#77).

Their context is not a subset of the project's; it is a different tree. So today
the choice is between a member who sees everything and a member who sees
something incoherent, and neither of those is the product.

## The model

```
PROJECT context          the whole Why / What / How tree. The manager owns it.
     │  inherited, read-only in the workstream view
WORKSTREAM context       one Why of the project tree, plus its What / How,
     │                   developed further as that thread of work progresses
TASK                     a unit of work in a workstream
```

A workstream is not an arbitrary tree sitting beside the project's. It is **a
branch of it, developed further**, while still showing the whole tree as
background.

Inheritance is **live, not a copy**: a change to project context appears in every
workstream's compiled view without touching any workstream's stored file.

## What changes

### 1. A project tree that exists on its own

`.teamctx/project.json`, read and written like a workstream, governed by the same
contribution → approval pipeline as workstream context.

Deliberately its own file rather than a reserved workstream id. A reserved id is
precisely what `main` has been — a workstream doing double duty as "the project",
with nothing in the data to tell the two roles apart. Making that distinction
structural is the point of the change; encoding it as a magic string would leave
us where we started.

### 2. Compile-time concatenation, never a copy

Every compile path — `serializeToMd`, `generateRoleFile`, `compileTaskPrompt`,
`answerQuestion`, and the web `/context/<role>` page — renders, for a given
workstream: **the project tree, marked read-only and clearly labelled as
project-level, followed by that workstream's own branch.**

A workstream's stored JSON never contains project nodes. Editing project context
regenerates every workstream's compiled output; it does not rewrite their data.

The read-only marking earns its place. A member reading their brief has to be
able to tell what they may add to from what is settled above them, or the first
thing they do is propose an edit to something that was never theirs.

### 3. Contributing at project level

`contribute` / `ask` / `reflect` gain a project-level target alongside
`--workstream <id>`, so a manager can add to project context without it landing
in a workstream.

Over MCP this is the *absence* of a workstream argument rather than a new one —
the same shape #77 uses, where what the caller omits is resolved server-side
rather than trusted.

### 4. `main` disappears

The project tree *is* the base. A project has a project tree and zero or more
named workstreams; `activeWorkstream` may be unset, meaning "operating at project
level".

This is the part with teeth. `main` is referenced across storage, prefs, task
defaults, role binding and the workstream commands, and each of those has to mean
"project level" afterwards rather than "the workstream called main".

## Migration

Idempotent, mirroring the existing workstreams migration (`src/migrate.js`).

- Today's `main` content becomes the project tree.
- `main` is removed from `workstreams[]`.
- Roles bound to `main` rebind to project level.
- `--workstream main` and `activeWorkstream: main` resolve to project level.
- Existing split workstreams keep their own nodes and now additionally inherit.

A project whose only workstream is `main` ends up with a project tree and no
separate workstreams — **its compiled output is unchanged**. That is the test
that matters: the ordinary project must not be able to tell this happened.

## How this lands on #77

Scoping and inheritance meet, and neither issue says what happens there.

**A scoped member still sees the project tree.** It is inherited, read-only
background, and withholding it recreates exactly the incoherent brief above.
`scopeFor` limits which *workstreams* a caller may reach; it must not limit the
project layer.

Two consequences worth naming before they are discovered mid-build:

- `defaultWorkstream(scope, preferred)` assumes a workstream exists to fall back
  to. With `main` gone and `activeWorkstream` possibly unset, "project level" has
  to be a valid answer rather than a missing one.
- A member scoped to nothing is *project-wide* today. Afterwards they are *at
  project level* — the same access, a different sentence, and the tools should
  say the second one.

## Deliberately not included

- **Promotion back up.** When a workstream's work concludes, its durable
  conclusions arguably belong in the project tree — the inverse of `split`, and
  what would let context outlive a workstream rather than end with it. Worth its
  own issue: there is nothing to promote *to* until this lands, and two
  directions of movement in one migration is a bad trade.
- **The team layer.** team → project → workstream is the intended hierarchy; the
  MVP collapses team into project. Recorded as a seam in #84, not built here.
- **#81, #82, #83.** They depend on this and are scoped separately: AI-proposed
  structure, the non-empty context gate, and the member brief.

## Open questions

1. **Ordering against the founding contribution.** #82 refuses `member_add` when
   context is empty. After migration a project that never contributed has an
   empty project tree and no workstreams, and #72's founding contribution is what
   fills it. The order between the two should be explicit rather than incidental.
2. **`readShared` / `readSharedMd`.** They exist for legacy compatibility and
   currently mean `main`. Afterwards they mean the project tree, which is
   arguably what every caller wanted — worth confirming rather than assuming.
