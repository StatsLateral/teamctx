# Agent-first project view: project tree, task IDs, governance drawer, "work on this in your assistant"

**Date:** 2026-10-04
**Status:** Design approved in conversation; spec pending review
**Builds on:** #101 (read-only project page), #103 / #115 (context view), the governed-records model (#117), agent tokens

## Problem

Most of the work on a project will be done by agents running unattended, and
most of what people do will be done by talking to an assistant. The page was
built for neither. Found by walking it as a manager, a scoped member and an
agent (synthetic Northwind project, 2026-10-04):

1. **The project is not the root.** Workstreams are a flat list of cards, so
   Launch, Outreach and Pricing look like siblings. There is no "Overall
   Project" node that rolls the rest up.
2. **Tasks are second-class.** Only statements open the drawer; a task is not
   clickable. Tasks appear twice (a column and a table) and the table's
   "Where" shows a name at project level but a raw id (`launch`) elsewhere.
3. **No task ID.** Tasks have a random id (`task-1a2b3c4d`) that is never
   shown. The number on screen is positional and shifts when a task is added
   above it.
4. **The drawer hides the governance fields.** Owner, review-by (and whether it
   is overdue), expiry, what a record rests on or bends, who approved it and
   when are all in the data and none are shown. An overdue assumption looks
   identical to a healthy one.
5. **Agents are not obvious.** An agent appears only as a task owner and as the
   author of a queued item, styled like a person. It is not on the member
   chips at all.
6. **Member chips ignore nesting.** A member scoped to Launch reaches Outreach
   and Pricing but is shown only on Launch.
7. **Working on a task is a clipboard step.** "Copy a prompt" is the only way
   from the page to an assistant.

## Goals

1. The page is a tree: **Overall Project** at the root, workstreams drawn as its
   children, to any depth, with counts and attention chips rolled up.
2. Every task has a **stable, short, visible ID**; every record does too.
3. Records and tasks use **one row anatomy** everywhere, so the page is
   consistent top to bottom.
4. A task opens a **drawer** with its governing context and the governance
   fields of every record that applies to it.
5. Agents and people are **visibly different** wherever either appears.
6. From a task, one action takes a person into **their assistant** with the
   work and its current approved context. It works for Microsoft Copilot,
   Claude and ChatGPT, and the copied prompt works for any assistant.

## Non-goals

- Editing on the page. Approving, assigning and writing stay in chat.
- Any AI call from the page.
- Changing who can see what. Scope enforcement is unchanged.
- Re-theming the page.

## Design

### 1. Overall Project is the root

```
OVERALL PROJECT · Northwind Onboarding Revamp          [MANAGER]
Goal: Cut time-to-first-value from 14 days to 7 by end of Q4 2026
 4 decisions · 2 rules · 3 assumptions (1 overdue) · 7 open tasks · 2 awaiting review
 │
 ├─ 1  Launch                      3 tasks
 │   ├─ 1.1  Outreach              2 tasks
 │   └─ 1.2  Pricing               3 tasks
 └─ 2  Support                     3 tasks
```

- Overall Project is the default selection. Selecting it shows the whole
  subtree; selecting a workstream shows that workstream and everything below it.
- Children are indented with connector lines. The numbering that exists today
  (`1`, `1.1`) stays as the display label, never as a link target.
- Chips roll up: overdue assumptions, expired exceptions, pending reviews.
- The people on a node include everyone whose scope reaches it, descendants
  included, so a member on Launch shows on Outreach and Pricing.

### 2. Stable IDs

- Every task gets a per-project sequential key, `T-14`, minted at creation and
  never reused. Records get typed keys: `D-3` decision, `R-1` rule, `A-2`
  assumption, `X-1` exception.
- Stored, not derived, so a key never shifts. The existing random `id` stays the
  internal identity; the key is the human handle.
- Shown on the row, in the drawer, in the review queue, in links and in
  prompts. Links keep taking the stable internal id (see `src/view-url.js`);
  the key is accepted as an alias and resolved server-side.
- Data change: a counter per kind in `config.json` (`nextKey: { T, D, R, A, X }`),
  and a backfill for existing projects that assigns keys in creation order.

### 3. One row anatomy

```
KEY   TYPE LABEL        TEXT                                  OWNER              STATUS / GOVERNANCE        SRC
T-14  Task              Draft the launch checklist            👤 Dev Patel       open                       ●
R-2   Rule:             No discount above 15% …               —                  active                     ●
X-1   Allowed:          Design-partner 30% off  ↳ bends R-2   —                  expires 2026-12-31         ●
A-2   We're assuming:   Admins configure SSO themselves       👤 Maya Chen       ⚠ review overdue 09-30     ●
T-9   Task              Post the nightly summary              🤖 Nightly report  open · unattended          ●
```

- One component renders records and tasks in the project view, the inherited
  block, the list view and the review queue.
- One task list, not two. It is filterable by workstream and by owner, and the
  "where" is always the breadcrumb of names (`Launch › Pricing`), never an id.
- Governance state is on the row: overdue review and expired exception carry a
  warning chip. Replaced, broken and closed records sit behind a "show history"
  toggle so they are reachable.

### 4. Agents are obvious

- Every person and agent chip carries a kind marker and a colour:
  `👤 Dev Patel`, `🤖 Agent · Nightly signup report`. Agents appear on
  workstream chips, as task owners, and as authors of queued items.
- A task owned by an agent says "runs unattended". A task owned by a person says
  "work on it with your assistant" and carries the action in section 6.
- An agent's display name is what the manager typed. The marker is added by the
  page, not by asking managers to rename their agents.

### 5. The drawer

**Task drawer**
- Key, title, status, owner with kind marker, breadcrumb.
- **Governing context**: the inherited chain, project then each workstream down
  to this one. Each record shows type, status, owner, review-by or expiry, what
  it rests on or bends or replaces, who approved it and when, and its source.
- Actions: **Work on this in your assistant** (section 6) and **Copy full
  prompt**.

**Record drawer** gains the same governance block: owner, review-by with an
overdue flag, expiry, links, approved by and when, source contributions.

### 6. Work on this in your assistant

The copied prompt is the universal path: it works in any assistant, including
ones not named here. The deeplinks below are a convenience on top of it.

Two kinds of prompt:

- **Short prompt (deeplinks):** the task key, one line of instruction, and the
  link back to the task. The assistant fetches the current approved context
  itself through the teamctx connector (`my_brief`, `task_compile`). No context
  travels in the URL, so it is never logged or truncated, it is always the
  latest approved version, and it respects the person's scope.
- **Full prompt (copy):** the compiled, approved context chain for the task,
  inlined, for assistants with no connector. Today's prompt, extended with the
  task key and the governance fields.

Per assistant, as verified on 2026-10-04:

| Assistant | Action | Behaviour |
|---|---|---|
| Claude | "Open in Claude" → `https://claude.ai/new?q=<short prompt>` | Prefills the input; the person reviews and sends. Text is capped at about 14,000 characters, which the short prompt is far below. |
| ChatGPT | "Open in ChatGPT" → `https://chatgpt.com/?q=<short prompt>` | Prefills, and may auto-submit. Researchers have shown the `?q=` parameter being abused for prompt injection, so the link carries only our own short prompt and never page or user content. |
| Microsoft Copilot | "Copy prompt, then open Copilot" | `copilot.microsoft.com/?q=` no longer populates the chat box (Microsoft Q&A, regression reported late 2025), and Microsoft 365 Copilot's prefill is not documented. So no prefill is promised: copy the prompt, open Copilot, paste. Re-test before launch and upgrade to a deeplink if it works. |

The page shows Claude, ChatGPT and Copilot as three buttons beside "Copy full
prompt". Copilot's button copies first and then opens, so the person never lands
in an empty box without the prompt on their clipboard.

Every prompt carries the task key, so what comes back through `contribute` and
`task_done` ties to the task.

### Existing open source first

- The prefill URL formats above are the assistants' own; nothing is hand-rolled
  beyond building a query string with `encodeURIComponent`.
- Tree rendering with connector lines is plain nested lists and CSS. No library.
- The key counter and backfill are small and specific to this data model; no
  existing library fits.

## Data

- `config.json`: `nextKey` counters.
- Tasks and records: a `key` field (`T-14`, `R-2`). Backfilled on first write
  for existing projects.
- Nothing else changes. Every governance field the drawer needs is already
  stored: `owner`, `reviewBy`, `expiresAt`, `links`, `approvedBy`, `createdAt`,
  `updatedAt`, `sourceContributionIds`.

## Build order

1. Keys: counter, mint on create, backfill, alias resolution in links.
2. Shared row component and the single task list; fix the "where" label.
3. Project tree: Overall Project root, nested children, rolled-up chips, member
   chips that follow nesting.
4. Agent markers everywhere an actor is shown.
5. Task and record drawers with the governance block.
6. Assistant actions: short prompt, full prompt, three buttons.

## Risks

- **Backfill ordering.** Keys assigned from creation order must be stable if two
  people backfill at once; do it as one commit at read-time-on-write, and make
  it idempotent.
- **Short prompt depends on the connector.** A person whose assistant is not
  connected gets a link that cannot fetch context. The drawer says so and
  offers the full prompt first when the connector is not known to be set up.
- **Auto-submit on ChatGPT.** Mitigated by the prompt containing only our text.
  Revisit if OpenAI changes the behaviour.
- **Copilot is the weak link.** Treated as copy-first on purpose.

## Sources

- Claude prefill and length cap: Anthropic support, "Open Claude Desktop with a link".
- ChatGPT `?q=` and the injection advisory: Tenable TRA-2025-22.
- Copilot `?q=` regression: Microsoft Q&A, "Copilot Web App: ?q= parameter no longer populates chat input".
