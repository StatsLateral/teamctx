# Proposal: Notion as a connected source

**Status:** Implemented, except the tasks it feeds (after #184) · **Issue:** [#170](https://github.com/StatsLateral/teamctx/issues/170)
· **Base:** `feat/connected-sources` (#168, PR #185)

## What the issue asks

A Notion page that reaches the project shows in the Connected sources drawer
under Notion, with its link, summary, date and the tasks it feeds, for people
who may see those tasks. Its summary is refreshed when the page changes. It
arrives either through the person's assistant (its own Notion connector;
teamctx holds no Notion credential) or through the shipped importer
(`src/connectors/notion.js`, #26). Only a link, title, summary and date are
kept: never page contents, never a credential.

## What #168 already gives Notion

- `teamctx import --from notion` records each page under Notion with the
  `url` the API returns on its listing, its title and the `notion:<page id>`
  item id. A page with no url gets none, and is kept by its id.
- A page imported or cited again adds a feed, and the drawer shows the latest
  visible feed's summary. So a changed page that is brought in again shows its
  new summary: that is the "refreshed" the issue asks for.
- Reused: the shipped importer for auth, listing and fetching. The Activepieces
  and Onyx Notion connectors are not needed: the reference is built from what
  the importer already read, and the assistant route needs no client.

## What is left

1. **One page, one reference.** A Notion page has many links, and its id is
   taken from the link, so today each becomes its own reference, and a changed
   page's new summary lands beside the old one instead of replacing it:
   - the API's `https://www.notion.so/Launch-checklist-<id>`
   - the same page after it is renamed (`…/Launch-plan-<id>`)
   - "Copy link": `https://www.notion.so/<workspace>/Launch-checklist-<id>?pvs=4`
   - a link to a block on it: `…-<id>#<block id>`
   - the dashed id, `…/<8-4-4-4-12>`

   A Notion page link is reduced to `https://www.notion.so/<32-hex page id>`
   before its id is taken, for both routes. This opens for anyone the page is
   shared with, and loses only the title words and the workspace slug.
   `*.notion.site` (published pages) is left as it is, since its address is the
   public one. A link that is not to a Notion page is left as it is.
2. **The assistant route says what to pass.** The `sources` description asks,
   for Notion, for the page's link and its title.
3. **The tasks it feeds.** As for Slack, a task arrives with #144's `forTask`
   (PR #184); after it merges, the `forTask` path records sources with the task.
4. **End to end test,** as for Slack: an imported page and an assistant-cited
   page both land under Notion, once, with no page text and no token written.

## Plan

- [x] Notion page link to its canonical link, used for the id and the stored
      link; tests for the API url, renamed, "Copy link", block anchor, dashed
      id, `notion.site` and non-Notion links
- [x] A changed page, imported again, shows one reference with the new summary
- [x] `sources` guidance for Notion; test that the schema says it
- [x] End to end test (import and assistant)
- [ ] After #184: record sources on the `forTask` path, with the task
- [x] CHANGELOG
