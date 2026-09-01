# Proposal: the invited member's first run

**Status:** Proposal (suggestion, not committed) · **Serves:** Managers in control ·
**Rough size:** Small — one command, one guide, tests around a path that had none

## Problem

Hosted MCP (#17) was built and verified for the manager setting up their own
project. The other half of it — someone *else* joining a project that already
exists — had never been run end to end until it was tried live on a
2026-08-24 call, by the person who wrote the hosted path:

> "I have not tested the [OAuth] with this flow, so I am not sure how it'll work."

It worked. But three things made it harder than it should be (#44):

1. **Finding the connector URL.** There is no way to ask teamctx what it is.
   The manager has to know that it is their deploy URL, plus `/api/mcp/`, plus
   the owner and repo — and then type it into a chat by hand.
2. **Disconnecting an old connector** before adding the new project's one.
3. **The OAuth step for a non-owner collaborator**, which nothing covered.

Underneath all three is the same thing: the first time anyone walked this path
was in front of a client. That is the part worth fixing — not because the steps
are many, but because nothing recorded what they were.

## What exists today

Both halves of the answer are already in the repo, and nothing joins them:

| Piece | Where |
| --- | --- |
| `deployUrl` — the deployment's origin | `config.json`, set at `init` or via `teamctx config deploy-url` |
| owner / repo | read from `git remote get-url origin` (`cli/commands/member.js:31`) |

The connector URL is `${deployUrl}/api/mcp/${owner}/${repo}`. Every input is
present. No code builds it, so a human does, from memory, under time pressure.

## Scope

**In:** a command that prints the connector URL and what to do with it; a
written join path for the invited member; tests over URL construction and the
non-owner authorization path.

**Out:** `teamctx doctor` (the manager's *local* first run — a separate Next
item), and any change to the OAuth flow itself. This issue is about the steps
around it, not the handshake.

## Design

### `teamctx connect`

```
$ teamctx connect

  Connector URL for Ledger:

    https://team-context-xyz.vercel.app/api/mcp/acme/ledger

  Send this to anyone you have added to the project. In Claude:
  Settings → Connectors → Add custom connector → paste the URL.
  They will be asked to sign in; that is expected.
```

One command, because the manager is the person who has to hand the URL over,
and the moment they need it is the moment they are talking to the new member.

It refuses usefully rather than guessing. No `deployUrl` set is the common case
for a project that has only ever run locally, and the fix is one command:

```
  This project has no deploy URL recorded, so there is no connector to hand out.

  If the project is deployed:  teamctx config deploy-url https://<your-deployment>
  If it is not:                docs/mcp-hosted-setup.md
```

### Why a command and not just documentation

A document that says "your URL is your deploy URL plus /api/mcp plus owner
slash repo" is the same work moved onto the reader, and it goes stale the
moment a repo is renamed. Reading the remote means the answer stays right
without anyone maintaining it.

### The join guide

`docs/mcp-join.md`, written for the invited member rather than the manager —
including the two things that are not teamctx's to fix but are still what
people trip on: removing a previously-connected project's connector, and the
fact that being asked to authorize is normal rather than a sign of a problem.

The manager's guide gets one line pointing at it, so the person handing out the
URL knows what the other end will see.

## Tests

The URL is a string built from two sources, which is exactly the shape that
looks too simple to test and then ships wrong:

- builds `${deployUrl}/api/mcp/${owner}/${repo}` from config and remote
- tolerates a trailing slash on `deployUrl` (people paste it from a browser)
- accepts both `git@github.com:` and `https://` remotes
- strips `.git` from the remote
- fails with the fix, not a stack trace, when `deployUrl` is unset
- fails when the remote is not GitHub

## Commits

1. `feat: teamctx connect, so the connector URL is not assembled by hand`
2. `docs: the invited member's join path`
3. `docs: changelog entry`

## Open question

`member add --invite` could print the connector URL straight after inviting
someone — that is the single biggest reduction in steps, since it removes the
"now go find the URL" gap entirely. It is deliberately not in this proposal:
`member add` lives on `feat/project-members`, and stacking this on an unmerged
branch would cost #44 the thing that makes it worth doing now, which is that it
depends on nothing. Worth doing as a two-line follow-up once that lands.
