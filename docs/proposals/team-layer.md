# Seam: a team layer above the project

**Status:** Deferred — recorded, not planned · **Serves:** Structured workstreams ·
**Issue:** [#84](https://github.com/StatsLateral/teamctx/issues/84)
· **Design spec:** `docs/superpowers/specs/2026-09-09-context-inheritance-and-membered-onboarding-design.md`

This is not a proposal to build anything. It records where a team layer would go,
so that the pieces shipped around it do not quietly close the door on it.

## The intended hierarchy

```
team          context shared by several projects        — not built
  project     one Why / What / How tree                  — built (#80)
    workstream  a branch of the project, developed further — built
      task      a unit of work in a workstream             — built
```

Each level inherits the one above and adds its own detail. Workstreams inherit
the project today: the project tree is rendered above the workstream's own at
compile time, and never copied into the workstream's file.

## What the MVP does instead

**One team is one project.** There is no team entity anywhere — not in
`.teamctx/`, not in `config.json`, not in the compile paths. Everything a team
would otherwise own sits on the project:

- the roster of members, and which workstreams each may reach;
- the manager gate, `managerKey` and `managerKeys`;
- the review policy;
- the project's own context, `project.json`, which is the top of the tree.

A team that runs several projects today runs several independent teamctx
projects, each with its own roster, manager and context.

## Where a team layer would slot in

Two different mechanisms fit here, and they should not be confused.

**Inheritance — a tree above the project.** A team context that several projects
inherit exactly the way a workstream inherits its project: read-only, rendered
above the project's own tree when a view is compiled, never copied. This is the
natural extension of what exists. The compile paths already take one inherited
tree; they would take a chain of them.

**Links — sideways between projects.** The existing *cross-project context
links* item on the roadmap: a decision in one project's context updates a linked
context in another. That is propagation between peers, not inheritance from
above, and it can exist with or without a team layer.

## What makes this hard, and why it is deferred

**A project is one repository.** `.teamctx/` lives inside it, the CLI finds it by
walking up from the working directory, and the hosted server scopes every
request to one owner and repository. A team context shared by several projects
has no single repository to live in. Deciding where it lives — its own
repository, a reference from each project, or something that is not git — is
the first question a team layer has to answer, and nothing in the MVP forces it.

**Governance would have to move up.** If a team owns a roster and a manager,
the per-project copies become either overrides or duplicates. Both are real
designs; neither is worth choosing before a team needs one.

**It is close to a non-goal.** Org hierarchies are listed as a non-goal on the
roadmap. A team layer is a context layer, not an org chart, and it should stay
that way if it is ever built.

## What to keep true in the meantime

- The inherited tree stays a parameter of compilation, not a special case of the
  project. That is what lets a second level be added above it.
- Nothing assumes the project is the top of the tree in a way that would be
  expensive to undo — for example, by copying project nodes into workstream
  files.
- Workstreams stay peers. A team layer adds a level *above* the project; it is
  not a reason to nest workstreams inside one another, which is not supported.
