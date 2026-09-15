# Proposal: a token for an unattended agent on the hosted connector

**Status:** Proposal · **Serves:** Bring your own tools · Managers in control ·
**Rough size:** Medium — a token record, one branch in the hosted endpoint, a
per-caller tool list, and a Settings section ·
**Issue:** [#92](https://github.com/StatsLateral/teamctx/issues/92)
· **Builds on:** [#86](https://github.com/StatsLateral/teamctx/issues/86) (the
project runs on the primary manager's key)

## Problem

A team member wants a job that runs every morning with no person present: it
reads what it has been asked to do, produces something, and sends the result to
the project for review. The hosted connector only lets in a person who signed in
through a browser, so there is no way to run that job through it.

Two things are missing, not one:

- **A credential that needs no browser.** A person's sign-in expires — an access
  token after an hour, a refresh token after 90 days — and belongs to that
  person.
- **A caller that is not a person.** Whatever the job holds today, it acts as
  whoever it borrowed the credential from: their name on its contributions,
  their manager rights if they have them, every tool the connector offers.

## How it works today

Stated exactly, because the details decide what is safe.

- **Who is calling.** The hosted endpoint (`api/mcp/[owner]/[repo].js`) accepts
  an OAuth bearer token — GitHub, or Google through the project's lent GitHub
  access — and turns it into an actor.
- **A route no document mentions.** The same endpoint also accepts an
  `x-github-token` header, plus `x-api-key`, with no sign-in. A job holding a
  GitHub personal access token can already call every tool, as the person who
  owns that token. It needs a GitHub account and carries that person's rights.
- **Every caller sees every tool.** `tools/list` returns the same fixed list to
  everyone, and `tools/call` dispatches any name on it. Limits live inside the
  handlers: the manager gate, and a member's workstream scope.
- **Contributions do not always wait for review.** The review policy decides. A
  new project starts on `additive`, which writes an add-only contribution
  straight into the shared context; `none` writes everything.
- **An AI call is spent on the primary manager's key** when the caller has none
  of their own (#86). `contribute` spends one to turn text into changes.
- **Anyone may mark any task done.** `task_done` checks the caller's workstream
  scope, not who owns the task.

## What we are building

### 1. An agent token, issued by a manager

A manager creates a token for one agent on one project, on the deployment's
**Settings** page. It is shown once. The server stores only its hash, with:

- the project (`owner/repo`) and the agent's name;
- the workstreams it may reach, or the whole project;
- who issued it, when, and when it was last used.

A manager can list a project's agents and revoke one. Revoking takes effect on
the next request.

Issued in the browser, not through an MCP tool: a token returned by a tool lands
in an AI conversation's transcript, which is the wrong place for a secret.

### 2. The agent is its own identity

The endpoint recognises an agent token before it tries OAuth. The agent's actor
is `agent:<id>`, with its name, and `source: 'agent'`.

- **It is never a manager.** `agent:` matches no manager identity, and nothing
  can add one to the managers.
- **It reads the repository through the project's lent GitHub access**, the way
  a member without GitHub does. A project that has not lent access cannot issue
  agent tokens, and the Settings page says so.
- **It runs on the primary manager's project key.** An agent has no key of its
  own.
- **Its work is attributed to it.** Contributions and commits carry the agent's
  name, marked as an agent.

The agent is also written onto the roster in `config.json`, marked as an agent,
with its workstreams. That puts every agent on a project in the repository's own
history, and lets the existing scope check — `scopeFor`, which reads the roster —
apply to it unchanged. The token itself never touches the repository.

### 3. An agent sees and can call only its own tools

This answers two questions: how an agent is restrained, and how it knows what it
may do.

**How it knows.** An MCP client learns its tools from `tools/list`; there is no
other channel. For an agent token that list holds only the agent tools, and the
connector's `instructions` are replaced with a short agent version — read your
brief, do the work, send it back. An agent built on any MCP client discovers
exactly what it may do, and never sees a tool it would be refused.

**How it is held to it.** Hiding a tool is not a restriction — a script can send
any name to `tools/call`. The server checks every call against the same list and
answers a name that is not on it exactly as it answers a tool that does not
exist.

**The tools.** Only what it takes to get work and send it back:

| Tool | Why an agent needs it |
|------|-----------------------|
| `my_brief` | What it is assigned and the context behind it, in one read. Spends no AI call. |
| `contribute` | Sends its output to the project. Always for review — section 4. |
| `task_done` | Closes a task it finished. Only its own — section 4. |

A manager gives an agent work the way they give anyone work: `task_assign` to
the agent's name, which `my_brief` already matches.

**Left out, and why:**

- **`ask`, `task_compile`, `task_add` with `compile`, `suggest_*`,
  `propose_structure`, `reflect`** — each spends an AI call on the primary
  manager's key. An unattended job that loops or misfires would spend it without
  anyone watching. `my_brief` already carries the context.
- **`get_context`, `get_workstream`, `list_tasks`, `get_task`, `get_status`,
  `get_config`** — reads that `my_brief` already covers for its own work, or that
  describe the project rather than the job.
- **`task_add`, `task_assign`, `task_reopen`, `task_rm`** — deciding what the work
  is stays with people.
- **`submit_contribution`** — the deprecated alias writes immediately.
- **Every review, manager, member, role, workstream, snapshot and config tool** —
  an agent approves nothing and changes nobody's rights.

### 4. Tighter rules for an agent than for a person

- **Its contributions always wait for review**, whatever the project's review
  policy. `additive` trusts a person to add without asking; an unattended job has
  earned no such trust. `apply` is refused, as it already is for any non-manager.
- **It can mark done only a task it owns.**
- **`author` is ignored.** A person's script may set an author on purpose; an
  agent writes as itself.
- **A daily limit on contributions** per token, because each spends an AI call on
  the primary manager's key. Past the limit, `contribute` refuses until the next
  day and says when.

### 5. Settings page

A section on the deployment's **Settings** page, for managers of a project:

- create an agent — name, workstreams — and copy its token, shown once;
- the project's agents, each with who issued it and when it was last used;
- revoke.

### 6. Documentation

A short guide: create the token, then point a job at the connector URL with
`Authorization: Bearer <token>` — from an agent built on an MCP client, or a
plain script sending `tools/call`. It names the three tools and the review rule.

## Decisions

Recorded here so the commits and the pull request can cite them.

1. An agent holds a manager-issued, revocable token; only its hash is stored.
2. An agent is its own identity, `agent:<id>`, and is never a manager.
3. An agent reads the repository through the project's lent GitHub access.
4. An agent runs on the primary manager's project key.
5. An agent is recorded on the roster, marked as an agent, so the scope check
   and the repository's history cover it.
6. An agent sees only its own tools in `tools/list`, with agent-specific
   instructions, and any other tool call is answered as unknown.
7. The agent tools are `my_brief`, `contribute` and `task_done`.
8. An agent's contributions always wait for review, whatever the policy.
9. An agent can mark done only its own tasks, and cannot set an author.
10. Tokens are issued on the Settings page, never returned by an MCP tool.
11. Tokens last until revoked, and show when they were last used.
12. Each token has a daily limit of 20 contributions.
13. An agent's name cannot be one already on the roster. `my_brief` finds a
    caller's tasks by name as well as by identity, so an agent named after a
    person would be handed that person's work.
14. A token whose agent is no longer on the roster is refused. Without the entry
    there is no scope to hold it to, and an agent with no scope would reach the
    whole project.
15. An agent request ignores the `x-github-token` and `x-api-key` headers. It
    reads through the lent access and runs on the primary manager's key, nothing
    it brings.

## Out of scope

- **Agents on a clone.** A job with a clone already has a credential — the git
  push access that `teamctx contribute` uses.
- **The `x-github-token` header route.** Unchanged; it acts as the person who
  owns the token. Whether it should stay undocumented is a separate question.
- **Agents that plan work** — adding, assigning or compiling tasks.

## Verification

- A request with an agent token lists exactly the agent tools, and receives the
  agent instructions.
- Any other tool, called by name, is answered as unknown and changes nothing.
- A contribution from an agent is queued under `additive` and `none`, and never
  applies.
- An agent cannot mark done a task it does not own, and `author` does not change
  its attribution.
- An agent scoped to a workstream is refused another, the way a member is.
- A revoked token is refused on its next request.
- A project with no lent GitHub access cannot issue a token.
- Past the daily limit, `contribute` refuses and says when it resets.
- Only a manager can create, list or revoke an agent.
- Person sign-ins see the full tool list, unchanged.
