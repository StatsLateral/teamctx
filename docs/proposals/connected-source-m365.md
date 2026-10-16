# Proposal: Microsoft SharePoint (Microsoft 365) as a connected source

**Status:** Proposed · **Issue:** [#172](https://github.com/StatsLateral/teamctx/issues/172)
· **Base:** `main` (after #168)

## What the issue asks

A SharePoint or OneDrive library file that reaches the project shows in the
Connected sources drawer under Microsoft SharePoint, with its link, summary,
date and the tasks it feeds, for people who may see those tasks. It arrives
either through the person's assistant (its own Microsoft 365 connector; teamctx
holds no Microsoft credential) or through the shipped importer
(`src/connectors/m365.js`, #24). Only a link, title, summary and date are kept:
never file contents, never a credential.

## What #168 already gives SharePoint

- `teamctx import --from m365` records each file under Microsoft SharePoint with
  the `webUrl` Graph returns (`https://<tenant>.sharepoint.com/sites/<site>/Shared Documents/<file>`),
  its name and the `m365:<item id>` item id.
- Reused: the shipped importer for auth, listing and fetching. The Activepieces
  and Onyx Microsoft 365 connectors are not needed: the reference is built from
  what the importer already read, and the assistant route needs no client.

## Where SharePoint differs from Slack, Notion and Drive

Their links carry the item's id, so every way of copying one could be reduced
to one link. A SharePoint file has two kinds of link that cannot be matched
without asking Microsoft:

- **Addresses**, which open only for people with access:
  - the library path, `…/sites/Team/Shared Documents/Release notes.docx`
  - the Office viewer, `…/_layouts/15/Doc.aspx?sourcedoc={GUID}&file=…&action=default&mobileredirect=true`
- **Sharing links**, `https://<tenant>.sharepoint.com/:w:/s/Team/EaBc…?e=Xy12`,
  `1drv.ms/w/s!…`, `onedrive.live.com/?…&authkey=…`. The token *is* the access.
  An "anyone with the link" sharing link opens the file for whoever holds it,
  and a reference is read by everyone on the project.

## What is left

1. **No sharing link is kept.** A sharing link counts as a credential, as the
   issue's "never a credential" asks: a reference that arrives with one keeps
   its title, summary and date, and no link. The assistant is asked for the
   file's address instead (point 3), so it is rarely needed. *(Decision below.)*
2. **One file, one reference, as far as the link allows.**
   - The library path keeps its path and drops the query and anchor.
   - The Office viewer link keeps its site and `sourcedoc` and drops `file`,
     `action`, `mobileredirect` and the rest.
   - The two forms of the same file still make two references; matching them
     needs a Graph call, which the assistant route never makes.
   Added as the `m365` entry of `NORMALIZE_LINK` in `src/sources.js` (the
   per-tool map from #186/#187/#171).
3. **The assistant route says what to pass.** The `sources` description asks,
   for SharePoint and OneDrive, for the file's address (from the address bar or
   "Copy path"), not a sharing link, and its name.
4. **End to end test,** as for the other tools: an imported file and an
   assistant-cited file land under Microsoft SharePoint, with no file text, no
   token and no sharing link written.

**The tasks it feeds** are the same gap for every tool (`task_submit`, #197,
takes no `sources` yet), and are left to their own change.

## Decision

Keep a sharing link, or drop it? Dropping it (recommended) means an entry
cited with only a sharing link has no link to click, but nobody on the project
gets access to a file through the reference that they did not already have.

## Plan

- [ ] Sharing links (SharePoint `/:x:/`, `1drv.ms`, `onedrive.live.com` with
      `authkey`/`resid`) are not kept; tests
- [ ] Library path and Office viewer link reduced to one form each; tests
- [ ] `sources` guidance for SharePoint; test that the schema says it
- [ ] End to end test (import and assistant)
- [ ] CHANGELOG
