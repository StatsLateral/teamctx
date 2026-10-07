# Context lives in the assistant: records leave the page, a drawer shows the prompt

**Date:** 2026-10-07
**Status:** Design confirmed in the demo conversation (UI fix 4 of a series); spec pending review
**Builds on:** [context model and numbering](2026-10-07-context-model-and-numbering-design.md), [goal text](2026-10-07-project-goal-text-design.md) (fix 1), [settings block](2026-10-07-project-settings-block-design.md) (fix 2), [Waiting on you icons](2026-10-07-waiting-on-you-icons-design.md) (fix 3)
**Prototype:** the internal prototype (synthetic data)
**Scope:** MVP decision. Revisit when the audit views exist (see the context-model spec).

## Problem

The project page listed every decision, rule, assumption and exception, first a
"Rules, decisions & assumptions for the whole project" section, then the records of
each workstream, mixed in with its tasks. At a team's real scale (hundreds, then
thousands of records) that is a wall of text nobody reads on a page, and reading it is
not how the context is used: the people and agents that need it get it through their
assistant. The page also made context look like something to browse and edit, when
the product's rule is that context changes only through review.

## Decision (MVP)

Project-level and workstream-level context is **not listed on the page**. It is read
through the person's assistant. A person can still see it, in plain English, in the
**right-hand drawer**: the project drawer under the project summary, and a workstream
drawer from the icon next to the workstream's name. Each drawer also carries the same
deep links to Claude, ChatGPT and Copilot, and a prompt copy button, as a task drawer.
Tasks, the review queue, the goal and the work tree stay on the page.

## Goals

1. Remove the records from the page (the project section and each workstream's records).
2. Give every level a one-click way to read its context in plain English and take it to an assistant.
3. Keep the page about the work (tasks, what is waiting) and the context in the tool people
   use to do the work.

## Non-goals

- Editing context on the page. Changes go through review, as before.
- Hiding what the assistant gets. The drawer shows the context in full and lets the person see the exact prompt before it is sent.
- A browsable context list or search on the page. That is the later change-log and
  audit work.
- Changing what any person or agent is allowed to see. The prompt is built with the
  same scope rules as everything else.

## Design

### 1. What leaves the page

- The "Rules, decisions & assumptions for the whole project" section.
- The records (decisions, rules, assumptions, exceptions) in every workstream
  section. Each section now lists **tasks only**, under the workstream's number and name.
- The "Governed by N rules, decisions and assumptions from above. Show them" line.
- The "Ask AI what a change would affect" link that lived in the project section. Impact
  is surfaced through the review queue and, later, the change log
  ([context model, section 3](2026-10-07-context-model-and-numbering-design.md)).
- Record numbers and record chips everywhere (see the numbering section of the
  context-model spec). Prose that used to cite a record by key now quotes it by its
  first words, and tasks are cited by their number.
- "Show history" now counts completed tasks only; replaced and expired records are a
  later audit feature.

### 2. What the page shows instead

No extra row or banner. Two small entry points, both already on the page:

- **Project:** the panel icon at the end of the goal text (fix 1) opens the project
  drawer.
- **Workstream:** a small context icon next to each workstream's name in its section
  heading opens that workstream's drawer.
- A task's drawer replaces the list of governing records with one sentence and a link
  ("Your assistant reads the approved context for this task ... See the context") that opens
  its workstream's drawer.

### 3. The context drawers

One drawer layout, used for the project and for each workstream.

**Project drawer** (header "Project · Summary and context"):

1. **Project summary:** the goal as the heading and the why beneath it, in full (the page
   shows at most three lines of it; see fix 1).
2. **Project context, in plain English:** the project-level records as short readable
   statements, grouped under plain headings: *We decided*, *Rules*, *We're assuming*,
   *Allowed exceptions*. Wording only: no numbers, ids or prompt syntax.
3. **Ask about it in your assistant:** the same block a task drawer has (below).

**Workstream drawer** (header "Workstream N"): the workstream's name, then *Context for
this part of the work* in the same plain-English groups (that workstream's own records),
a line "The project context also applies.", then the same assistant block.

**The assistant block** is the one already built for tasks, reused unchanged in behaviour:
- A switch between *Assistant is connected to teamctx* (default) and *Paste the context in*.
- **Open in Claude**, **Open in ChatGPT** (deep links that open the chatbot with the prompt
  filled in), **Copy, then open Copilot** (Copilot cannot be prefilled by link, so it copies
  first) and **Copy full prompt** (works in any chatbot).
- In connected mode the deep link carries a short prompt ("Tell me about workstream 2 ...
  use the teamctx connector to fetch its current approved context and answer from it. Keep
  to this workstream"), and the assistant fetches the context itself within the person's
  access. In paste mode the whole approved context for that level is copied into the prompt:
  goal, why, the records of every level on the path, and an index of the other workstreams
  that were not loaded.
- "See the prompt first" shows the exact text before it is sent.

Scope: a reader only sees, and their assistant only gets, records they may see; workstreams
they cannot see are left out of the index. The drawer shows what **that person's** assistant
would receive.

### 4. Why this is right for the next 6 to 12 months

- Most work happens in an assistant. The page showing the same text the assistant receives
  keeps one source of truth and removes a duplicate that would drift.
- A person who wants to know "what is my assistant working from?" gets the exact prompt,
  not a summary of it.
- It scales: the page does not grow with the number of records, only with the work.
- It makes the next step, the audit and change-log views, the place to browse and
  trace context, instead of a flat list.

### 5. Cost and mitigations

- **Context is invisible on the page.** A manager who wants to scan all decisions has no
  page for it in the MVP. Mitigation: the context drawer shows the full prompt per
  level; the assistant answers "what have we decided about X?"; the audit views (later)
  give a browsable list with history.
- **Governance and auditability are the product.** Hiding records on the page must not
  reduce them. They are unchanged in storage: approval, review, impact flags and the change
  history all still apply; only the on-page list is removed.

## Existing open source first

Nothing to borrow. The change removes markup and adds one drawer view that prints text the
server already compiles for task prompts (`src/brief.js`, `compileTaskPrompt`). Rendering the
prompt as Markdown or highlighting it (marked, highlight.js) would add a dependency to show
plain text and is rejected on purpose.

## Changes

- `src/views/project.js`: remove the whole-project records section, the records in each
  workstream section and the inherited-context line; show tasks only; add the context icon
  next to each workstream name; replace the governing-records list in the task drawer with
  the sentence and link.
- One drawer view for the project and each workstream: the plain-English context plus the
  existing assistant block (deep links and copy). The server compiles the prompt for a
  workstream or the project (reuse the brief/compile code with the same scope filter); the
  page script only displays it and opens the deep links.
- No change to storage, review, the connector or scope enforcement.

## Testing

- View test: the project page contains no record rows, no "for the whole project" section, no
  "Governed by" line, for managers and for scoped members.
- View test: each workstream section lists tasks only; "Show history" counts done tasks only.
- View test: the project icon and each workstream's context icon exist with accessible names, and open the
  drawer.
- Drawer test: the project drawer shows the summary, then the project context grouped in plain
  English, then the assistant block with its four actions; a workstream drawer shows only that
  workstream's own records plus the "project context also applies" line.
- Prompt test: the project prompt has goal, why, project records and the index; a workstream
  prompt has the records of every level on its path in order and no record from a sibling;
  an exception line names the rule it bends in words; no record or review-item key appears.
- Scope test: a scoped member's prompt omits records and workstreams they cannot see.
- Regression: the task drawer still shows its assistant block; copy puts the full text on
  the clipboard.
- Crawl check (as in the demo): visiting every page and drawer for both roles shows no
  old-style key (`T-`, `D-`, `R-`, `A-`, `X-`, `Q-`).

## Open questions

1. Does a manager need a read-only list of project-level context on the page before the
   audit views exist? The demo says no for the MVP; revisit after the first real teams use it.
2. Should the plain-English context also show review-by and expiry dates? The demo leaves them out to keep the drawer simple.
