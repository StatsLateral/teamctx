# Proposal: Google Drive as a connected source

**Status:** Implemented, except the tasks it feeds · **Issue:** [#171](https://github.com/StatsLateral/teamctx/issues/171)
· **Base:** `main` (after #168)

## What the issue asks

A Drive file or folder that reaches the project shows in the Connected sources
drawer under Google Drive, with its link, summary, date and the tasks it feeds,
for people who may see those tasks. It arrives either through the person's
assistant (its own Drive connector; teamctx holds no Drive credential) or
through the shipped importer (`src/connectors/gdrive.js`, #23). Only a link,
title, summary and date are kept: never file contents, never a credential.

## What #168 already gives Drive

- `teamctx import --from gdrive` records each file under Google Drive with the
  `webViewLink` the API returns, its name and the `gdrive:<file id>` item id.
- Reused: the shipped importer for auth, listing and fetching. The Activepieces
  and Onyx Drive connectors are not needed: the reference is built from what
  the importer already read, and the assistant route needs no client.

## What is left

1. **One file, one reference.** A Drive file has many links, and a reference's
   id is taken from its link, so today each becomes its own entry:
   - the API's `https://docs.google.com/document/d/<id>/edit?usp=drivesdk`
   - "Share": `…/d/<id>/edit?usp=sharing`, or `drive.google.com/file/d/<id>/view?usp=drive_link`
   - a heading or a sheet tab: `…/edit#heading=h.x`, `…/edit#gid=0`
   - another signed-in account: `…/u/1/document/d/<id>/edit`
   - the old form: `drive.google.com/open?id=<id>`

   A Drive link is reduced to one form per file, by its id:
   `https://drive.google.com/file/d/<id>/view` for a file (it opens Docs,
   Sheets and Slides too), and `https://drive.google.com/drive/folders/<id>`
   for a folder. `resourcekey`, which some older shared files need in order to
   open, is kept; everything else (`usp`, `authuser`, the anchor) is dropped.
   Added as the `gdrive` entry of `NORMALIZE_LINK` in `src/sources.js` (the
   per-tool map from #186/#187). A link that is not to a Drive file or folder
   is left as it is.
2. **The assistant route says what to pass.** The `sources` description asks,
   for Drive, for the file's link and its name.
3. **End to end test,** as for Slack and Notion: an imported file and an
   assistant-cited file land under Google Drive, once, with no file text and no
   token written.

**The tasks it feeds** are the same gap for every tool: work for a task is sent
with `task_submit` (#197), which takes no `sources` yet. That is its own
change, not this one.

## Plan

- [x] Drive link to one form per file or folder, keeping `resourcekey`; tests
      for each link above, a folder, and non-Drive links
- [x] `sources` guidance for Drive; test that the schema says it
- [x] End to end test (import and assistant)
- [x] CHANGELOG
