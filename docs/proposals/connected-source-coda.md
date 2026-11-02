# Proposal: Coda as a connected source

**Status:** Implemented, except the tasks it feeds · **Issue:** [#174](https://github.com/StatsLateral/teamctx/issues/174)
· **Base:** `main` (after #168)

## What the issue asks

A Coda doc or page that reaches the project shows in the Connected sources
drawer under Coda, with its link, summary, date and the tasks it feeds, for
people who may see those tasks. It arrives either through the person's
assistant (its own Coda connector; teamctx holds no Coda credential) or through
the shipped importer (`src/connectors/coda.js`, #27). Only a link, title,
summary and date are kept: never page contents, never a credential.

## What #168 already gives Coda

- `teamctx import --from coda` records each page under Coda by its name and its
  `browserLink`, which Coda's page listing already carries.
- Reused: the shipped importer for auth, listing and exporting. The Activepieces
  and Onyx Coda connectors are not needed.

## What is left

A Coda link names the doc and page twice: by a title slug and by an id,
`coda.io/d/Handbook_dAbCd1234/Onboarding_su42`. The slug changes when the doc or
page is renamed, and a link copied from the browser often adds a query
(`?searchClear=true`) or an anchor to a table or row (`#Tasks_tu9/r5`). So one
page reaches the project under several links.

1. **One page, one reference.** A Coda link is reduced to its ids,
   `https://coda.io/d/_dAbCd1234/_su42` (the form Coda's own API uses for a
   doc), dropping slugs, query and anchor. An import and an assistant citing
   the same page land on the same entry, and a rename doesn't split it. Added
   as the `coda` entry of `NORMALIZE_LINK` in `src/sources.js`. A published
   doc (`coda.io/@…`) is kept as it came.
2. **The assistant route says what to pass:** the doc or page link from the
   browser and the page's name.
3. **End to end test,** as for the other tools.

No shared-link rule is needed: a Coda doc is shared by its own address, and who
can open it is set in Coda, so the link carries no access of its own.

**The tasks it feeds** are the same gap for every tool (`task_submit`, #197,
takes no `sources` yet), and are left to their own change.

## Plan

- [x] A Coda link reduced to doc and page ids; tests
- [x] `sources` guidance for Coda; test that the schema says it
- [x] End to end test (import and assistant)
- [x] CHANGELOG
