# Proposal: a member asking for their own tasks

**Status:** Proposal (suggestion, not committed) · **Serves:** Bring your own tools ·
**Rough size:** Small — one filter, and the identity to make it correct

## Problem

#46 asks for the team member's task loop to work in natural language:

> 1. "what are my tasks?" — read op, lists tasks assigned to them

The loop shipped in #47 — `list_tasks`, `get_task`, `task_compile`,
`contribute` — and every step works except the first word of it. `list_tasks`
filters by `owner`, a **string** the caller has to already know:

```js
if (owner) tasks = tasks.filter(t => t.owner === owner);
```

So "what are my tasks?" is only answerable by an assistant that guesses what its
user is called in this project, and guesses the exact spelling. The server knows
who is calling — it resolves an actor on every request — and the one question a
member actually asks is the one it will not answer.

## Why a `mine` flag is not enough on its own

`owner` holds a **display name**. Two properties of display names make matching
one against the caller's current name quietly wrong:

- **It differs by surface.** The name is resolved per-caller: from `git config`
  on a clone, from the GitHub or Google account on the hosted server. The same
  person raising a task from their laptop and asking for it from a chat client
  can be two different strings.
- **It is settable.** `teamctx config name` is a supported command, and after it
  a member's own tasks stop being theirs.

This is the same identity problem the manager gate has already been through, one
layer down — `canApprove` refuses to match on display names for exactly this
reason. The difference is that tasks are not a security boundary, so the failure
is a missing row rather than a hole. That makes it worth fixing correctly but
not worth gating.

## Design

### `ownerKey` alongside `owner`

A task gains an optional `ownerKey` — the actor key of the person it is for,
which survives both a rename and a change of surface. `owner` stays exactly as
it is: it is what a human reads in `teamctx task list`, and every existing task
has one.

It is recorded only when it is actually known:

| How a task gets an owner | `ownerKey` |
| --- | --- |
| Raised without naming one — the common case | the caller's key |
| `--owner "Mia"` / `task_assign` to a name | none; a name does not identify a person |

Guessing a key from a name is what this proposal exists to avoid, so a task
assigned by name simply carries no key and matches on the name, as today.

### `mine`

`list_tasks` and `teamctx task list` gain `mine` / `--mine`: tasks whose
`ownerKey` is the caller's, **or** whose `owner` matches their current display
name. Both halves earn their place — the key covers a rename and a second
surface, the name covers every task that already exists.

`mine` and `owner` together is an error rather than an intersection. They are
two ways to ask the same question, and silently ranking one over the other is
how a caller ends up trusting an empty list.

## Files

| File | Change |
| --- | --- |
| `cli/commands/task.core.js` | record `ownerKey` in `addTask`; `mine` in `listTasksFiltered` |
| `mcp/server.js` | `mine` on the `list_tasks` schema, resolved from the caller |
| `cli/index.js`, `cli/commands/task.js` | `--mine` |
| tests | the rename case, the cross-surface case, and `mine` + `owner` together |

## Out of scope

- **Backfilling `ownerKey` on existing tasks.** It would mean guessing which
  person a name refers to, which is the thing being fixed.
- **Assigning by key.** `task_assign` takes a name because a manager assigning
  work knows a name, not an actor key. Once a roster exists (#42) a name could
  be resolved through it — worth doing then, not before.
- **Gating tasks.** They are deliberately ungated: anyone may act on any task,
  and this changes nothing about that.

## Verification

1. `npm test` — the existing task suite must stay green; `ownerKey` is additive
   and no current task has one.
2. A task raised from a clone is still `mine` after `teamctx config name` sets a
   different display name.
3. A task raised on one surface is `mine` on the other — the case that made this
   more than a filter.
4. A task assigned to someone else by name is not `mine`, and is still found by
   `owner`.
5. `mine` together with `owner` errors rather than returning the intersection.
