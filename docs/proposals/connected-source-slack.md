# Proposal: Slack as a connected source

**Status:** Proposed · **Issue:** [#169](https://github.com/StatsLateral/teamctx/issues/169)
· **Base:** `feat/connected-sources` (#168, PR #185)

## What the issue asks

A Slack thread that reaches the project shows in the Connected sources drawer
under Slack, with its link, summary, date and the tasks it feeds, for people
who may see those tasks. It arrives either through the person's assistant (its
own Slack connector; teamctx holds no Slack credential) or through the shipped
importer (`src/connectors/slack.js`, #22). Only a link, title, summary and date
are kept: never messages, never a credential.

## Already on this branch

- `fetch` returns the thread's permalink, built from the workspace address
  `auth.test` gives once per run.
- It returns a title of its own, "#channel thread, YYYY-MM-DD", because the
  document's title is the thread's first message, and a reference must not
  quote it.
- `teamctx import --from slack` records each thread under Slack. An end-to-end
  test checks that neither the messages nor the token are written.
- Reused: the shipped importer for auth, listing and fetching. The Activepieces
  and Onyx Slack connectors were not needed: the reference is built from what
  the importer already read, and the assistant route needs no client at all.

## What is left

1. **One thread, one reference.** The same thread arrives under different
   links, so it is recorded twice today:
   - the importer gives `…/archives/C123/p1700000000000100`
   - Slack's "Copy link" on the parent adds `?thread_ts=…&cid=C123`
   - a link to a reply is `…/p<reply ts>?thread_ts=<parent ts>`

   A Slack link is reduced to the thread's own permalink (workspace, channel,
   and the parent's `p<ts>`) before its id is taken, for both routes. A link
   that isn't a Slack message link is left as it is.
2. **The assistant route says what to pass.** The `sources` description and
   the connector instructions ask, for Slack, for the thread's link and a title
   naming the channel or topic, not a quoted message.
3. **The tasks it feeds.** A reference names a task only when the work was sent
   with `forTask`, which arrives with #144 (PR #184). Once that merges, the
   `forTask` path records its sources with the task number. Until then a Slack
   reference names the part of the work it feeds.

## Plan

- [ ] Slack link to thread permalink, used for the id and the stored link; tests
      for parent, "Copy link", reply and non-Slack links
- [ ] `sources` guidance for Slack; test that the schema says it
- [ ] After #184: record sources on the `forTask` path, with the task
- [ ] CHANGELOG
