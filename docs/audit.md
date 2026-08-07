# Contribution provenance & `ask --audit`

Every Why / What / How node in your teamctx tree already carries a
`sourceContributionIds` array — a list of the contributions that either
created or modified it. This has been true since day one; it's how decision
markers work. What's new: **`ask` now surfaces that trail every time.**

## What you get for free

Any `teamctx ask "..."` now ends with a one-line summary of the contributors
whose material the AI actually used for **this specific answer** — capped
at the top 5:

```
> AI answer here.
>
> ---
>
> **Contributions from:** rajeev (1), priya (1, 1 decision)
```

How it works: the tree passed to the AI is annotated with inline
`[sources: c-x]` tags, and the system prompt asks the AI to end its answer
with `## Citations: c-x, c-y` listing which contributions it used. teamctx
parses that block, filters, and renders the footer — no second AI call.

If the AI answers with `## Citations: none` (or forgets the block), no
footer renders.

Compiled files also grow a **Contributors** section at the bottom of
`context/workstreams/<id>.md`:

```
## Contributors

- **priya** — 3 contributions (1 decision)
- **rajeev** — 1 contribution
- **shikhin** — 1 contribution
```

## Detailed audit — `--audit`

Add `--audit` to `ask` (or `audit: true` on the MCP `ask` tool, or an
`audit=true` field on the web `/ask` form) to expand the footer into the
full source list for the contributions the AI cited (no cap):

```
> AI answer here.
>
> ---
>
> **Sources**
>
> - shikhin, 2026-06-01 (cli) — CAC on Google keeps rising
> - rajeev, 2026-06-08 (web) — LinkedIn ROAS trending up
> - **decision** — priya, 2026-06-14 (cli) — Pause paid ads on Google
> - priya, 2026-06-15 (cli) — Reallocate budget to LinkedIn
```

The audit list is joined from `.teamctx/workstreams/<id>.json` (which node
was touched by which contribution id) and `.teamctx/contributions.jsonl`
(who authored it, when, from which surface, and whether it was tagged as a
decision). No AI call — pure local read.

## How provenance is written

You already have this — `applyOps` in `src/ops.js` stamps a
`sourceContributionIds` entry on every node it creates or edits. So every
contribution's fingerprint lands on the tree at write time. Ask reads it,
doesn't compute it.

## Reflect preservation

`teamctx reflect` asks the AI to rewrite the tree. When the AI keeps a
node's id, teamctx now automatically preserves that node's original
`sourceContributionIds` (and merges in anything the AI added). Provenance
survives reflection.

## Legacy projects

Projects that predate this feature have nodes with no
`sourceContributionIds`. `ask` on those projects simply omits the footer.
`--audit` prints a small note if some ids don't resolve. New contributions
land with full provenance immediately.

## Not doing this yet

- **Per-sentence citation.** Attribution is at the node level (which
  Why / What / How came from which contribution), not "this specific claim
  in the AI's answer came from contribution X."
- **A diff view** showing what each contribution changed in the tree.
- **Backfill.** Legacy nodes stay legacy. New contributions carry
  provenance forward.
- **Auth.** The `author` on a contribution is still whatever `config.me`
  is set to — no identity verification. Same trust model as the rest of
  the CLI.
