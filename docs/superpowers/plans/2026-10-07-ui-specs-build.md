# Build the 2026-10-07 UI specs: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the real project page (`src/views/project.js`) in line with the eight 2026-10-07 UI specs, in seven small, independently shippable pieces.

**Architecture:** The page is one server-rendered template (`projectPage` in `src/views/project.js`, called from `api/oauth-server.js`, data from `readProjectView` in `src/oauth/project-view.js`) with one shared drawer and one inline script. Every piece below changes that template and the data it is handed. There is no new framework, no client-side app, and no new dependency except where a task names one.

**Tech Stack:** Node ESM, Express, vitest (`npm test`), plain HTML/CSS/JS strings.

**Specs (read the one for your task before starting):** `docs/superpowers/specs/2026-10-07-*.md` (goal text, settings block, waiting-on-you icons, context model and numbering, context in the assistant, task history, task submissions and next steps, assistant icons).

## Where the real page differs from the demo

The specs were written against the demo. Checked against `main` on 2026-10-07:

| Spec assumes | Real page today |
|---|---|
| Goal header, two lines | Goal is a row in the Context tab (`numbering()`, `tier: 'goal'`). Slug line `owner/repo` under the title. |
| Review button to replace with icons | No Review button. A queued item is a row that opens the shared drawer. The icons are new, not a swap. |
| Assistant block with Claude / ChatGPT / Copilot / Copy | Only one "Copy a prompt for your assistant" button (`#copy`). The deep links are the closed, parked #131 and were never built. |
| Task numbers `3.2` | `numberTasks()` in `src/model.js` derives positions at render time; `src/record-key.js` mints stored `T-14` keys. Covered by #138. |
| Contributions know their task | No `forTask` field. `doneAt` has no actor. Contributions have no `approvedBy`/`approvedAt` (records have an `approvedBy: null`). |

So the assistant block (task 4) and the icons (task 5) are built together, and the goal drawer icon (task 1) is added in task 4.

## Global Constraints

- Display strings, names, and prompts contain no `T-`, `D-`, `R-`, `A-`, `X-` or `Q-` keys once #138 lands. (Specs: numbering 4.5.)
- Records have no visible number. Workstreams are `1, 2, 3`; tasks are `workstream.task` (`3.2`). Never reused.
- Page is read-only in the real product. No approve/reject buttons on the page. (Waiting-on-you spec, section 5.)
- No new runtime dependency unless a task's "Existing open source first" says so. The specs reject: icon libraries, tooltip libraries, clipboard libraries, Markdown renderers, workflow engines.
- Tooltips are the browser `title`. Every control is a real `<button>` or `<a>` with an `aria-label`.
- All user-derived text is HTML-escaped with `esc()` (`src/views/theme.js`). Theme tokens only (`--ink`, `--soft`, `--accent`, `--card`, `--line`), so dark mode works.
- Scope rules are unchanged: a scoped reader never sees, or has their assistant sent, anything outside their scope.
- Nothing is stored in a deployment owned by StatsLateral. Team data stays in the team's own repository. (Data-ownership principle.)
- Public-repo hygiene: no customer, person, or company names in code, tests, fixtures, commit messages or issues. Use synthetic names.

## Review Focus

Failure modes the specs imply but do not spell out. Each is pinned by a test in the task that owns the code.

1. **A goal with HTML or a very long unbroken string** (task 1). Expected: escaped, clamped, never overflows the column.
2. **A repo or owner name with characters that need escaping in the MCP URL** (task 2). Expected: URL-encoded in the copied value, escaped in markup, never an `<input>`.
3. **A scoped member opens a workstream drawer for a part they cannot see** (task 4). Expected: the same "not here, or not yours to see" note the page already uses; no names leak through the index.
4. **Two submissions for one task, or a submission for a task that is already done** (task 7). Expected: the second is flagged "task already done"; approving it records the submission and does not reopen anything.
5. **Old data with no approval or actor fields** (task 6). Expected: "Added" with a date and no invented approval.

## File Structure

| File | Responsibility | Tasks |
|---|---|---|
| `src/views/project.js` | Page template, CSS, drawer script. Grows; split drawers out in task 4. | 1, 2, 3, 4, 5, 6, 7 |
| `src/views/drawers.js` (new) | Task / queue / project / workstream drawer markup and the assistant block. | 4, 5, 6, 7 |
| `src/views/assistant-actions.js` (new) | Pure functions: Claude / ChatGPT deep link, Copilot copy-then-open, prompt text for a level. | 4 |
| `src/views/assistant-icons.js` (new) | Three inline SVG marks and the copy glyph, nothing else. | 4 |
| `src/prompts.js` (new) | Server-side prompt for the project, a workstream, a task: wraps `src/brief.js` with the scope filter. | 4 |
| `src/task-history.js` (new) | `taskHistory(task, contributions, queue)` returns the event list. | 6 |
| `src/ops.js`, `src/review.js` | `approvedBy`/`approvedAt`, `doneBy`, `forTask`, task-submission approval. | 6, 7 |
| `src/ai.js` | Founding-contribution prompt shape, `nextSteps`. | 1, 7 |
| `api/oauth-server.js` | Passes `mcpUrl` into `projectPage`. | 2 |
| `api/project-view.test.js` and new `*.test.js` beside each new file | Tests. | all |

Run tests with `npm test`. For one file: `npx vitest run api/project-view.test.js`.

## Order and dependencies

```
1 goal header ─┐
2 settings    ─┼─ independent, ship first, in either order
#138 numbering + records off the page + no project-level tasks (existing issue)
        │
        ├─ 4 drawers + assistant block + icons ── needs #138 (records leave the page)
        │        └─ 1b goal drawer icon (inside task 4)
        ├─ 5 waiting-on-you icons ── needs 4 (the Decide section lives in the drawer)
        └─ 6 task history ── needs #138 (task numbers) ── 7 task submissions + next steps
```

Ship each task as its own PR. Tasks 1 and 2 are small enough to merge the same day.

---

### Task 1: Goal and why as the page opening

**Spec:** `2026-10-07-project-goal-text-design.md`. **Issue:** new.

**Files:**
- Modify: `src/views/project.js` (remove `rows.unshift({ ... tier: 'goal' ... })` in `numbering`, add the header block after the `<h1>`, add CSS, add the clamp to `SCRIPT`)
- Modify: `src/ai.js` (founding-contribution prompt, near the `setGoal` line ~161)
- Test: `api/project-view.test.js`

**Interfaces:**
- Consumes: `view.projectTree.goal` = `{ text, why? }` (already read by `readProjectView`).
- Produces: markup `<p class="goal-text">` and `<p class="goal-why">` inside `<div class="goal-block" id="goal-block">`. Task 4 adds the drawer icon button inside `.goal-block`.

- [ ] **Step 1: Failing tests** in `api/project-view.test.js`, using the existing fixture helpers in that file:
  - goal + why renders both strings, escaped;
  - goal only renders one element and no placeholder;
  - no goal renders neither;
  - `<script>x</script>` in goal text is escaped;
  - the goal text appears once on the page (not also as a Context row).
- [ ] **Step 2:** `npx vitest run api/project-view.test.js` and see the new tests fail.
- [ ] **Step 3: Implement.** Render under the title, goal first (serif, `--ink`), why second (`--soft`), both through `esc()`. Remove the slug `<p class="muted slug">` only in task 2 (it carries the repo name until the Settings block exists). Remove the goal row from `numbering()`.
- [ ] **Step 4: The clamp.** CSS-only where possible: the goal gets `-webkit-line-clamp: 2` and the why gets the remaining lines. Three lines in total needs a measured clamp: in `SCRIPT`, after `document.fonts.ready` and on `resize`, compute `lineHeight`, set the goal's visible lines to `min(2, goalLines)` and the why's to `3 - goalLinesShown` (at least 1). Stored text is never cut. With JavaScript off the CSS clamp alone applies (goal 2 lines, why 1).
- [ ] **Step 5: DOM test for the clamp** (jsdom is not a dependency today; test the pure function instead). Extract `linesLeft(goalLines)` as a small exported function: `1 -> 2`, `2 -> 1`, `3+ -> 1` for the why; assert the table. Browser check in the final step covers the rest.
- [ ] **Step 6: Founding-contribution prompt.** In `src/ai.js` ask for: goal is one outcome sentence naming who or what changes, why is the reason or cost of not doing it without restating the goal, plain words, and **leave `why` out rather than invent one**. Add a test in `cli/commands/founding-contribution.test.js` with the stubbed model: no reason in the input gives no `why`; a long goal and why are stored in full.
- [ ] **Step 7: Run everything.** `npm test`. Expected: all pass.
- [ ] **Step 8: Visual check** against the demo at desktop and phone width, light and dark (use `/browse`). Commit.

```bash
git add src/views/project.js src/ai.js api/project-view.test.js cli/commands/founding-contribution.test.js
git commit -m "Project page opens with the goal and why it matters"
```

---

### Task 2: Settings block with the MCP URL, pinned

**Spec:** `2026-10-07-project-settings-block-design.md`. **Issue:** new.

**Files:**
- Modify: `src/views/project.js` (remove the slug line, add the Settings section inside `<aside>`, sticky CSS, copy handler)
- Modify: `api/oauth-server.js:1315` (pass `mcpUrl`)
- Create: `src/views/mcp-url.js`
- Test: `src/views/mcp-url.test.js`, `api/project-view.test.js`

**Interfaces:**
- Produces: `mcpUrl({ origin, owner, repo }) -> string` returning `${origin}/api/mcp/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, and `shortMcpUrl({ origin, owner, repo }) -> string` returning `host/…/owner/repo`.
- Consumes: `origin` already passed to `projectPage` (`baseUrlFor(req)`, which is the allowlisted base URL).

- [ ] **Step 1: Failing tests** in `src/views/mcp-url.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { mcpUrl, shortMcpUrl } from './mcp-url.js';

describe('mcp url', () => {
  it('builds the connector address', () => {
    expect(mcpUrl({ origin: 'https://teamctx.vercel.app', owner: 'acme', repo: 'gtm' }))
      .toBe('https://teamctx.vercel.app/api/mcp/acme/gtm');
  });
  it('shortens to host and project', () => {
    expect(shortMcpUrl({ origin: 'https://teamctx.vercel.app', owner: 'acme', repo: 'gtm' }))
      .toBe('teamctx.vercel.app/…/acme/gtm');
  });
  it('encodes unusual characters', () => {
    expect(mcpUrl({ origin: 'https://h.test', owner: 'a b', repo: 'c' })).toBe('https://h.test/api/mcp/a%20b/c');
  });
});
```

- [ ] **Step 2:** Run it, see it fail (module missing).
- [ ] **Step 3:** Implement `src/views/mcp-url.js` (two one-line functions; `shortMcpUrl` uses `new URL(origin).host`).
- [ ] **Step 4: View tests** in `api/project-view.test.js`: the page contains the full URL in a `data-url` attribute and in the tooltip, the short text as visible text, a copy `<button aria-label="Copy the MCP URL">`, and **no** `<input>` or `<textarea>` carrying the URL; the slug line is gone; the repo name still appears somewhere on the page (breadcrumb or the short URL).
- [ ] **Step 5: Implement the block.** Under the lanes in `<aside>`: small-caps heading "Settings", a row with the short text (one line, `text-overflow: ellipsis`, `white-space: nowrap`, `title` = full URL, `aria-label`/description "Add this as a custom connector in Claude, ChatGPT or Copilot") and the copy button. Team, agent, talent and source lines are **not** built here (their data is not on the page yet); add each when its data exists.
- [ ] **Step 6: Copy handler** in `SCRIPT` (about 15 lines): `navigator.clipboard.writeText(url)` when available, else a hidden read-only textarea plus `document.execCommand('copy')`; on success swap the icon to a check for 1600 ms. Always copies `dataset.url`, never the shortened text. The existing `#copy` handler already notes the plain-http case; mirror it.
- [ ] **Step 7: Pinned layout.** `aside` is `position: sticky; top: 0` with `height: calc(100vh - top)`, the lanes scroll inside, Settings stays at the bottom. Recompute the height on scroll, resize and `document.fonts.ready`, minimum 260px. Under 900px: one column, no pinning, no inner scroll. This extends the existing `.layout` grid CSS at the top of `project.js`.
- [ ] **Step 8: Run `npm test`, then layout check** with `/browse`: 30+ workstreams, Settings inside the viewport at scroll 0 and after scrolling at 1440x900 and 1280x720, and flowing after the tree under 900px. Commit.

```bash
git add src/views/mcp-url.js src/views/mcp-url.test.js src/views/project.js api/oauth-server.js api/project-view.test.js
git commit -m "Project page: Settings block with the copyable MCP URL"
```

**Existing open source first:** nothing to add. `navigator.clipboard` is the platform. clipboard.js and copy-to-clipboard were checked and rejected by the spec.

---

### Task 3: Numbering, records off the page, no project-level tasks (existing issue #138)

**Spec:** `2026-10-07-context-model-and-numbering-design.md` sections 4 and 4.6, and `2026-10-07-context-in-the-assistant-design.md` section 1. **Issue:** #138, already filed and open. Do not duplicate it; update its "Not in this issue" line to link the new issues once they exist.

This plan only adds sequencing: do #138 before tasks 4, 6 and 7. #138's own "Done when" list is the acceptance test. Two things #138 does not say and the specs require:

- [ ] The Context tab and the "Project context — inherited" table are removed in #138 (its item 2). Task 4 below gives their replacement, so land #138 and task 4 in the same release, or the page loses its only way to read context.
- [ ] Tests that crawl every page and drawer for both roles and fail on any `T-`, `D-`, `R-`, `A-`, `X-`, `Q-` token (context-in-the-assistant spec, "Crawl check"). Add this once, in `api/project-view.test.js`, as part of #138.

---

### Task 4: Project and workstream drawers, the assistant block, and its icon row

**Specs:** `2026-10-07-context-in-the-assistant-design.md` and `2026-10-07-assistant-icons-design.md` (built together because the real page has no assistant block yet). **Issue:** new. **Needs:** #138.

**Files:**
- Create: `src/views/drawers.js`, `src/views/assistant-actions.js`, `src/views/assistant-icons.js`, `src/prompts.js`
- Modify: `src/views/project.js` (use the new drawers, goal panel icon, workstream context icon, task drawer sentence), `src/brief.js` (export what `prompts.js` needs, no behaviour change)
- Test: `src/prompts.test.js`, `src/views/assistant-actions.test.js`, `api/project-view.test.js`

**Interfaces:**
- Produces in `src/prompts.js`:
  - `connectedPrompt({ level, workstreamNumber, name, origin }) -> string` (short, tells the assistant to use the teamctx connector; no context pasted)
  - `pastePrompt({ project, chain, index, onDay }) -> string` (goal, why, records of every level on the path outermost first, index of other workstreams; built from `renderBrief` plus an index section)
- Produces in `src/views/assistant-actions.js`:
  - `claudeUrl(prompt) -> string`, `chatgptUrl(prompt) -> string` (deep links, prompt URL-encoded)
  - `actionFor(kind, { mode, short, full }) -> { open?: string, copy?: string }` where kind is `claude | chatgpt | copilot | copy`: Copilot and copy return `copy`, and Copilot also returns `open`.
- Consumes: scope-filtered trees from `readProjectView` (`view.projectTree`, `view.trees`). The prompt builders never read anything the view was not sent.

- [ ] **Step 1: Prompt tests** (`src/prompts.test.js`), with a small synthetic project (no real names):
  - project prompt has goal, why, project records and the index of workstreams;
  - a workstream prompt has records of every level on its path in order and **no record from a sibling**;
  - an exception line names the rule it bends in words;
  - no key (`T-`, `D-`...) and no internal id appears;
  - scope: a tree filtered to one workstream yields an index with "1 part you cannot see" and no hidden name.
- [ ] **Step 2:** Run, see them fail. Step 3: implement `src/prompts.js` on top of `renderBrief` (it already takes `chain` and a scoped `project`). Add the index as a new function in this file rather than changing `renderBrief`.
- [ ] **Step 4: Deep-link tests** (`src/views/assistant-actions.test.js`): `claudeUrl('hello world')` starts with `https://claude.ai/new?q=` and the prompt is URL-encoded; `chatgptUrl` likewise (`https://chatgpt.com/?q=`); verify both URL shapes in the product docs or by opening them with `/browse` before hard-coding, because both vendors change them. Paste mode returns `copy` first for every action. Copilot always returns `copy` and then `open`. The note about Copilot (cannot be prefilled) is a string constant the view prints.
- [ ] **Step 5: Drawer markup** in `src/views/drawers.js`. One layout for the project and each workstream: summary (goal as heading, why beneath, in full), then plain-English groups under *We decided*, *Rules*, *We're assuming*, *Allowed exceptions* (an exception always printed with the rule it bends), a line "The project context also applies." on a workstream, then the assistant block. Header "Project · Summary and context" / "Workstream N".
- [ ] **Step 6: Assistant block** with the icon row: caption "Open in", three `<button class="chatico">` for Claude, ChatGPT, Copilot, a divider, then the copy button. Each has `aria-label` and `title` from the spec's table. The connected / paste switch and `<details>` "See the prompt first" stay. The three marks are inlined from simple-icons (Claude, OpenAI) and the LobeHub icon set (Copilot) in `assistant-icons.js`; copy the three SVG paths only, not the packages, and record the licence line in a comment at the top of the file. Before shipping, check each company's brand guidance for logo-as-link use; the fallback is a neutral icon plus the product's name as text for that one assistant.
- [ ] **Step 7: Entry points.** Panel icon button at the end of `.goal-block` (aria-label "Read the full goal and why it matters") opens the project drawer; a small context icon next to each workstream name opens that workstream's drawer; the task drawer's list of governing records becomes one sentence with a link that opens its workstream drawer. Reuse the existing `open(el)` pattern in `SCRIPT`: each trigger carries `data-*` attributes with the already-rendered text, so the page script only displays and opens links.
- [ ] **Step 8: View tests:** no record rows, no "for the whole project" section, no "Governed by" line, for managers and for a scoped member; the project and workstream icons exist with accessible names; the drawer shows summary, then grouped context, then the assistant block with three icon buttons plus copy and **no** text buttons for these actions; a scoped member's drawer omits records and workstreams they cannot see.
- [ ] **Step 9: Behaviour checks** (jsdom is not installed; use `/browse` against a local run): each icon, clicking on its inner SVG too, triggers the same action; Copilot copies then opens; copy puts the full text on the clipboard; Enter and Space work; the row wraps at phone width; light and dark both legible. Commit.

```bash
git add src/prompts.js src/prompts.test.js src/views/drawers.js src/views/assistant-actions.js src/views/assistant-actions.test.js src/views/assistant-icons.js src/views/project.js src/brief.js api/project-view.test.js
git commit -m "Project and workstream drawers with an assistant icon row"
```

**Existing open source first:** the three brand marks come from simple-icons and the LobeHub icon set (copy only the SVGs). No icon library, tooltip library or Markdown renderer. Deep links use each vendor's own URL scheme.

---

### Task 5: Waiting on you: View and Review icons, with a Decide section

**Spec:** `2026-10-07-waiting-on-you-icons-design.md`. **Issue:** new. **Needs:** task 4 (shared drawer layout).

**Files:**
- Modify: `src/views/project.js` (`queueRows`, `itemButton`, drawer script), `src/views/project-row.js` (icon cell CSS)
- Create: `src/views/queue-icons.js` (two inline SVGs: eye, clipboard-check)
- Test: `api/project-view.test.js`

**Interfaces:**
- Produces: in the drawer, an element `id="d-decide"` holding the exact instruction a manager hands to their assistant, for example `teamctx review approve <id>` and a matching chat prompt. Built from `item.id`.
- Consumes: the queue item id the page already puts on each `.proposal` row.

- [ ] **Step 1: Failing view tests:** each queued row renders two icon controls, "View details" and "Review: approve or reject", with `aria-label`s that include the item number once #138 lands (until then, the summary); no text "Review" button; the controls are not nested inside another interactive element (today the row is a `<button class="item">`, so a button inside a button is invalid HTML, see step 3).
- [ ] **Step 2:** Run, see them fail.
- [ ] **Step 3: Structure.** Change the queue row from one `<button>` to a `<div class="item" role="group">` that contains the row's main `<button class="row-main">` (opens the drawer at the top) plus the two icon buttons in a right-aligned group. Keep `projectRow`'s grid so headings still line up (`ROW_CSS` in `project-row.js`). Other rows keep the current markup.
- [ ] **Step 4: Behaviour** in `SCRIPT`: the eye opens the drawer at the top; the Review icon opens it and calls `scrollIntoView({ block: 'center', behavior: 'smooth' })` on `#d-decide`; an icon click calls `stopPropagation` so exactly one drawer opens; focus returns to the icon that opened the drawer when it closes.
- [ ] **Step 5: Decide section.** In the review drawer, replace nothing (no buttons exist today); add the **Decide** heading and the instruction text, with a copy button using the same handler as the prompt copy. An item already decided elsewhere shows its decided state without the instruction.
- [ ] **Step 6: Styles:** `.qicon` 34px square, 1px border, 8px radius, 17px line icons; the Review icon uses the accent outline and fills on hover; focus ring; works in dark mode; icons stay at the right of the row on narrow screens while the text wraps first.
- [ ] **Step 7:** `npm test`, then a `/browse` check at desktop and phone width, light and dark. Commit.

```bash
git add src/views/project.js src/views/project-row.js src/views/queue-icons.js api/project-view.test.js
git commit -m "Waiting on you: view and review icons with a Decide section"
```

**Existing open source first:** nothing. Two inline SVGs and a scroll call; Lucide and Heroicons were checked and rejected by the spec.

**Not in this task:** on-page approve and reject. If wanted later, file it as a `parked` issue with the requirements listed in the spec (section 5).

---

### Task 6: Task history and struck-through done tasks

**Spec:** `2026-10-07-task-history-design.md`. **Issue:** new. **Needs:** #138 for the number display (history works without it, but the "moved from 3.2 to 4.1" line needs the number alias).

**Files:**
- Create: `src/task-history.js`, `src/task-history.test.js`
- Modify: `src/ops.js` (approval fields), `src/review.js` (keep rejected items with approver and reason), `cli/commands/task.core.js` (`doneBy`, reopen event), `src/oauth/project-view.js` (build the events, scope-filtered), `src/views/project.js` and `src/views/drawers.js` (History section, strikethrough)
- Test: `src/ops.test.js`, `src/review.test.js`, `cli/commands/task.test.js`, `api/project-view.test.js`

**Interfaces:**
- Produces: `taskHistory({ task, contributions, queue, canSee }) -> { status: 'approved' | 'approved-waiting' | 'not-approved', events: Event[] }` with

```js
// Event = { at: string, by: string|null, did: 'submitted'|'approved'|'rejected'|'completed'|'reopened'|'added'|'moved',
//           via?: 'assistant'|'agent'|'cli'|'web'|'import', contribution?: string, waiting?: true, from?: string, to?: string }
```

- Consumes: contributions already carry author, `source` and time; the task carries `sourceContributionIds`, `doneAt`.

- [ ] **Step 1: Failing history tests** (`src/task-history.test.js`), each building a plain task and contribution fixture:
  - one submission and one approval: two events, oldest first, status `approved`;
  - approved plus a queued submission: status `approved-waiting`, the queued event has `waiting: true`;
  - queued only: status `not-approved`, no approval event;
  - completed then reopened then completed: all three pairs listed;
  - old task with no approval data: one `added` event, **no** approval invented;
  - `canSee` false for an author: `by` is `null` (shown as "someone"); a pending item the reader cannot see is not listed.
- [ ] **Step 2:** Run, see them fail. Step 3: implement `taskHistory` as a pure function; no I/O.
- [ ] **Step 4: Data fields.** In `src/ops.js` where a contribution is applied, stamp `approvedBy` and `approvedAt` on the contribution at approval (also for a manager's send-with-apply). In `cli/commands/task.core.js`, add `doneBy` next to `doneAt`, and append a `reopened` marker when a done task is reopened. In `src/review.js` `buildRejected` already keeps `rejectedBy`, `rejectedAt`, `reason`: keep rejected items where history can read them (check where the rejected item is written; if it is dropped, keep it in the contributions log). Tests for each in the existing test files.
- [ ] **Step 5: View.** A History section directly under the task details and above the assistant block: the one-line status, then one line per event "date, chip, text". Names use the existing person and agent chips so an agent is visibly an agent. Date as text, exact time in `title`. "Show earlier" only when there are more than about ten events.
- [ ] **Step 6: Strikethrough.** `text-decoration: line-through` on a done task's title in every task list (including "Show history"), in the drawer title, and in a person's task list; key, owner and status stay readable.
- [ ] **Step 7:** `npm test`, a `/browse` check. Commit.

```bash
git add src/task-history.js src/task-history.test.js src/ops.js src/review.js cli/commands/task.core.js src/oauth/project-view.js src/views/project.js src/views/drawers.js
git commit -m "Task drawer: history of who submitted, approved and completed"
```

**Existing open source first:** nothing. An activity-feed or audit library is heavier than one derived list. When `changes.jsonl` exists (audit phase) this becomes that log filtered to the task.

---

### Task 7: Task submissions in the queue, and AI-suggested next steps

**Spec:** `2026-10-07-task-submissions-and-next-steps-design.md`. **Issue:** new. **Needs:** tasks 5 and 6, and #138.

**Files:**
- Modify: `cli/commands/contribute.core.js`, `mcp/server.js` (`forTask`), `src/review.js` (approve a task submission), `src/ai.js` (`nextSteps`), `src/views/project.js` and `src/views/drawers.js` (row and drawer wording, Approved view, "Add as a task")
- Test: `cli/commands/contribute.core.test.js`, `src/review.test.js`, `src/ai.test.js`, `mcp/server.test.js`, `api/project-view.test.js`

**Interfaces:**
- Produces: contribution field `forTask: string` (the task's internal id), optional `submitted: string` (one line); review result field `nextSteps: Array<{ title: string, owner?: string }>`; `applyTaskSubmission(tree, item, { approvedBy, onDay }) -> { tree }` which marks the task done with `doneBy`/`doneAt` and writes **no** record.
- Consumes: task history events from task 6.

- [ ] **Step 1: Failing tests:**
  - contribute with a task number resolves to `forTask` (the id), and an unknown or hidden task is refused;
  - a `forTask` queue row shows the task's own number and exact title plus a "Submitted: ..." line; a non-task proposal keeps its own wording;
  - approving a task submission marks the task done, records submission, approval and completion in the task's history, and adds **no** decision, rule, assumption or exception;
  - rejecting leaves the task open and records the rejection with its reason;
  - two submissions for one task: approving one completes the task; the other stays and is flagged "task already done"; a submission for an already-done task only records the submission.
- [ ] **Step 2:** Run, see them fail.
- [ ] **Step 3:** `forTask` in `contribute.core.js` and the `contribute` tool in `mcp/server.js`. The tool already tells the assistant to tag the task number; make it fill `forTask` from the task being worked on and keep the free-text tag as a fallback for older prompts.
- [ ] **Step 4:** `applyTaskSubmission` in `src/review.js`; `applyQueueItem` routes a `forTask` item through it instead of the record path. Tests from step 1 pass.
- [ ] **Step 5: Wording.** Row: the task's number and title, then a muted "Submitted: <summary>" line. Drawer heading is the task title; "What was submitted"; the decision area's "What approving does": "Accepts this draft for task <n> and marks the task done. Nothing is published or sent by this step. AI then suggests the next tasks, and you decide which to add."
- [ ] **Step 6: `nextSteps`.** In `src/ai.js` add a call after approval that returns `{ title, owner }[]` from the approved submission, the task, and the context that applies; the output is JSON validated against that shape and capped (for example five). **No AI key configured: return `[]` and show "No follow-on tasks suggested." Never invent any.** Tests with the stubbed model: normal, empty, malformed output ignored.
- [ ] **Step 7: Approved view.** The drawer stays open after approval, showing "Approved. <title> is done. Nothing was published or sent by this step." and the suggestions, each with an "Add as a task" button. Adding creates an open task in the same workstream with the next number, with a history line "suggested by AI after <n> was approved" added by the approver, and the button becomes "Added as task <n>". Adding the same suggestion twice is prevented. Nothing is created until clicked.
- [ ] **Step 8:** `npm test`; check the wording test that the same task has the identical title in the open list, the queue row and both drawers. Commit.

```bash
git add cli/commands/contribute.core.js mcp/server.js src/review.js src/ai.js src/views/project.js src/views/drawers.js
git commit -m "Review: a task submission completes its task, AI suggests next steps"
```

**Existing open source first:** nothing. Workflow engines (Camunda, Temporal) model a fixed process, which the spec deliberately avoids.

---

## Self-Review

**Spec coverage.**

| Spec | Task |
|---|---|
| Goal text | 1 (header, prompt shape), drawer icon in 4 |
| Settings block | 2 (MCP URL block now; team/sources lines when their data lands, per the spec's open question) |
| Waiting-on-you icons | 5 |
| Context model and numbering | 3 (#138). Change log, `changes.jsonl`, loading rule 4 and the index (`src/recompile.js`) are **not MVP** in the spec; not planned here. |
| Context in the assistant | 3 (records off the page) and 4 |
| Task history | 6 |
| Task submissions and next steps | 7 |
| Assistant icons | 4 |

**Gap found while writing:** the numbering spec's section 1 loading rule (linked items, and an index of other workstreams in a compiled task prompt) is in "Changes" under `src/recompile.js`. Task 4's `pastePrompt` builds the index for the drawer prompt only. Compiling a task with the same index is a follow-up in `cli/commands/task.core.js` and is **not** in this plan; file it separately if wanted.

**Placeholders:** none intended. Where a step says "check", it names what to check and where (for example the two deep-link URL shapes in task 4 are to be verified before hard-coding).

**Type consistency:** `Event`, `forTask`, `nextSteps`, `mcpUrl`/`shortMcpUrl` and `actionFor` are named once and used with the same names in later tasks. The drawer anchors `#goal-block` (task 1) and `#d-decide` (task 5) are the only cross-task DOM contracts.

**Honest limits of this plan:** the code is spelled out for the small pure pieces (task 2) and described step by step for the rest, because the right code depends on reading `readProjectView` and `ops.js` closely at execution time. There is no jsdom in the repo, so DOM behaviour is checked with `/browse`, not unit tests; adding jsdom or Playwright as a dev dependency would let those checks run in CI and is a separate decision.
