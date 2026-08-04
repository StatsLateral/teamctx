# Tasks

Tasks are first-class objects in teamctx — you can track them alongside
Whys / Whats / Hows / Decisions / Roles. Each task has an id, title, owner,
status (`open` / `done`), and lives in exactly one workstream.

The AI-ready prompt file for a task is generated **only on demand** via
`teamctx task compile`, not automatically on every tree change. This keeps
token usage predictable: CRUD is free, only `compile` costs an AI call.

## Quickstart

```sh
teamctx task add "Plan the Q3 paid-ads pivot"
# → t-plan-the-q3-paid-ads-pivot added

teamctx task list
# → shows open tasks in the active workstream

teamctx task compile t-plan
# → writes .teamctx/context/tasks/t-plan-the-q3-paid-ads-pivot.md
#   copy that file's contents into ChatGPT / Claude / Cursor

teamctx task done t-plan
# → marked done, committed
```

Every command accepts either a full task id or a unique prefix, same as
snapshots.

## Commands

| Command | Purpose |
| --- | --- |
| `teamctx task add "<title>" [--owner ...] [--workstream ...]` | Create a task. Default owner = you, default workstream = active. |
| `teamctx task list [--status open\|done] [--owner ...] [--workstream ...] [--all]` | List tasks. Defaults to open tasks in active workstream. |
| `teamctx task show <id>` | Show a task's metadata + compiled-file path. |
| `teamctx task done <id>` | Mark done. Sets `doneAt` to today. |
| `teamctx task reopen <id>` | Move a done task back to open. |
| `teamctx task assign <id> --owner <name>` | Reassign. |
| `teamctx task rm <id>` | Remove the task and its compiled prompt file (if any). |
| `teamctx task compile <id> [--role <slug>] [--force]` | **AI call.** Generate the prompt file. |

## `task compile` in detail

`compile` reads the task's workstream tree, filters to what's relevant, and
generates a focused markdown prompt at
`.teamctx/context/tasks/<task-id>.md`. It also writes `compiledAt` back onto
the task record so future runs can detect staleness.

- **Staleness check:** if the compiled file exists and the workstream JSON
  hasn't changed since `compiledAt`, `compile` is a no-op — no AI call, no
  cost. Pass `--force` to regenerate anyway.
- **Role scoping:** `--role <slug>` frames the prompt for one role's
  perspective (e.g. what a Head of Growth needs for this task, not what an
  engineer would).
- **Decisions:** any `--decision` contributions on the same workstream are
  surfaced inline so the AI treats them as canonical.

## What the compiled file looks like

```md
# Task: Plan the Q3 paid-ads pivot

**Owner:** Priya · **Workstream:** growth · **Status:** open
**Created:** 2026-07-24 · **Compiled:** 2026-07-24

## Relevant context
- Why: pivot away from paid Google Ads (decision — Priya, 2026-06-14)
- What: double down on LinkedIn organic + paid
- How: Q3 budget of $200k, focus on North American mid-market

## Related decisions
- *Paused paid ads on Google (Priya, 2026-06-14, via cli)*

## Suggested framing for your AI
Paste this file as system context and ask: "Given the above, help me draft
the Q3 paid-ads pivot plan — key decisions, risks, and rollout steps."
```

The layout deliberately mirrors the role file layout so anyone who's used
those already knows how to paste this into ChatGPT / Claude / Cursor.

## Where tasks live on disk

- Task records live inline in `.teamctx/workstreams/<ws>.json` under a
  `tasks: []` array. A workstream without the field is treated as empty
  (no migration needed).
- Compiled prompts live at `.teamctx/context/tasks/<task-id>.md`, one file
  per compiled task. Removed when you `task rm`.

## `teamctx status`

`teamctx status` now includes a one-liner:

```
Tasks:        3 open, 7 done (1 compiled)
```

## `teamctx ask`

When you run `teamctx ask "<question>"`, open tasks in the target workstream
are included in the grounding context, so the AI knows what's in flight.

## Not exposed via MCP (yet)

Tasks are CLI-only in this release. An MCP surface (`list_tasks`,
`task_add`, `task_done`, `task_compile`) is a natural follow-up but is
deliberately not shipping in this PR — the CLI shape should settle first.

## Guardrails and non-goals

- No auto-regeneration of compiled files on tree changes.
- No task-level permissions or approvals — same trust model as the CLI.
- No due dates, priorities, or dependencies.
- No cross-workstream tasks — one task lives in exactly one workstream.
