# Design: project → workstream context inheritance, and what a member sees before they start

**Status:** Approved, ready to file as issues
**Serves:** Structured workstreams · Managers in control · *approved, workstream-scoped,
role-compiled context that outlives the individual* (see
[[teamctx-pmf-strategy]] and `docs/private/2026-09-08-differentiation-and-workstream-scope.md`)
**Filed as:** #80 (foundation) · #81 (AI-proposed structure) · #82 (context gate) ·
#83 (member brief) · #84 (docs / Team-layer seam)

## The model

Work on a teamctx project is organised as a hierarchy. Each level inherits the
level above and adds its own detail:

```
(company / functional context)   — out of scope, noted only as a future seam
        │
   team context                  — MVP: one team = one project; collapsed into project
        │
   PROJECT context               — the whole Why / What / How tree. The manager owns it.
        │  inherited, read-only in the workstream view
   WORKSTREAM context            — one branch of the project tree (a Why + its What/How),
        │                          developed further as that thread of work progresses
   TASK                          — a unit of work in a workstream; several roll up to it
        │
   chats / agent runs            — a person runs several to finish a task
                                   (MVP: acknowledged, not tracked)
```

Two phrasings from the design conversation pin the shape:

- *"Why / What / How are overall project level, but each Why and the related
  What / How are the workstreams."* — the project context is **one tree**. A
  workstream is not a separate arbitrary tree; it is a branch of the project
  tree that a group of people develop further, while still seeing the whole
  tree as background.
- *"A workstream inherits project context and then has its own context, since
  there could be multiple workstreams and team members on a project."* —
  inheritance is live, not a one-time copy. A change to project context shows
  up in every workstream's compiled view.

### Two governance rules

1. **Context cannot be empty when a person is brought on.** When the manager
   assigns a member to a workstream, both the project context and that
   workstream's own context must be non-empty. A member should never open their
   brief to *"No context yet."*
2. **A member's first step is a read-only brief.** Before doing any work, a
   member (or their AI tool) pulls one view: their role — expressed as the
   tasks assigned to them — plus their compiled context (project + their
   workstream). They read it before they start.

### What stays dynamic, not hard-coded

The *membership model* is proposed by the AI to the manager per project, not
fixed by the product. One manager runs a pure task-list model (a member's role
is just their assigned tasks); another runs a workstream-position model (a
member owns a whole workstream and everything in it). teamctx already works this
way for `suggest_workstream_splits` and `suggest_roles` — this extends the same
"AI proposes, manager approves, nothing auto-applies" pattern to how people are
placed.

## What exists today

| Piece | Where | Gap against the model |
|---|---|---|
| `config.json` holds `workstreams[]`, `activeWorkstream`, `roles[]` (each role bound to one workstream) | `src/storage.js`, `docs/workstreams.md` | No layer above workstreams. |
| A workstream is a standalone Why/What/How tree in `workstreams/<id>.json` | `docs/workstreams.md` | Workstreams **partition** — `workstream split` *moves* Why nodes out of `main` into the new workstream. Nothing is inherited. |
| `main` is the default workstream created at `init` with `whys: []` | `cli/commands/init.core.js` | `main` silently doubles as "the project context" but has no distinct status. |
| `serializeToMd` / `generateRoleFile` / `compileTaskPrompt` all take a single `workstream` | `src/context.js` | Every compile path sees one tree; none merges an inherited project tree. |
| Founding contribution — `contribute apply:true` when `get_status` shows `totalWhys: 0` | `docs/proposals/founding-contribution.md`, #72 | Guidance at project founding only. Nothing checks non-emptiness at `member_add`. |
| Members are project-wide | `cli/commands/member.core.js` (see its header comment) | #77 reverses this for the hosted path (workstream-scoped, server-enforced for lent-credential members). The brief and the gate below build on #77. |
| `list_tasks` with `mine: true` — "what should I work on" | `mcp/server.js:172`, `cli/commands/task.core.js:140` | Returns a task list only. No compiled context, no "read this first" framing. |
| `suggest_workstream_splits`, `suggest_roles` | MCP surface | Propose workstreams and roles separately; nothing proposes how people are *placed* into workstreams. |

## The five pieces

### 1. Project context as a first-class layer that workstreams inherit — #80

**The foundation. Everything else depends on it.**

- Introduce a project-level Why/What/How tree distinct from any single
  workstream — stored once (e.g. `.teamctx/project.json`), governed through the
  same contribution → approval pipeline as workstream context.
- Every compile path — `serializeToMd`, `generateRoleFile`, `compileTaskPrompt`,
  `answerQuestion`, the web `/context/<role>` page — produces, for a given
  workstream: **the inherited project tree (rendered read-only, clearly marked
  as project-level) followed by that workstream's own branch.**
- `contribute` / `ask` / `reflect` gain a project-level target (alongside the
  existing `--workstream <id>`), so the manager can add to project context
  without it landing in a workstream.
- **`main` disappears.** The project tree *is* the base — there is no longer a
  default `main` workstream doing double duty. A project has a project tree and
  zero or more named workstreams; `activeWorkstream` may be unset (meaning
  "operating at project level").
- **Migration** (idempotent, same pattern as the existing workstreams
  migration): today's `main` workstream content becomes the project tree, and
  `main` is removed from `workstreams[]`. Existing split workstreams keep their
  own nodes and now additionally inherit the project tree. Roles currently bound
  to `main` rebind to project level. A project with only `main` ends up with a
  project tree and no separate workstreams — unchanged in its compiled output.
  Any `--workstream main` / `activeWorkstream: main` reference resolves to
  project level after migration.
- **Inheritance is a filter at compile time, not a copy.** A workstream's stored
  JSON never contains project nodes; the compiler concatenates. Editing project
  context regenerates every workstream's compiled files.

### 2. AI proposes the workstream + membership structure to the manager — #81

- Given the project Why/What/How tree, the AI proposes: which Whys become
  workstreams, and — per workstream — a membership model (assigned-tasks /
  named-role / workstream-position) with a one-line rationale.
- Manager accepts / renames / skips per proposal, exactly like
  `workstream split` today. Nothing auto-applies.
- Extends `suggest_workstream_splits` and `suggest_roles` rather than adding a
  third suggest surface — ideally one "propose how this project is structured"
  call that returns both.
- Cross-references #66 (single-page onboarding) — this is the substance behind
  its "AI-driven workstream + task creation" step.

### 3. Non-empty context gate on member assignment — #82

- `member_add` (and any later "assign member to workstream X" path) is refused
  unless **project context is non-empty AND the target workstream's own context
  is non-empty**.
- `totalWhys` already exists for the project-level half; the workstream half is
  a per-workstream Why count.
- The error names the fix in plain language: *"This workstream has no context
  yet. Add what this workstream is about before bringing someone onto it —
  tell me and I'll do it."* — no teamctx vocabulary, per `mcp/instructions.js`
  guidance.
- Enforced on the hosted path (the #77 server boundary) and in the CLI
  `member` command. Advisory-only for clone-holders, stated plainly — same
  honesty line as #77.
- A member assigned to no workstream (project-wide, the current default) is
  gated on project context only.

### 4. Member "step 1" brief — role + compiled context, before work starts — #83

- One read-only pull — extend `list_tasks --mine` into a `my_brief` view (MCP +
  CLI) — that returns, for the calling member:
  - **Their role**: the tasks assigned to them (with status), grouped by
    workstream. If the manager chose a named-role model, the role name too.
  - **Their compiled context**: project tree + their workstream branch — the
    same merged view from #78, not a raw dump of everything.
  - A one-line "you're on workstream X; read this, then pick up a task" frame.
- This is what a member's AI tool is told to read first, before `contribute`
  or `task_done` — added to the member sequence in `mcp/instructions.js`.
- No new data; it composes #78's compile output with the existing task query.

### 5. Docs — record the Team layer as a deferred seam — #84

- ROADMAP + a short `docs/proposals/` note: the intended hierarchy is
  team → project → workstream; MVP collapses team into project (one team = one
  project); here is where the team layer slots in later (a shared project-of-
  projects context, or the existing "cross-project context links" Later item).
- Fix the stale ROADMAP wording that lists "nested workstreams" as shipped —
  `docs/workstreams.md` correctly says workstreams are peers and nesting is not
  supported.

## Dependency order

```
#80  (foundation — project context layer + inheritance in every compile path)
  ├── #81  (AI proposes structure — needs a project tree to propose from)
  ├── #82  (context gate — needs a project-level context to check for)
  └── #83  (member brief — needs the merged compile output)
#84  (docs — independent, can land any time)
```

`#81`, `#82`, `#83` are independent of each other and each a good standalone PR
once `#80` lands. `#77` (workstream-scoped membership) is a sibling of `#82`/`#83`
— they assume its server boundary but do not block on it for the CLI path.

## Out of scope (MVP)

- **The Team layer as a built entity.** One team = one project. #82 records the
  seam only.
- **Company / functional context above the team.** Not modelled at all.
- **Chats / agent runs as tracked objects.** A task is the smallest tracked
  unit. Members feed decisions back through `contribute` as today.
- **RBAC, permission matrices, org hierarchy.** Still non-goals (ROADMAP). The
  membership model in #79 is one fact per member — which workstream(s), and how
  their role is expressed — not a permission system.
- **Cross-workstream contributions.** Unchanged — one workstream (or the
  project) at a time.

## Verification (per issue, for the implementer)

- **#80:** migration test (existing `main`-only project and an already-split
  project both compile to equivalent-or-clearer output); a role file and a task
  prompt each show project context then workstream branch; editing project
  context regenerates all workstream files.
- **#81:** given a seeded project tree, the proposal returns workstreams +
  per-workstream membership model with rationale; nothing is written until the
  manager accepts.
- **#82:** `member_add` refused with the plain-language error when project or
  target-workstream context is empty; allowed once both are non-empty;
  project-wide member gated on project context only.
- **#83:** `my_brief` returns assigned tasks grouped by workstream + the merged
  compiled context; a member on no workstream gets project context + any
  project-wide tasks.
- **#84:** docs only — ROADMAP and the new proposal note read consistently with
  `docs/workstreams.md`.
