# Plan: contribution provenance on nodes + `ask --audit`

**Branch:** `feat/contribution-provenance` (off `main`)
**PR base:** `main`.
**PR shape:** Single PR — schema + ops stamping + serializer + ask + reflect passthrough + docs.

---

## Motivation

teamctx already tags **decisions** with inline provenance in every compiled
markdown file (`*[decision — priya, 2026-06-14, via cli]*`), so users can
trace where a decision came from. But **regular non-decision contributions
leave no trail on the tree**. Once `applyOps` turns a contribution into a
Why/What/How node, the node has no memory of who wrote it. `teamctx ask`
answers questions confidently, but the user has no way to check *whose*
input the answer is built on.

The manager wants: (a) a one-line contributor list appended to every `ask`
answer by default, and (b) a `--audit` flag that expands that into the
detailed reference list of specific contributions each claim traces to.

Constraint from the manager: **don't do this work at ask time**. AI calls
shouldn't inflate their prompt with the whole contribution log every time.
Stamp attribution when the node is *created or modified*, then read it
cheaply at ask time.

## What's already there

- `contributions.jsonl` records every contribution with `id`, `author`,
  `ts`, `text`, `source`, `workstream`, and `tagged` (`decision` or null).
- Decisions render as inline markers in `serializeToMd` / `generateRoleFile`
  / `answerQuestion` — because the serializer looks at `contributions` and
  matches by text pattern.
- The Why/What/How node schema on `.teamctx/workstreams/<ws>.json` has
  `{id, text, whats?, hows?}` — no author, no history.

**The gap:** non-decision contributions leave no persistent link to the
nodes they created or edited.

## Design

### 1. Schema — `sources: []` on every node

Extend Why/What/How nodes with an optional `sources` array. Each entry is
the smallest sufficient reference back to a contribution:

```jsonc
{
  "id": "w1",
  "text": "grow revenue",
  "whats": [ ... ],
  "sources": [
    { "contributionId": "c-1720000000000-abc", "author": "shikhin",
      "ts": "2026-07-14T10:00:00Z", "type": "created" },
    { "contributionId": "c-1720000200000-xyz", "author": "satya",
      "ts": "2026-07-20T12:00:00Z", "type": "modified" }
  ]
}
```

`type` = `"created" | "modified" | "decision"`. Ordered oldest-first.
Missing/absent `sources` on legacy nodes is fine — treated as `[]`.

**No migration required.** Existing projects work; nodes just have no
provenance until they're next touched by a contribution.

### 2. Ops — `applyOps` stamps sources

`src/ops.js` is where the mutation happens. Extend the op handlers so that
every op carries a `sourceRef` (built from the contribution) and every
node the op touches gets that ref pushed onto its `sources` array.

Ops that stamp:
- `addWhy`, `addWhat`, `addHow` → `type: "created"` on the new node.
- `updateWhy`, `updateWhat`, `updateHow`, `renameWhy`, etc. → `type:
  "modified"` on the touched node.
- Anything derived from a `--decision` contribution → `type: "decision"`.

Ops that DON'T stamp:
- `deleteWhy`, `deleteWhat`, `deleteHow` — the node is gone; nothing to
  stamp on.

### 3. Serializer — new "Contributors" section

`serializeToMd` (and by extension `generateRoleFile`) currently produce the
Why/What/How tree plus an "Open Decisions" footer. Add a new footer section
**"Contributors"** that lists distinct contributors ordered by count desc,
with counts:

```
## Contributors

- **priya** — 4 contributions (1 decision)
- **shikhin** — 3 contributions
- **rajeev** — 1 contribution
```

The section is derived purely from the `sources` arrays across all nodes
in the tree. If no node has any sources yet, the section is omitted.

### 4. `ask` — default one-liner + `--audit` detail block

**`answerQuestion` signature** gains an optional `audit` boolean. The
grounding context stays the same. What changes is what we *append* to the
AI's answer:

Default (near-zero cost):
> [AI answer]
>
> **Contributions from:** priya (2), shikhin (1), rajeev (1)

With `--audit` (still no AI call added — we compute the list locally):
> [AI answer]
>
> **Sources**
> - shikhin, 2026-06-01 (cli) — created "CAC on Google keeps rising"
> - rajeev, 2026-06-08 (web) — created "LinkedIn ROAS trending up"
> - **decision** — priya, 2026-06-14 (cli) — "pause paid ads on Google"
> - priya, 2026-06-15 (cli) — modified "reallocate budget to LinkedIn"

The one-liner and the detail block both come from `collectContributors`
and `collectSources`, two pure helpers that walk the workstream tree,
flatten sources, and join to `contributions.jsonl` for text + tagged
status.

**We do NOT ask the AI to attribute claims to sources.** That would be
expensive and unreliable. The attribution is a *listing of what fed into
the compiled tree*, not a per-claim citation. The user still gets the
value: they can see who authored the material behind the answer, and
`--audit` shows every contribution's specific text and role.

### 5. Reflect passthrough

`reflect` rewrites the tree via AI, keeping node ids stable where possible.
`generateReflection` should preserve `sources` on any node whose id it
retains. When it merges two nodes, concatenate their sources; when it
splits a node, put the same sources on both children.

Additionally, `reflect` itself is a system-level modification; on any node
it touches, append one system source: `{contributionId: "system:reflect",
author: config.me, ts: now, type: "modified"}`. This keeps the trail
honest.

### 6. MCP `ask` tool

The MCP server's `ask` tool gains an `audit: boolean` param. Default false.
Behavior mirrors the CLI: false → one-line contributor list; true → detail
block. No new tool needed.

### 7. `contribute` — record the mapping

`applyOps` already receives the contribution. Make sure the contribution
id + author + ts are threaded from `contribute.js` → `updateShared` →
`applyOps` → node stamping. Same for `review approve` (queue path — the
queue item has `author` and its own id).

## Non-goals (call out in PR body)

- **No per-claim citation** — attribution is at the node level (this Why /
  What / How came from these contributions), not at the sentence level
  ("this word in the AI answer traces to contribution X").
- **No diff view** showing what each contribution changed in the tree.
- **No backfill** of provenance on nodes that predate this feature. Legacy
  nodes render as `_sources unknown_` under `--audit`.
- **No auth boundary** — the `author` on a contribution is still whatever
  `config.me` is set to. Same trust model as the CLI today. A future auth
  layer can harden this without changing the provenance shape.
- **No `sources` in `snapshot show` output** in v1 — snapshots capture the
  tree bytes, so the sources travel with it silently; we don't need a new
  UI section on snapshots.

## Files touched

New:
- `src/provenance.js` — small module with `nodeSourceRef(contribution, type)`,
  `stampSource(node, ref)`, `collectContributors(workstream)`,
  `collectSources(workstream, contributions)`, `formatAuditBlock(sources)`.
- `src/provenance.test.js` — unit tests for the helpers.
- `docs/audit.md` — end-user explainer.

Modified:
- `src/ops.js` — each op accepts `sourceRef`, stamps on the target node.
- `src/ops.test.js` — assert stamping across each op type.
- `src/context.js` — `serializeToMd` appends Contributors section;
  `generateRoleFile` unchanged (inherits from serializer);
  `answerQuestion({audit})` appends contributor line or audit block;
  `generateReflection` preserves sources.
- `src/context.test.js` — cover the new behavior.
- `cli/commands/contribute.js` — thread contribution ref into `applyOps`.
- `cli/commands/review.js` — same for the queue path.
- `cli/commands/reflect.js` — preserve sources; add system-source stamp.
- `cli/commands/ask.js` — `--audit` option; pass through to
  `answerQuestion`.
- `api/ask.js` — accept `audit` in the POST body; pass through.
- `mcp/server.js` — `ask` tool gains optional `audit` arg.
- `mcp/server.test.js` — cover the audit path.
- `README.md` — brief mention + link to `docs/audit.md`.
- `CHANGELOG.md` — `## [Unreleased]` Added / Changed entries.

## Order of work

Roughly 2 days, similar shape to the tasks feature. Each step is
independently testable.

1. **Provenance module + tests** — pure helpers, no wiring yet.
   **Half day.**
2. **Ops stamping** — extend every op handler; thread contribution refs
   from `contribute.js` and `review.js`. Cover with `src/ops.test.js`.
   **Half day.**
3. **Serializer + ask** — Contributors footer; default one-liner;
   `--audit` detail block; API endpoint; MCP tool arg. **Half day.**
4. **Reflect preservation + docs/CHANGELOG.** **Half day.**

## Testing checklist

- [ ] `npm test` green.
- [ ] Manual: fresh project, `contribute` × 3 with `--apply` from
      different authors, `ask "…"` — one-line contributor list appears.
- [ ] Manual: same, `ask "…" --audit` — detail block appears with each
      contribution's text and role.
- [ ] Manual: mark one contribution `--decision`; verify it shows as a
      **decision** source in the audit block.
- [ ] Manual: `reflect`; verify sources on kept nodes survive, and a
      `system:reflect` entry appended.
- [ ] Manual: legacy project (nodes without `sources`) — `ask` still
      works; `--audit` prints "sources unknown".
- [ ] `CHANGELOG.md` entry under `## [Unreleased]`.
- [ ] Commits signed off (`git commit -s`).

## Follow-ups (out of scope)

- MCP tool discovery for a "list sources for node X" query.
- Per-claim citation via a lightweight AI pass at ask time (opt-in,
  behind a second flag).
- Snapshot-diff view scoped to provenance.
- Backfill script that walks `contributions.jsonl` + git history and
  tries to reconstruct provenance for legacy nodes.
