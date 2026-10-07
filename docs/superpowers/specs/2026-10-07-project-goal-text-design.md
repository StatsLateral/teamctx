# Project goal and why it matters: two lines of plain text at the top of the page

**Date:** 2026-10-07
**Status:** Design approved in conversation (mockup live in the prototype); spec pending review
**Builds on:** the governed-records model (#117), the agent-first project view spec (#125)
**Scope:** one UI fix. First of a series, taken one at a time.

## Problem

The top of the project page does not say what the project is for. A person (or
an agent reading the page) has to infer it from the first decision or task. The
goal exists in the data (`goal.text`, and `goal.why`, set by the `setGoal`
operation and already printed in the member brief as "Why it matters") but the
page does not show it as the page's opening statement, and nothing says it is
the fixed anchor the rest of the project hangs from.

Most projects will be started by talking to an assistant or handing it
documents, not by filling in a form. The goal has to come out of that
conversation, and it then drives what gets created next (workstreams, tasks).

## Goal

The page opens with the project's goal and why it matters, as plain text
limited to three lines, readable in two seconds. Anyone who wants the full text
gets it from their assistant or a right-hand drawer.

## Non-goals

- Editing on the page. The goal changes through the assistant and review, as
  every other record does. No button, no inline edit.
- Labels, cards, badges, provenance lines or text buttons around the text.
  Tried and removed in the demo: they added weight without helping the reader.
  The one control is a small icon that opens the drawer (section 2).
- A length limit on the stored text. Nothing rejects, trims or warns about a
  long goal or why. Only the display is limited.
- Suggesting workstreams and tasks from the goal. That is the next fix.
- Any AI call from the page.
- Changing who can see the page or the goal.

## Design

### 1. What is shown

Directly under the title and team line, in this order:

1. **The goal**: larger serif type, full ink colour.
2. **Why it matters**: the sub-heading, body size, soft grey.

No labels. The size and colour difference says which is which; a label would
only repeat it. The text spans the full width of the content area, the same
width as the work tree plus the main column below, so it lines up with
everything under it and wraps as little as possible.

**Three lines in total, sub-heading included.** The goal takes up to two lines
and the why gets whatever is left (at least one), each ending in an ellipsis
when cut. A one-line goal leaves two lines for the why. The count is measured
after fonts load and on resize, so it holds at phone width too. This is a
display rule only; the stored text is never shortened.

**Reading the rest, two ways:**
- **Ask the assistant:** "Tell me about this project". It answers from the same
  approved goal and why (and the rest of the context the person may see).
- **Panel icon** at the right end of the block (aria-label "Read the full goal
  and why it matters"). It opens the right-hand project drawer, the same drawer used for
  tasks, showing the complete goal and why, then the project context in plain English and
  the assistant block (see [context in the assistant](2026-10-07-context-in-the-assistant-design.md)). The icon is always shown, so it is predictable, and the
  drawer shows the same text when nothing was cut.

Mockup (from the prototype):

```
Northwind GTM & Sales  [MANAGER]
northwind/gtm · 1 team member · 6 agents · 1 external talent · 8 connected sources

Open and advance conversations with the right people at four health systems by publishing   [▯]
on topics they already talk about.
Health-system buyers rarely answer cold outreach. Showing up on the topics their lab and supply-ch…

THE WORK                    ┌ Waiting on you · 5 ...
```

### 2. Where the text comes from

- It is the project's existing goal record: `goal.text` (the goal) and
  `goal.why` (why it matters). No new fields, no migration.
- It is set once, when the project starts, by the founding contribution's
  `setGoal` operation. In practice the assistant drafts it from the kickoff
  chat or the documents the person provides, and the manager confirms it
  through the normal review step.
- It is static: nothing on the page changes it, and nothing regenerates it
  silently. A later change is a new `setGoal` proposal that goes through review
  like any other change, so the history stays honest and agents never see the
  anchor move without a manager approving it.

### 3. Shape of the text (what the assistant is asked to write)

The prompt that drafts the goal at initiation asks for the shape below. These
are instructions to the assistant, not limits enforced in code.

- **Goal:** an outcome, not an activity. It names who or what changes, not how.
  Short enough to read at a glance, and one sentence by preference.
- **Why it matters:** the reason, the buyer or user need, or the cost of not
  doing it. No restating the goal.
- Plain words. No headings, bullets, hedging or marketing language.
- Nothing the person did not say or the documents do not support. If the input
  does not give a reason, the assistant leaves "why" out and asks, rather than
  inventing one.

A fixed shape matters because AI summaries drift into filler when the shape is
open. Two lines in a fixed order are also easy for any other assistant to read
and reuse.

### 4. Who sees it

Everyone who can open the project page sees both lines. Scope rules do not
apply to the goal: it belongs to the project, not to a workstream, and a scoped
member needs it most to understand why their part exists. `setGoal` already
rejects workstream-level goals.

### 5. Empty and edge states

| Case | Shown |
|------|-------|
| No goal yet (project not initiated) | Nothing in this space. The existing empty-project guidance stays. |
| Goal but no why | The goal line only. No placeholder text. |
| Very long text | Display clamps to three lines (goal up to two, why the rest). Full text in the drawer and in the assistant. Never truncated in storage. |
| Goal alone fills three lines | Goal shows two lines, the why shows one line. |
| Narrow screen | Full width of the column; the same three-line rule applies. |
| Dark mode | Same two colour tokens as the rest of the page (`--ink`, `--soft`). |

### 6. Why this is the right shape for the next 6 to 12 months

- **Agents read it first.** The same two lines are the first thing in every
  member brief and compiled task prompt, so an assistant picking up one task
  still knows what the whole project is for. The page shows exactly what agents
  are given, so a person can check it.
- **Change only through review.** If agents anchor on the goal, a silent
  rewrite is the worst failure. Keeping it out of the page's edit surface and
  inside the review queue is the safeguard.
- **Starts in chat.** Nobody types a goal into a form. The page only displays
  what the initiation conversation produced and a manager confirmed.
- **Less on the page.** Provenance, buttons and labels were all tried and cut.
  The history of who drafted and confirmed the goal is still recorded in the
  record's source and review trail; it just is not on the page.

## Existing open source first

Nothing new to build here beyond one template change. The text is two escaped
strings in the existing server-rendered view (`src/views/project.js`), using the
existing theme tokens. No UI framework, component library or markdown renderer
is needed, and the text is plain, so none should be added. Checked: rendering
the text as Markdown (marked, markdown-it) would invite headings, links and
bullets into a field that is deliberately two plain lines, so it is rejected on
purpose. Only teamctx's own part is built: the review-gated `setGoal` and the
brief that already carries the same text.

## Changes

- `src/views/project.js`: render `goal.text` and `goal.why` under the team line,
  both HTML-escaped, as two elements with the styles above, clamped to three
  lines in total; add the drawer icon and a drawer view for the full text
  (client-side clamp that measures lines after fonts load and on resize). Remove the goal
  from the "work" list as a row if it duplicates the new header text
  (currently `rows.unshift({ ... tier: 'goal' ... })`).
- `src/views/theme.js` (or the project view's CSS): `.goal-text` and
  `.goal-why` styles using `--font-display`, `--ink`, `--soft`.
- Initiation prompt (`src/ai.js` founding contribution): enforce the shape in
  section 3 and the "do not invent a why" rule.
- No change to `setGoal`, the record model, scope enforcement or the brief.

## Testing

- View test: a project with goal + why renders both strings, escaped; with only
  a goal renders one; with no goal renders neither.
- View test: HTML in `goal.text` or `goal.why` is escaped, not rendered.
- View test: the goal appears once on the page (not also as a list row).
- Founding-contribution test (stubbed model): missing reason yields no `why`;
  a long goal or why is stored in full.
- Clamp test (browser or DOM test): the visible lines never exceed three; a
  goal of one, two and three-plus lines leaves the why two, one and one lines.
- Drawer test: the icon opens the drawer with the complete, escaped text.
- Visual check against the demo at desktop and phone width, light and dark.

## Open questions

- Should a manager see a small "goal changed" notice in the review queue when a
  `setGoal` proposal arrives? It would be a normal queued item; its wording is
  for the review-screen work (#118, currently parked).
- Should the drawer also show the goal's history (earlier approved wording)?
  Not needed for this fix; the record trail already keeps it.

## Out of scope, next in the series

1. Suggesting workstreams and tasks from the goal after initiation.
2. The initiation flow itself (chat or documents in, goal draft out).
3. Review wording for goal changes.
