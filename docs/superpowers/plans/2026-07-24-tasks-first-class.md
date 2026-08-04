# Plan: tasks as first-class objects with on-demand prompt compile

**Branch:** `feat/tasks-first-class` (off `feat/workstream-integration-fixes`)
**PR base:** `main` — diff will look larger until the parent fix branch merges upstream; collapses to just the tasks work after that.
**PR shape:** Single PR — CRUD + compile + status integration + docs.

---

## Motivation

Today teamctx compiles a **role-level** context file at
`.teamctx/context/roles/<slug>.md` — a single AI-ready prompt that bundles the
whole Why/What/How tree filtered for that role. That's great for "everything a
Head of Growth needs to know," but too broad when the user is trying to focus
on **one thing** ("plan the Q3 paid-ads pivot," "migrate the auth system").

Managers want tasks to be **first-class objects** in the tree — with identity,
owner, status, and workstream — so they can be listed, filtered, and tracked
alongside Whys and Roles. But they also want to avoid paying for an AI call on
every task on every tree change (which is what would happen if compiled task
files followed the same auto-regeneration lifecycle as role files today).

The resolution: split the two lifecycles.

- **Task record** — cheap, always fresh, stored in the workstream JSON. Add,
  list, show, done, assign, remove — all local file ops, zero AI.
- **Compiled task prompt** — expensive, generated on demand via an explicit
  `teamctx task compile <id>` command, cached at
  `.teamctx/context/tasks/<slug>.md`, never auto-regenerated.

This matches the shape of the current 🟢 *decisions as first-class* PR and is
worth landing after decisions merges so we can copy patterns rather than
invent them twice.

## Non-goals (call these out in the PR body)

- **No MCP surface for tasks in v1.** Manager explicitly said no MCP.
- **No auto-regeneration** of compiled task files on tree changes. Compiled
  files are point-in-time snapshots; the user re-runs `task compile --force`
  when they want them refreshed.
- **No cross-workstream tasks.** One task lives in exactly one workstream.
- **No task-level permissions or approvals.** Anyone can add/mark done. Same
  trust model as the CLI today.
- **No due dates, priorities, or dependencies.** Deliberate scope discipline —
  this is *not* a Jira clone.

## Data model

Add a `tasks` array to each workstream file at
`.teamctx/workstreams/<ws>.json`:

```jsonc
{
  "id": "main",
  "name": "Main",
  "whys": [...],
  "tasks": [
    {
      "id": "t-plan-q3-ads",
      "title": "Plan the Q3 paid-ads pivot",
      "owner": "priya",
      "status": "open",            // "open" | "done"
      "workstream": "main",
      "createdAt": "2026-07-24",
      "doneAt": null,
      "compiledAt": null           // ISO date; null until first compile
    }
  ]
}
```

**Id format:** `t-<slugified-title>`, deduped with `-2`, `-3` suffixes on
collision. Consistent with existing snapshot / queue id shapes. Git-style
prefix matching supported on all id-taking commands (same helper the
snapshots feature already ships).

**Migration:** none required. A workstream file without a `tasks` field is
treated as `tasks: []` by the read helper. `writeWorkstream` always writes the
field back (as `[]` if empty) after the first task-related write.

## Commands

All in a new `cli/commands/task.js` + `cli/commands/task.core.js` split
(following the pattern established on `feat/mcp-full-surface`).

| Command | AI? | What it does |
| --- | --- | --- |
| `teamctx task add "<title>" [--owner ...] [--workstream ...]` | No | Append to tasks array on target workstream (defaults to active workstream, then `main`). Print id. Commit. |
| `teamctx task list [--status open\|done] [--owner ...] [--workstream ...] [--all]` | No | Filtered table print. Default: open tasks in active workstream. `--all` = every workstream. |
| `teamctx task show <id-or-prefix>` | No | Print metadata + owner + status + workstream + whether a compiled file exists (and its path). |
| `teamctx task done <id-or-prefix>` | No | Set `status: done`, `doneAt: today`. Commit. |
| `teamctx task reopen <id-or-prefix>` | No | Set `status: open`, clear `doneAt`. Commit. |
| `teamctx task assign <id-or-prefix> --owner <name>` | No | Reassign. Commit. |
| `teamctx task rm <id-or-prefix>` | No | Remove from array. If a compiled file exists, delete it too. Commit. |
| **`teamctx task compile <id-or-prefix> [--role <slug>] [--force]`** | **Yes** | Generate `.teamctx/context/tasks/<slug>.md`. Sets `compiledAt` on the task. Refuses if file exists and workstream file has not changed since `compiledAt` unless `--force`. |

Only `task compile` costs tokens. Everything else is local file ops.

### `task compile` behavior in detail

1. Resolve `<id-or-prefix>` against tasks in every workstream.
2. If compiled file already exists at
   `.teamctx/context/tasks/<task-slug>.md` and the containing workstream
   file's mtime is `<= task.compiledAt` → print "already compiled, use
   `--force` to regenerate" and exit 0.
3. If `--role <slug>` passed, prompt is scoped through that role's lens
   (reuse the role-context builder). Otherwise, scope to the whole workstream
   tree.
4. Call `compileTaskPrompt({task, workstream, role?, contributions, config})`
   → returns markdown string.
5. Write to `.teamctx/context/tasks/<task-slug>.md`, update `compiledAt` on
   the task, commit.
6. Print path to compiled file + a copy-paste hint.

### Prompt shape (compiled file)

```md
# Task: Plan the Q3 paid-ads pivot

**Owner:** Priya · **Workstream:** growth · **Status:** open
**Created:** 2026-07-24 · **Compiled:** 2026-07-24

## Relevant context (from the growth workstream)

- Why: We're pivoting away from Google Ads (decision — Priya, 2026-06-14)
- What: Doubling down on LinkedIn organic + paid
- How: Q3 budget of $200k...

## Related decisions

- *Paused paid ads on Google (Priya, 2026-06-14, via cli)*

## Related roles

- head-of-growth — full context at [context/roles/head-of-growth.md](../roles/head-of-growth.md)

## Suggested framing for your AI

Use the above as grounding context. When answering, prefer decisions marked as
first-class over inferred context.
```

Deliberately mirrors the role-file layout so anyone who's used those already
knows what they're pasting.

## Storage helpers

New helpers in `src/storage.js`:

- `listTasks({workstream?})` — flatten tasks across one or all workstreams.
- `readTask(id)` — resolve prefix, return `{task, workstream}` tuple.
- `writeTask(task)` — upsert into the correct workstream file.
- `deleteTask(id)` — remove from workstream + delete compiled file if any.

All operate on the tasks array within workstream files. No new top-level
files.

## Status integration

`teamctx status` gains one line per workstream after the existing Why-node
breakdown:

```
Workstream: main
  Whys: 8 · Roles: 3
  Tasks: 2 open, 5 done (1 compiled)
```

Cheap, no AI, always fresh.

## Ask integration (small, worth doing)

`teamctx ask` gains an implicit tasks section in its grounding context: when
answering a question, include open tasks from the active workstream so
answers can reference in-flight work. No new flag; just extend the context
builder.

## MCP

Nothing in this PR. Manager explicitly excluded MCP. A follow-up branch can
expose `list_tasks` / `get_task` / `task_add` / `task_done` / `task_compile`
once the CLI shape settles. Note this in the CHANGELOG under a "not shipping"
line so the intent is on record.

## Files touched

New:
- `cli/commands/task.js` — CLI shim (prompts, printing).
- `cli/commands/task.core.js` — pure functions for MCP-later reuse.
- `cli/commands/task.test.js` — CRUD + list filters + compile happy path + prefix resolution + force flag.
- `src/ai/compileTaskPrompt.js` — the one AI call.
- `src/ai/compileTaskPrompt.test.js` — snapshot the prompt shape.
- `docs/tasks.md` — user-facing explainer with examples.

Modified:
- `src/storage.js` — task helpers, migration-tolerant reads.
- `src/storage.test.js` — round-trip tasks on workstream files.
- `cli/index.js` — wire the new `task` command group.
- `cli/commands/status.js` — add tasks line.
- `cli/commands/status.test.js` — assert the new line.
- `cli/commands/ask.js` (or `src/ai/ask.js`) — include open tasks in ask
  grounding context.
- `README.md` — add tasks to the feature list.
- `CHANGELOG.md` — `## [Unreleased]` entry.
- `.teamctx/context/tasks/.gitkeep` — ship the empty dir so users' first
  `task compile` doesn't stumble on a missing folder.

## Order of work

Roughly 2 days of focused work. Each step is independently testable and
commits cleanly.

1. **Storage + data model** — tasks array, read/write helpers, migration
   tolerance, tests. **Half day.**
2. **CRUD commands** — add / list / show / done / reopen / assign / rm.
   Prefix resolution. Tests. **Half day.**
3. **`task compile`** — AI call, file write, `compiledAt` bump, staleness
   check, `--force`, `--role` scoping, tests. **Half day.**
4. **Status + ask integration + docs + CHANGELOG.** **Half day.**

## Testing checklist

Before opening the PR:

- [ ] `npm test` green.
- [ ] Manual: fresh `init`, `task add`, `task list`, `task done`, `task
      compile` end-to-end, inspect compiled file.
- [ ] Manual: two-workstream project, `task add --workstream tech`, ensure
      the task lands on tech and not main.
- [ ] Manual: `task compile` twice — second run says "already compiled",
      `--force` regenerates.
- [ ] Manual: `task rm` deletes the compiled file too.
- [ ] Manual: `teamctx status` shows the tasks line.
- [ ] Manual: `teamctx ask` grounds against open tasks.
- [ ] `CHANGELOG.md` entry under `## [Unreleased]`.
- [ ] Commits signed off (`git commit -s`).
- [ ] PR description filled in.

## Follow-ups (out of scope for this PR)

- MCP surface (`list_tasks`, `task_add`, `task_done`, `task_compile`) once
  CLI settles.
- Optional: `task compile --all-stale` to bulk-refresh compiled files with
  one AI batch call.
- Optional: `task depends-on <other-id>` for a minimal dependency graph.
- Optional: task-scoped snapshots (freeze the tree at the point a task was
  compiled).
