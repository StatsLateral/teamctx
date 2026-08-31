# Proposal: project members

**Status:** Proposal (suggestion, not committed) · **Serves:** Managers in control ·
**Rough size:** Small–Medium — phases 1 and 2 are contained; phase 3 is deferred

## Problem

A teamctx project has a manager and, implicitly, everyone with a git clone. It
has no idea who is on the team.

That shows up in three places. Contributions carry whatever `git config
user.name` says, so a name that has never been agreed becomes the record.
Task ownership is a free-text string, so `--owner "Bhumika"` and `--owner
"bhumika"` are two different people. And there is no way for a manager to say
"these five are on this project" — which is the first thing anyone setting up a
team wants to do.

Adding someone to a teamctx project today means telling them to clone the repo.

## Scope of this proposal

**Phase 1 — a members roster, and honest commit attribution.**
**Phase 2 — optionally inviting a member as a GitHub collaborator.**

**Phase 3 — members who are *not* GitHub collaborators — is deliberately out.**
It needs a project-level credential and changes teamctx's security posture; it
is discussed at the end so the decision is recorded, not so it is built.

## What the research settled

**A repo collaborator invite takes a GitHub username, never an email.**
[`PUT /repos/{owner}/{repo}/collaborators/{username}`](https://docs.github.com/en/rest/collaborators/collaborators)
accepts a handle only, and creates an invitation the person must accept. So an
email can never become a GitHub invite. It can only be a teamctx-side identity.

**`gh` already carries the scope needed.** `teamctx setup` shells out to `gh`,
and a normal `gh auth login` yields `repo` — which is what the collaborator
endpoint requires. The CLI path needs no new OAuth work at all.

**The hosted OAuth already requests `repo`** (`src/oauth/provider.test.js`
asserts it), so the hosted path has the scope too.

**Commit attribution is already reachable.** `src/adapters/github.js` builds
its commit as `{ message, tree, parents }`. The Git Data API also accepts
`author` and `committer` as *separate* fields. Setting `author` to the acting
person while the token supplies the committer is the whole of the attribution
problem, and it is a few lines rather than an architecture.

## Phase 1 — members and attribution

### The record

`config.json` gains a `members` array:

```json
{
  "key": "github:1001",
  "name": "Priya Raman",
  "login": "priyar",
  "email": null,
  "addedBy": "github:44",
  "addedAt": "2026-08-25"
}
```

`key` is the same actor key `src/actor.js` already produces — `github:<id>`,
`git:<email>` or `name:<me>`. Reusing it means a member joins up with the
contributions they have already made, and with the `authorKey` grouping that
`teamctx stats` uses. A new identity scheme would fragment both.

### Members are project-wide

Not per-workstream. Workstreams are a view over one context tree in one repo —
anyone who can read the repo can read every workstream, so per-workstream
membership would be a label that enforces nothing. If a real need for scoping
appears later it belongs with roles, which already bind to a workstream.

### Commands

```
teamctx member add <username|email> [--name "…"] [--invite]
teamctx member list
teamctx member rm <key|login|email>
```

**Manager-gated**, via the existing `assertManager` in `review.core.js`. The
roster is who a manager says is on the team; that is exactly the kind of thing
the gate exists for.

MCP: `list_members` (Tier 0), `member_add` and `member_rm` (Tier 2 — they are
gated and change who the project recognises).

### Attribution

`GithubSession.commit()` gains an `author` derived from the acting actor:

```js
author: { name: actor.name, email: emailFor(actor), date: new Date().toISOString() }
```

GitHub needs an email to attribute a commit to an account. For a member with a
`login` the `<id>+<login>@users.noreply.github.com` form is the right one — it
attributes correctly without exposing a private address. For a member added by
email, use it directly.

The local CLI needs nothing: git already records the committer from the clone's
own config.

## Phase 2 — inviting a collaborator

`teamctx member add <username> --invite` also calls the collaborator endpoint.

| Surface | How |
| --- | --- |
| CLI | `gh api -X PUT repos/{owner}/{repo}/collaborators/{login}` — `gh` is already a dependency of `setup` |
| Hosted MCP | the caller's OAuth token, which already carries `repo` |

Three things the implementation has to get right:

- **`--invite` requires a username.** A member added by email cannot be
  invited, and the command should say that rather than fail inside the API
  call.
- **The invite is asynchronous.** It creates an invitation the person must
  accept; the member is *not* a collaborator until they do. `member list`
  should report `invited` distinctly from `collaborator`.
- **Adding the member and inviting them are separate failures.** If the roster
  write succeeds and the invite fails — no `gh`, wrong scope, not an admin of
  the repo — the member should still be added, with the invite reported as
  failed. Rolling back a roster entry because GitHub was unavailable would be
  the wrong trade.

`member add` without `--invite` stays the default. Inviting someone to a
repository is a bigger act than noting them on a roster and should be asked
for.

## Phase 3 — members who have no GitHub account

Phase 1 and 2 assume a member is, or becomes, a GitHub collaborator. Most are
not going to be. GitHub is where a teamctx project is *stored*; it is not who
the people on it are, and a marketing lead invited to contribute context has no
reason to open a GitHub account to do it.

Three things stand between an email address and a contribution. Two are done.

| | Status |
| --- | --- |
| Attribution — whose name the commit carries | done (phase 1) |
| An AI key they can use | done — the project-shared key (#48), which this branch now builds on |
| Identity — proving they are that email | **this phase** |

### Identity: sign in with Google

An invite names an email. Anyone can type an email, so the invite proves
nothing on its own; the member has to prove the address is theirs.

Running that ourselves means a mail sender, deliverability, and a code-entry
flow — a lot of machinery to establish something Google already established.
Google's OAuth returns `email` together with `email_verified`, and a Google
account is a login this exact audience already has. So teamctx does not verify
emails. It accepts a verification someone else already did.

**The rule: a member is authenticated when a verified Google email matches a
roster entry.** Both halves are load-bearing. Without `email_verified` a Google
account with an unconfirmed address could claim anyone's invite; without the
roster check, any Google account in the world is a member of every project.

`/authorize` stops redirecting straight to GitHub and asks which account the
person has. GitHub keeps the path it has today. Google is new, and carries no
GitHub token at all — which is the whole point, and also the problem the next
section solves.

### Access: the project lends its own GitHub credential

A Google member has no GitHub token, so there is no session to build from — a
private repo cannot be read, let alone written.

The manager stores a credential against the project, and calls from members who
have none of their own run on it. This is the same shape as the shared AI key
(#48) and should read the same way: a project-level credential, used by anyone
on the project who cannot bring their own.

Three properties this must have, because it is the piece that carries real
authority:

- **Pinned to one repository.** The credential is stored under
  `owner/repo` and looked up by the `owner/repo` in the request URL, so it can
  only ever serve the project it was stored for. This matters more than it
  looks: `api/mcp/[owner]/[repo].js` takes owner and repo from the URL and never
  checks access, because today every call runs on the caller's own token and
  GitHub simply 404s them. A shared credential removes that accident of safety,
  so the pinning has to be deliberate.
- **The roster is the gate.** Before the credential is used, the member's
  verified email must appear in `config.json`'s `members`. Reading that needs
  the credential, so the order is: look up credential → read config → check
  roster → only then serve the request.
- **Members still cannot approve.** `assertManager` compares the resolved actor
  against `managerKey`, and a Google member's actor is their roster entry, never
  the manager's. Contributions queue for review exactly as they do today.

The honest cost, stated plainly: the manager's write access is exercised on
behalf of other people. That is not a side effect to be minimised — it is the
feature. The manager invited these people precisely so they could contribute,
and the alternative is that they cannot contribute at all.

### What a member can then do

Everything the MCP surface offers except approving: read context, see and
compile their tasks, and submit contributions that queue for the manager's
review — attributed to their own name, paid for by the project's key, written
with the project's credential. No GitHub account anywhere in that sentence.

## Out of scope

- Per-workstream membership (see above).
- Removing a GitHub collaborator. `member rm` takes someone off the roster; it
  does not touch repo access, and conflating the two would make a bookkeeping
  command destructive.
- Roles. A member is a person; a role is a lens on the context. They are
  different things and joining them would make both harder to change.

## Where to start

- `cli/commands/review.core.js` — `assertManager`, and the typed-error pattern
- `cli/commands/task.core.js` — the most recent core/presentation split
- `src/actor.js` — actor keys, which members reuse rather than replace
- `src/adapters/github.js:197` — the commit payload that gains `author`
- `mcp/hosted-isolation.test.js` — where attribution under a session is proved

## Open questions

- **Answered by phase 3: an email-only member is a full contributor.** They
  sign in with Google, act on the project's credential, and their work queues
  for review under their own name. What they cannot do is approve it.
- **Should `member add` warn when the login is not a collaborator and
  `--invite` was not passed?** It is the common mistake, and silence makes it
  look like access was granted when it was not.
