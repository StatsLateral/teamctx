# Proposal: Dropbox as a connected source

**Status:** Proposed · **Issue:** [#173](https://github.com/StatsLateral/teamctx/issues/173)
· **Base:** `main` (after #168)

## What the issue asks

A Dropbox file or shared link that reaches the project shows in the Connected
sources drawer under Dropbox, with its link, summary, date and the tasks it
feeds, for people who may see those tasks. It arrives either through the
person's assistant (its own Dropbox connector; teamctx holds no Dropbox
credential) or through the shipped importer (`src/connectors/dropbox.js`, #25).
Only a link, title, summary and date are kept: never file contents, never a
credential.

## What #168 already gives Dropbox

- `teamctx import --from dropbox` records each file under Dropbox by its name and
  its `dropbox:<path>` item id, but with **no link**: Dropbox's file metadata
  carries no web address, so the importer has none to hand over.
- Reused: the shipped importer for auth, listing and fetching. The Activepieces
  and Onyx Dropbox connectors are not needed.

## Two kinds of link, as with SharePoint (#172)

- **The file's address** in Dropbox,
  `https://www.dropbox.com/home/Specs?preview=Plan.docx`, opens only for people
  the file is already shared with, after signing in.
- **A shared link**, `https://www.dropbox.com/scl/fi/<id>/Plan.docx?rlkey=…&dl=0`
  (also `/s/…`, `/scl/fo/…` for a folder, `dl.dropboxusercontent.com`,
  `db.tt`). Dropbox's default for these is "anyone with the link": the link is
  the access. A reference is read by everyone on the project.

## What is left

1. **No shared link is kept**, under any tool label, as for SharePoint: an item
   brought with only a shared link keeps its title, summary and date, and no
   link. (#168 kept `rlkey` so that such a link would open; that is exactly what
   makes it a credential.) The issue's "file or shared link" is still met: the
   item a shared link points at is recorded, by its name.
2. **An imported file gets its address,** built from the path Dropbox already
   gave the importer: `https://www.dropbox.com/home/<folder>?preview=<file name>`.
   A file imported through a shared link keeps none.
3. **One file, one reference.** An address copied from the browser keeps its
   folder and `preview` and drops the rest (`di`, `role`, …), so it lands on
   the same entry as the import. Added as the `dropbox` entry of
   `NORMALIZE_LINK` in `src/sources.js`.
4. **The assistant route says what to pass:** the file's address (from the
   browser) and its name, never a shared link.
5. **End to end test,** as for the other tools.

**The tasks it feeds** are the same gap for every tool (`task_submit`, #197,
takes no `sources` yet), and are left to their own change.

## Plan

- [ ] Shared links (`/scl/fi`, `/scl/fo`, `/s/`, `dl.dropboxusercontent.com`,
      `db.tt`) are not kept; tests
- [ ] The importer hands over a file's address; a browser address reduced to
      folder and `preview`; tests
- [ ] `sources` guidance for Dropbox; test that the schema says it
- [ ] End to end test (import and assistant)
- [ ] CHANGELOG
