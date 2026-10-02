# Workstreams

A teamctx project has a **goal** (with why it matters), the **records** the
team relies on — decisions, assumptions, rules and the exceptions to them — and
**tasks**. When the work has distinct parts, each part is a **workstream**, and
workstreams can sit under other workstreams.

```
Project                      goal + why it matters, project-wide records and tasks
├─ 1  Sales                  its own records and tasks
│   ├─ 1.1  Outreach
│   └─ 1.2  Entry offer
└─ 2  Account expansion
```

Most small teams need one level or none. Add a part only when two groups of
people would each ignore half of what the other part holds.

- [Who sees what](#who-sees-what)
- [Command reference](#command-reference)
- [On disk](#on-disk)
- [Notes and limits](#notes-and-limits)

## Who sees what

- Everyone reads the **project**: its goal and project-wide records are the
  background every part inherits.
- A member put on a workstream (`member_add` / `member_scope` with
  `workstreams`) reaches that workstream **and every part below it**, never a
  sibling or anything under one. A member on no workstream reaches the whole
  project.
- Each person's brief follows the path from the project down to their part:
  the goal, then each part's rules, decisions and assumptions in plain words —
  every exception printed under the rule it bends — then their tasks.
- For a member who signs in with Google and reaches the project through the
  hosted server, this is enforced on every read. For a GitHub collaborator who
  holds a copy of the repository it is advisory: they can read every file.

## Command reference

| CLI | MCP | What it does |
|---|---|---|
| `teamctx workstream add <name> [--under <id>]` | `workstream_add({name, parent?})` | Add a part of the work, at the top or under another part. Manager only. |
| `teamctx workstream list` | `list_workstreams` | Every part, numbered (1, 1.2, …), with record and task counts. |
| `teamctx workstream use [id]` | `workstream_use({id?})` | Your own default part for `contribute` and `ask`; omit the id to work on the project itself. Personal, not committed. |
| `teamctx workstream propose` | `propose_structure` | An AI-drafted structure — goal, parts, tasks, records — for you to accept part by part with `workstream add`. Writes nothing. |

## On disk

```
.teamctx/
  config.json              # workstreams: [{ id, name, parent, order }] — the structure
  project.json             # { name, goal, records, tasks }
  workstreams/<id>.json    # { id, name, records, tasks } — one file per part
  context/
    project.md             # compiled brief for the project
    workstreams/<id>.md    # compiled brief per part, with everything above it
```

The structure (which part sits under which, and their order) lives in
`config.json`, so access checks need no extra reads. Each part's records and
tasks live in its own file.

## Notes and limits

- **Moving or renaming a part** isn't supported yet; add a new one and move
  records by contributing to it.
- **An exception bends a rule in the same part.** An exception to a
  project-wide rule currently has to be recorded at project level.
- **Old projects:** a project still in the Why → What → How format is reported
  as such by every command. Remove its `.teamctx` folder and run `teamctx init`.
