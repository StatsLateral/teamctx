# Proposal: tell the manager in Slack when something is waiting

**Status:** Implemented · **Issue:** [#182](https://github.com/StatsLateral/teamctx/issues/182)
· **Base:** `main`

## Why

A manager learns something is waiting only by opening the page or asking their
assistant. Where they already are is Slack. Approving stays in the assistant;
this only says there is something to approve.

## What it does

When an item is queued for review, one message goes to a Slack incoming webhook
the manager has set:

> Waiting for your approval: **3.2** Submitted: pricing draft — from Priya
> Open it: https://…/project/acme/shop?review=mcp-…

- The item number (when it has one), who sent it, its one-line summary, and the
  link that opens its drawer. Nothing else: never the contribution's text.
- Both ways an item is queued: a contribution that needs review, and a task's
  work sent with `task_submit` / `teamctx task submit`. Nothing for anything
  applied straight away.
- Sent after the queue item is committed, so it never announces an item that
  was not written. A post that fails or takes longer than 3 seconds is logged
  (without the URL) and skipped; the contribution's result is unchanged.

## Where the webhook URL lives

It is a credential: anyone holding it can post to that channel.

- **Hosted:** in the deployment's store beside the project's AI keys, under the
  project (`teamctx:slack:project:<owner>/<repo>`). Set and cleared in Settings,
  by a manager of that project only. The page says whether one is set, by whom
  and when, never the URL itself.
- **Command line:** the `TEAMCTX_SLACK_WEBHOOK` environment variable (or
  `.env.local`), read on the sender's machine, so it covers only people who have
  it set. A notice goes out once the item is pushed: the link opens the hosted
  page, which does not have an unpushed item. An import sends one notice for the
  whole run.
- Never written to the repository, a log line, a commit message or a page.
- Only `https://hooks.slack.com/…` is accepted, so the setting cannot be used to
  make the server post to anywhere else.
- Settings says what leaves teamctx: the number, the sender, the summary and the
  link, never the text.

## Reused

- The link: `buildViewUrl` with `review: <id>`, the drawer link the tools
  already return.
- The manager check: the gate matching in the agents' access check
  (`agentManagerAccess`), moved into a function Settings can use for this too.
- The store: `kv.js`, like the project's AI keys.

`@slack/webhook` was considered: it is a wrapper around one HTTPS POST that
brings in `axios`. A plain `fetch` does the same with no dependency. The Slack
reader in `src/connectors/slack.js` is for importing and is not reused.

## Code

- `src/slack-notify.js`: `slackMessage({ number, author, summary, link })`,
  `isSlackWebhook(url)`, `postToSlack(url, message, { fetchImpl, timeoutMs })`
  (never throws), `slackWebhookFor({ env })` (the store when hosted, the
  environment otherwise), `announceQueued(item, { baseUrl, … })`.
- `contributeCore` and `submitTask` call `announceQueued` after the commit.
- `api/oauth-server.js`: `POST /settings/slack` (set or clear), manager only.
- `src/views/settings.js`: a "Slack" card.

## Tests

One post per queued item and none for an applied one; the message holds only the
listed fields; a failing or hanging webhook does not fail the contribution and
logs no URL; the URL is in no commit, queue file or page; only a manager can set
or clear it; a non-Slack URL is refused.

## Plan

- [x] `src/slack-notify.js`; tests
- [x] Post when a contribution or a task's work is queued; tests
- [x] Set and clear in Settings, manager only; tests
- [x] README, CHANGELOG
