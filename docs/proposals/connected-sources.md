# Proposal: connected sources

**Status:** In progress · **Issue:** [#168](https://github.com/StatsLateral/teamctx/issues/168)
(the base for #169–#174, one per tool) · **Base:** `main`

## What the issue asks

The Settings **Connected sources** drawer shows sample data. Make it real: when
what an assistant read in Slack, Notion, Google Drive, SharePoint, Dropbox or
Coda reaches the project, leave a trace the manager can see — which tool, which
item, when, who brought it, and what it feeds. Links and short summaries only:
never file contents, never credentials. Stored in the team's own repository.

## Design

### The record

One file per item, `.teamctx/sources/<id>.json`, so two people recording at once
never touch the same line:

```
{ id, connector, title, link, summary, by: { name, key }, firstReadAt, lastReadAt,
  feeds: [{ workstream, contribution, task? }], via: 'assistant' | 'import' }
```

- `id` is a hash of the connector and the link (or the tool's own item id), so
  the same item read again updates its record: `lastReadAt`, title and summary
  refresh, and what it feeds is added to, never duplicated.
- `connector` is one of `slack`, `notion`, `gdrive`, `m365`, `dropbox`, `coda`,
  or `other`.
- **Nothing that could carry a secret or a body is kept:**
  - there is no field for contents
  - a title is cut to 200 characters and a summary to 400
  - a link must be `http(s)`, and any query parameter that looks like a token
    (`token`, `key`, `secret`, `sig`, `code`, `auth`, `password`, …) is removed
    before it is written

### How a reference gets there

1. **Through the assistant.** `contribute` (people and agents) takes an
   optional `sources: [{ connector, title, link, summary }]`, for what the
   assistant read to write the contribution. Recorded as the contribution is
   logged, feeding its workstream (and its task, for work sent with
   `forTask`). teamctx holds no credential for the tool.
2. **Through `teamctx import`.** Each imported document leaves a reference for
   its connector, with the document's title, the link when the connector
   returns one (`url`), and the contribution's summary.

   The per-tool issues (#169–#174) make each connector return its item's link;
   this issue records whatever it gives.

### Who sees what

A reference is shown only for the parts of the work a reader can see:
- feeds outside their scope are dropped
- a reference with none left is not shown
- project-level feeds are visible to everyone with access

### The drawer

- Real references, grouped by tool as the sample is.
- Each item: title (linked), when it was last read, who brought it, and the
  parts of the work and tasks it feeds.
- The Settings link shows the real count.
- With none, it says plainly that nothing is connected, and keeps the sample
  below, still labelled as sample.

## Existing open source first

- **Route 1** needs no library: the assistant already holds the tool's
  connector.
- **Route 2** records references inside the importers that already exist; it
  adds no new way of talking to the tools.
- **Deferred to the per-tool issues:** the Activepieces/Onyx spike the issue
  suggests is about replacing those hand-written importers. That is real work
  in its own right, and recording a reference does not depend on it.

## Plan

- [ ] `src/sources.js`: the record, its clean-up (no secret, no body), upsert, and scope
- [ ] Route 1: `sources` on `contribute` (people and agents)
- [ ] Route 2: `teamctx import` records a reference per document
- [ ] Page data and the drawer; the Settings count
- [ ] Tests: shape, scope, no secret or file body ever written; CHANGELOG
