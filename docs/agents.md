# Agents: jobs that run with nobody present

An agent is a job — a cron script, a scheduled workflow, an agent built on any
MCP client — that reaches a project through the hosted connector with a token a
manager issued. It needs no browser sign-in and no GitHub account.

It can do three things: read what it is assigned, send work back for review, and
close its own tasks. Nothing else.

This is for the hosted connector. A job that holds a clone of the repository
already has what it needs: `teamctx contribute` with the clone's push access.

## Before you start

- **You are a manager of the project.** Only a manager can issue or revoke an
  agent.
- **The project lends GitHub access.** An agent reads the project through it. On
  the deployment's **Settings** page: **Let members join without GitHub → Lend
  GitHub access**.
- **The project has something written down.** An agent with nothing to read is
  refused, as a person would be.
- **The primary manager has added a project key.** An agent has no AI key of its
  own; each contribution it sends spends one AI call on that key.

## 1. Create the agent

On the **Settings** page, under **Agents**:

1. Pick the project.
2. Give the agent a name — `Nightly report`. It cannot be a name already on the
   project, because tasks are found by name.
3. Optionally, list the workstreams it may reach. Leave it empty for the whole
   project.
4. **Create agent.**

The page shows the agent's **token** and the **connector URL**. Copy the token
now: it is shown once and cannot be read back. Keep it wherever your job keeps
secrets.

Creating an agent adds it to the project's member list, marked as an agent, in a
commit — so the rest of the team can see it exists.

## 2. Give it work

Assign it tasks the way you would anyone, by its name:

```
teamctx task add "Summarise yesterday's signups" --owner "Nightly report"
```

## 3. Point the job at the connector

Every request carries the token:

```
Authorization: Bearer tctx_agent_…
```

**From an MCP client or agent SDK:** add the connector URL as a remote MCP server
with that header. The client asks the server for its tools and finds exactly
three, with instructions for an unattended run.

**From a plain script:** send JSON-RPC to the connector URL.

```bash
curl -s -X POST "$TEAMCTX_URL" \
  -H "Authorization: Bearer $TEAMCTX_AGENT_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"my_brief","arguments":{}}}'
```

No handshake is needed first. The answer comes back as a server-sent event: the
JSON-RPC response is on the line that starts with `data:`.

## What an agent can call

| Tool | What it does |
|------|--------------|
| `my_brief` | Its open tasks and the context behind them. No AI call. |
| `contribute` | Sends its work to the project. Takes `text`, and optionally `workstream` and `decision`. |
| `task_done` | Closes a task, by id. Only its own. |

Any other tool name is answered as a tool that does not exist.

## The rules it runs under

- **Its work always waits for review**, whatever the project's review policy. A
  manager approves it the usual way.
- **It writes as itself.** Its contributions carry its name.
- **20 contributions a day**, counted per UTC day. Past that, `contribute`
  refuses and says when it resets.
- **Its own tasks only**, for `task_done`.
- **Its workstreams only**, if it was given some.
- **It is never a manager**, and cannot approve, add people, or change settings.

## Revoking

On the **Settings** page, **Revoke** beside the agent. The token stops working on
its next request, and the agent comes off the member list.

A token also stops working if:

- the agent is removed from the member list some other way;
- the project stops lending GitHub access.

## When a request is refused

| Answer | Meaning |
|--------|---------|
| `401` — not valid for this project, or revoked | Wrong project in the URL, or the token was revoked. Issue a new one. |
| `401` — no longer lends GitHub access | A manager needs to lend it again. |
| `no longer on the project` | The agent was taken off the member list. Issue a new one. |
| `daily limit` | Wait until the time given. |
| `not assigned to this agent` | `task_done` on somebody else's task. |
| `Unknown tool` | A tool an agent cannot call. |
