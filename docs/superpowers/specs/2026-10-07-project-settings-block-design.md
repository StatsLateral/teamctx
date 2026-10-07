# Project settings block: team, sources and the MCP URL move to the left column, pinned

**Date:** 2026-10-07
**Status:** Design confirmed in the demo conversation (UI fix 2 of a series); spec pending review
**Builds on:** [project goal text](2026-10-07-project-goal-text-design.md) (fix 1), the agent-first project view spec (#125), the hosted MCP connector (`/api/mcp/<owner>/<repo>`)
**Prototype:** the internal prototype (synthetic data)

## Problem

The line under the project title (`repo · N team members · N agents · N external
talent · N connected sources`) is project plumbing, not the project. It sits
between the title and the goal, so it pushes the first thing a person should
read (the goal) down the page, and it hides the one thing people need to start
working with an assistant: the project's MCP URL. Today the real page shows only
`owner/repo` there, and the MCP URL is found by following the docs or the
agent-token screen.

Assistants and chatbots (Claude, ChatGPT, Copilot, agent SDKs) reach a project
only through its MCP connector. Adding that connector asks for exactly one
value: the URL. Anyone who wants to work on the project in their own AI tool
needs it, so it belongs where a person can copy it in one click.

## Goal

A "Settings" block at the foot of the left column holds the project's plumbing:
the MCP URL with a copy button, the team, the agents, external talent and
connected sources. It stays on screen however long the workstream tree is.

## Non-goals

- Editing the URL or any setting here. The block is read-only. Drawers open
  as they do today.
- Changing what the team and sources drawers show.
- Per-user tokens or sign-in for the connector. The URL is the address, not a
  credential; access is still the OAuth or agent-token step the connector runs.
- Showing the full URL when space is short (see 3). It is never edited or
  inspected visually; it is copied.

## Design

### 1. Where it lives

Left column, under the work tree:

```
THE WORK
  Overall Project            15
  ├ Launch                    4
  ├ Pricing                   3
  └ Support                   2
     ...
────────────────────────────────
SETTINGS
teamctx.vercel.app/…/northwind/gtm  [⧉]
1 team member
6 agents
1 external talent
8 connected sources
```

- Same small-caps heading style as "The work". Items are plain text links,
  one per line, in the page's normal body size and soft colour.
- The old line under the title is removed. The goal text now follows the
  title directly.
- Each count keeps its behaviour: team member, agent and external talent lines
  open the team drawer, "connected sources" opens the sources drawer. Nothing in
  the drawers changes. (Counts and drawers are prototype features; the real page
  adds them as their data lands. The MCP URL and its copy button do not depend
  on them and ship first.)

### 2. Pinned, so it is always visible

- The left column is sticky and sized to the screen. The workstream tree
  scrolls inside its own area; the Settings block is fixed at the bottom of the
  column.
- The column's height is recalculated on scroll, resize and when fonts load
  (`top edge → bottom of the screen`, minimum 260px), so Settings is on screen
  at first load even when the page starts partway down, and at 720px-high
  laptop screens.
- Tested in the demo with 30 extra workstreams: Settings stayed on screen at
  first load and while scrolling the page.
- Under 900px wide the layout is one column and the block is an ordinary
  section after the tree (no pinning, no inner scroll).
- Cost: with a long tree some workstreams are out of sight until the tree is
  scrolled. That is accepted in exchange for Settings being always reachable.

### 3. The MCP URL

- **What it is:** `<base URL>/api/mcp/<owner>/<repo>`, built the way the
  agent-token screen already builds it (`baseUrlFor(req)` +
  `/api/mcp/${owner}/${repo}`, through the existing base-URL allowlist). The
  prototype uses `https://teamctx.vercel.app/api/mcp/northwind/gtm`.
- **Read-only text, no input or textarea.** It cannot be edited. A text box
  would suggest it can.
- **One line.** The column is narrow, so the display is shortened in the middle
  to host and project: `teamctx.vercel.app/…/northwind/gtm`. A person copies it, they
  do not read it, so the full string is not shown. The full URL is in the
  tooltip. If the shortened text still does not fit, it ends in an ellipsis; it
  never wraps.
- **Copy icon** to the right of the text. It always copies the **full** URL,
  never the shortened text. On success the icon becomes a check mark for about
  1.6 seconds, then returns. Uses the browser clipboard; if that is unavailable
  (non-secure context, older browser) it falls back to a hidden read-only field
  and the browser's copy command, still with the full URL.
- **Label for the tooltip and screen readers:** "Copy the MCP URL" on the
  button; the text carries "Add this as a custom connector in Claude, ChatGPT or
  Copilot".
- **Who sees it:** everyone who can open the project page. The URL is an
  address; the connector still authenticates and applies scope, so seeing it
  grants nothing.

### 4. Why this is right for the next 6 to 12 months

- Most people will reach a project through an assistant, and connecting one is a
  one-time step that needs this URL. Putting it one click away turns a docs
  search into a copy and paste.
- It sits with the other plumbing (team, agents, sources), not above the goal,
  so the page opens with what the project is for.
- Pinning means the "connect your assistant" path is always visible however
  large the project grows.

## Existing open source first

Nothing to borrow for this change. It is one server-rendered block, a
sticky-position style, a 15-line copy handler that uses the platform's
`navigator.clipboard` (with the `execCommand` fallback), and a string build that
already exists. A clipboard library (clipboard.js, copy-to-clipboard) would add
a dependency for something the browser already does. Rejected on purpose.

## Changes

- `src/views/project.js`: remove the `owner/repo` slug line under the title; add
  a Settings section to the `<aside>` after the lanes, containing the MCP URL row
  (shortened text, copy button, full URL in `data-` and tooltip) and the
  existing team/sources items as they become available. Pass the connector URL
  in from `readProjectView` using the same builder as the agent-token screen.
- `src/views/project.js` CSS and a small script: sticky column, inner scroll for
  the tree, height fit on scroll/resize/fonts, 900px breakpoint reset, and the
  copy handler.
- No change to the connector, auth, scope enforcement or the drawers.

## Testing

- View test: the page contains the connector URL for `owner/repo` built from the
  base URL, as text, escaped; no `<input>` or `<textarea>` carries it.
- View test: the shortened display text is `host/…/<owner>/<repo>` and the copy
  button's payload is the full URL.
- Handler test (DOM): clicking copy writes the full URL to the clipboard and the
  icon switches to the check state then back; with the clipboard API removed it
  falls back and still copies the full URL.
- Layout check (browser): with 30+ workstreams, Settings is inside the viewport at
  scroll 0 and after scrolling, at 1440x900 and 1280x720; under 900px it flows
  after the tree.
- Regression: the team and sources drawers open from the Settings items.

## Open questions

- The prototype shows team, agent, external-talent and sources lines that the
  real page does not render yet. Ship the MCP URL block first and add each line
  when its data exists, or hold the move until all of them do? Recommendation:
  ship the URL block now.
- Should the URL row also offer "Open in Claude / ChatGPT" shortcuts? Deferred to
  the connect-your-assistant work; not part of this fix.
