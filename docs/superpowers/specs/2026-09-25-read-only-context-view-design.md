# Read-only context view + chat-to-web deep links

**Date:** 2026-09-25
**Status:** Design approved in conversation; spec pending review
**Builds on:** #100 / #101 (read-only project page), #102 (sign-in chooser for Google members)

## Problem

teamctx's context — the Why → What → How tree per workstream, plus the project
layer every workstream inherits — is only visible through a chat assistant or
the CLI. #101 added a read-only project page, but it shows tables of
workstreams, tasks and the review queue; it does **not** show the tree, which is
the thing teamctx exists to keep.

The earlier self-hosted app, `StatsLateral/git-for-non-tech-teams`, had a view
people liked: a workstream sidebar, the tree in numbered Why/What/How columns
(or a list), and a drawer on each item. It is a separate React SPA on a
June-era data model (`.teamctx/shared.json`) with write actions this project
now routes through chat.

And a person in a chat has no way to jump from "I just added that" to seeing it.

## Goals

1. Bring the git-for-non-tech-teams **look and layout** into teamctx's own web
   pages, **read-only**, on teamctx's current data model.
2. Restyle the whole teamctx web surface (home, sign-in, projects, project,
   settings) in that look so it reads as one product.
3. Chat tools return a **plain deep link** to the exact workstream / item / task
   / review they touched; the assistant includes it in its reply.
4. Keep the current sign-in flow (GitHub or Google, per #102); clicking a link
   while signed out signs in, then lands on the linked item.

## Non-goals

- Editing in the web UI (contribution box, "update context", approve/reject).
- Any AI call from the page (no model picker, no live "ask").
- Rendering the view inside chat clients (MCP UI resources / Apps SDK).
- Magic sign-in links or any credential in a URL.
- The old app's integration tiles, "reset data", localStorage demo mode.
- Retiring the `git-for-non-tech-teams` repo (separate decision).

## Decisions made during design

| Question | Decision |
|---|---|
| What does "chat → UI" mean? | Deep link out, not an embedded UI. |
| Signed-out click on a link | Current teamctx sign-in flow, restyled; no magic links. |
| Build approach | Server-rendered in teamctx (existing `shell()` pattern) + small vanilla JS. Not a React port, not a separate app. |
| Drawer's AI "ask" | Replaced by "Copy a prompt for your assistant". |

## Design

### 1. Look (every page)

Port the old app's design system into a single theme module:

- Tokens (from `git-for-non-tech-teams/src/index.css`): `--paper #f4efe6`,
  `--card #fcfaf5`, `--ink #1a1c1a`, `--soft #5a625b`, `--faint #8a9088`,
  `--line #e4dbcc`, `--accent #1f6f5c`, `--accent-soft #e6f0eb`,
  `--amber #b5651d`, `--amber-soft #f4e8da`, `--indigo #4f46e5`,
  `--indigo-soft #eef2ff`; `--radius 12px`, `--radius-sm 8px`.
- Fonts via Google Fonts: Fraunces 500/600 (display), Hanken Grotesk 400/500/600
  (body), Spline Sans Mono 500/600 (labels, numbering).
- Component styles carried over: sidebar lane card + name chips, column and list
  tree rows (`statement-number`, source dot), right-hand drawer, mono section
  labels, buttons.
- **Dark mode is new** (the old app had none): define dark values for every
  token under `prefers-color-scheme: dark`.

Home, sign-in, projects, settings and error pages move to this theme. Their
content and behaviour are unchanged by this work (sign-in page content is #102's).

### 2. Project page `/project/:owner/:repo`

Replaces #101's table layout.

- **Sidebar.** A "Project" entry (the project-level tree), then each workstream
  the viewer can see, each with name chips for its members. Scoped members see
  only their workstreams — same `inScope` rule as today.
- **Main area.** The selected workstream's tree as numbered **Why / What / How
  columns** (default) with a **list** toggle. Project-level Whys appear above the
  workstream's own as a visually distinct "Project context — inherited" band,
  matching how teamctx composes context. Selecting "Project" shows the project
  tree alone.
- **Source dot** on each item, as in the old app: colour = `source` of the most
  recent contribution in its `sourceContributionIds` (`human` / `human+AI` /
  `ai-service`); no dot when unknown.
- **Drawer** (click an item): full text, `summary`, the names of everyone whose
  contribution touched it (from `sourceContributionIds` → contribution
  `author`), and a **"Copy a prompt for your assistant"** button that copies
  e.g. `Tell me more about "1.2 <text>" in <workstream> on <project>.`
- **Below the tree** (from #101, restyled): Tasks (open / done, with assignee)
  and — managers only — "Waiting on you" (review queue).
- **Phone width:** sidebar becomes a workstream `<select>`; columns stack.
- **Empty tree:** "Nothing written here yet — ask your assistant to add context."

### 3. Deep links

**Format:** `/project/<owner>/<repo>?ws=<workstream-id>&item=<node-id>`, plus
`?task=<task-id>` and `?review=<queue-id>`.

- Stable IDs, never the displayed `1.2` numbering (it shifts).
- Query string, **not** a `#fragment` — fragments never reach the server, so
  they would be lost across the sign-in redirect.
- Widen `RETURN_TO` in `api/oauth-server.js` to accept exactly these query
  params with a strict character class; still same-site paths only.
- On load: select the workstream, scroll the item/task/review into view,
  highlight it briefly, open the item's drawer.
- Anything unknown, out of scope or deleted: open the nearest valid level (the
  workstream, else the project) with a quiet "That item isn't here anymore"
  note. Param values are never echoed into the page.

**Tools that return `viewUrl`** (field added to the result; the tool
description tells the assistant to include it, as `member_add` does with
`connectUrl`):

| Tool | Links to |
|---|---|
| `contribute`, applied | First changed item, else the workstream |
| `contribute`, queued for review | Manager: `?review=<id>`; member: their workstream |
| `task_add` / `task_assign` / `task_done` | `?task=<id>` |
| `my_brief` | The member's workstream (or project) |
| `get_status` | The project |
| `get_workstream` | That workstream |

**Base URL:** same resolution as `connectUrl()` in `mcp/server.js`
(`config.deployUrl`, else hosted base URL). When there is none (local / stdio),
`viewUrl: null` plus `viewUrlError` with a one-line reason, and the description
says to omit the link rather than invent one.

**Security:** the link carries no credential. Clicking still requires sign-in
and the same access checks, so forwarding a link grants nothing.

### 4. Code layout

`api/oauth-server.js` is ~1,600 lines, mostly HTML templates. Split as part of
this work:

- `api/views/theme.js` — tokens, component CSS, dark mode, `shell()`, `esc()`.
- `api/views/project.js` — project page template + inline script (target
  < ~100 lines: view toggle, drawer, copy-prompt, open-linked-item).
- `api/views/{home,signin,projects,settings,error}.js` — existing templates,
  restyled.
- `oauth-server.js` keeps routes only.
- `src/view-url.js` — `buildViewUrl({ base, owner, repo, ws, item, task, review })`
  and `parseViewParams(query)`; shared by MCP tools, the project route and the
  `RETURN_TO` check.

### 5. Data

Extend `readProjectView()` (`src/oauth/project-view.js`) to also return:

- `projectTree` from `readProject()`.
- `trees[wsId]` from `readWorkstream(id)` for **in-scope workstreams only** —
  out-of-scope trees must never be in the page payload, not merely hidden.
- `contributions` needed for dots and drawer names: `{ id, author, source }`
  from `readContributions()`, restricted to IDs referenced by returned trees.

No extra GitHub requests: `session.prefetch()` already loads these files.

### 6. Errors

| Case | Behaviour |
|---|---|
| Can't read repo / not on roster / no lent credential | Existing 403 page, restyled |
| Unknown/out-of-scope `ws`/`item`/`task`/`review` | Fallback + quiet note (§3) |
| Non-manager passes `?review=` | Ignored |
| Empty tree | Empty-state copy (§2) |
| All human/AI-authored text | Through `esc()` |

### 7. Tests

- `src/oauth/project-view.test.js` / `api/project-view.test.js`: scoped member's
  payload contains no out-of-scope tree; drawer names and source kinds resolve
  correctly; review queue manager-only.
- `src/view-url.test.js`: build/parse round-trip; rejects bad IDs;
  `RETURN_TO` accepts the new params and still rejects off-site, `//`, and
  unexpected params.
- MCP tests: each tool in §3 returns `viewUrl`; `null` + reason with no
  deployment.
- Page tests: `?ws=&item=` renders with that workstream selected and the item
  marked; unknown item renders fallback note, not the raw param.
- Existing `home.test.js`, `settings-*.test.js`, `connect-signin.test.js` pass
  after the move to `api/views/`; `cli/loads.test.js` covers new files.

## Dependencies and sequencing

1. **#102** (sign-in chooser, `returnTo` through Google) — land first or
   together; §3's signed-out path relies on it.
2. Theme + view split (no behaviour change) — reviewable on its own.
3. Project page tree view + data.
4. Deep links: `src/view-url.js`, `RETURN_TO`, MCP `viewUrl`.

Steps 2–4 can be one PR or three; three is easier to review.

## Open questions

None blocking. Retiring or archiving `git-for-non-tech-teams` once this ships
is a separate call for the maintainer.
