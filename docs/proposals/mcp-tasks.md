# Proposal: tasks over MCP

**Status:** Proposal (suggestion, not committed) · **Serves:** Bring your own tools ·
**Rough size:** Small — the core already exists; this is surface

## Problem

The MCP server exposes 28 tools and describes itself as covering "the full CLI".
It does not. **Every task command is missing** — all eight of them.

That gap matters more than a missing verb usually would, because
`task compile` is the one command that turns shared context into something a
person can act on. It reads the workstream's Why/What/How tree, the role's
responsibilities and the recent decisions, and produces a focused prompt file.
It is the closest thing teamctx has to a deliverable.

So the current state is: a manager can run teamctx entirely from their AI
client — contribute, review, approve, reflect, snapshot — right up to the point
where they want to *do* something with the context, and then they have to open
a terminal.

This was found while using teamctx to run a real content workflow. Every step
worked from the assistant except raising the task and compiling its prompt,
which is the step the whole workflow existed for.

## What exists today

`cli/commands/task.js` holds eight commands over a small, flat record:

```js
{ id, title, owner, status, workstream, createdAt, doneAt, compiledAt,
  compiledFromHash }
```

| Command | What it does | AI call | Writes |
| --- | --- | --- | --- |
| `task add <title>` | Creates a task; id is a slug of the title | no | task file, commit |
| `task list` | Filters by status, owner, workstream | no | — |
| `task show <id>` | One task, by id or unique prefix | no | — |
| `task done <id>` | Marks done, stamps `doneAt` | no | task file, commit |
| `task reopen <id>` | Clears `doneAt` | no | task file, commit |
| `task assign <id> --owner` | Reassigns | no | task file, commit |
| `task rm <id>` | Deletes the task and its prompt file | no | delete, commit |
| `task compile <id>` | **AI call.** Builds a role-scoped prompt from the tree, writes `context/tasks/<id>.md` | **yes** | prompt file, commit |

Everything lives in `src/storage.js` (`writeTask`, `readTask`, `listTasks`,
`deleteTask`, `writeTaskFile`, `taskFilePath`, `taskFileExists`) and
`src/context.js` (`compileTaskPrompt`). **None of it is CLI-specific.** The
command layer is argument parsing, output formatting and a commit.

That is the whole reason this is small: the work is exposing what is already
there, not building anything.

## The constraint that shapes the design

**`teamctx task compile` is the only task command that is expensive and the
only one that can produce a surprising result.** Everything else is a field
update on a small JSON file.

That splits cleanly onto the MCP server's existing tiers:

| Tier | Meaning | Task tools |
| --- | --- | --- |
| **0** | read-only, no AI, no commit | `list_tasks`, `get_task` |
| **1** | additive writes | `task_add`, `task_done`, `task_reopen`, `task_assign` |
| **2** | structural / destructive / gated | `task_rm`, `task_compile` |

`task_rm` belongs in Tier 2 because it deletes a file and its compiled prompt,
and there is no undo short of a git revert. `task_compile` belongs there
because it spends an AI call and overwrites an existing prompt file — a caller
that compiles in a loop is expensive in a way the other seven are not.

Neither needs the *manager gate*. Tasks are not shared context; they are work
tracking, and gating them would stop a team member managing their own work from
their own assistant — which is the point of the MCP surface.

## Suggested approach

### 1. Extract the core, as every other command already has

`cli/commands/task.js` currently mixes three things: reading arguments,
performing the operation, and printing a table. The MCP server needs the middle
one alone.

Follow the pattern already used by `contribute.core.js`, `review.core.js` and
`import.core.js` — move the operations into `cli/commands/task.core.js`
returning plain objects, and leave the CLI file as presentation.

That refactor is the bulk of the work and it changes no behaviour. The existing
task tests should pass untouched; if they do not, the refactor is wrong.

### 2. Eight tools, named to match the existing convention

The server names read tools `get_*` / `list_*` and writes `<noun>_<verb>`:

```
list_tasks      { status?, owner?, workstream?, all? }
get_task        { id }
task_add        { title, owner?, workstream? }
task_done       { id }
task_reopen     { id }
task_assign     { id, owner }
task_rm         { id }            ⚠ RISKY
task_compile    { id, role?, force? }   ⚠ RISKY — AI call
```

`get_task` accepts a unique prefix, as the CLI does. An ambiguous prefix should
return the candidates rather than picking one.

### 3. What `task_compile` must return

The CLI prints a file path and tells the user to open it. **An MCP caller
cannot open a file** — it is often not on the same machine, and on the hosted
server there is no working copy at all.

So `task_compile` returns **the compiled markdown itself**, alongside the path.
That is the difference between the tool being useful and being a pointer to
something the caller cannot reach.

It should also return `alreadyCompiled: true` when the workstream is unchanged
and `force` was not set, so an assistant can say "this is the existing prompt"
rather than implying it just spent a call.

### 4. Hosted mode

`writeTaskFile` and `deleteTask` go through `src/storage.js`, which already
routes to the GitHub adapter when a session is active. Tasks should therefore
work hosted without special handling — **but this needs verifying rather than
assuming**, since no task code has ever run through that path.

## Scope

**In:** the eight tools, the core extraction, tool descriptions carrying the
same risk warnings and reporting instructions as the existing surface, tests in
`mcp/server.test.js` matching how the other tools are covered, and a docs entry
in `docs/mcp.md`.

**Out:** any change to what a task *is*. No new fields, no dependencies between
tasks, no due dates, no subtasks. This proposal exposes what exists.

## Where to start

- `mcp/server.js` — the tool array and the handler map; `get_stats` on the
  `feat/stats` branch is the most recent example of adding one cleanly
- `cli/commands/review.core.js` — the cleanest existing core/presentation split
- `mcp/server.test.js` — every tool is asserted present, tiered, and either
  carrying or not carrying the RISKY marker
- `mcp/hosted-isolation.test.js` — if tasks are claimed to work hosted, this is
  where that claim is tested

## The rest of the MCP gap

Tasks are the largest hole but not the only one. Also absent:

| CLI | Status | Worth exposing? |
| --- | --- | --- |
| `teamctx import <paths…>` | Not on MCP | **Probably not as-is.** It reads local file paths, which a hosted caller cannot supply meaningfully. A remote-source connector would be a different tool. |
| `teamctx pull` | Not on MCP | Yes, arguably — it processes queued web contributions and a manager might reasonably run it from their assistant. |
| `teamctx setup` | Not on MCP | **No.** It shells out to `gh` and `vercel` to create a GitHub repo and set environment variables. That is not something to hand an assistant. |
| `teamctx stats` | On `feat/stats` as `get_stats` | Already done on that branch. |

So after this proposal lands, the honest statement is "the MCP surface covers
the full CLI except `import`, `pull` and `setup`, each for a stated reason" —
which is a claim the README can actually make.

## Open questions

- **Should `task_compile` be manager-gated?** It spends an AI call, and on a
  hosted deployment the key belongs to whoever configured it. Ungated matches
  the CLI and matches the point of tasks; gated protects the key. My reading is
  ungated, because the same argument would gate `contribute` and `ask`, which
  it does not.
- **Should `task_add` accept a `compile: true` shorthand?** Raising a task and
  immediately compiling it is the common case in practice, and two round trips
  for one intention is friction an assistant feels more than a human does.
- **What should `list_tasks` default to?** The CLI defaults to open tasks in
  the active workstream, which is right at a terminal. An assistant asking
  "what am I working on" probably wants the same, but an assistant asked "did
  we finish that" wants everything. The `all` flag covers it; the question is
  which way the default points.
