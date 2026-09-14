# Proposal: handing the manager role over, or sharing it

**Status:** Proposal · **Serves:** Managers in control ·
**Rough size:** Medium — one gated write path, three operations, two surfaces,
and a check against what the outgoing manager still provides ·
**Issue:** [#86](https://github.com/StatsLateral/teamctx/issues/86)
· **Unblocks:** [#87](https://github.com/StatsLateral/teamctx/issues/87) (the handoff recipe)

## Problem

The manager is whoever ran `init`, and nothing can change that afterwards. That
is deliberate: `managerKey` is kept off the writable config keys, because a
caller who can write the gate can grant themselves approval (#49).

So two ordinary situations have no path at all.

- **Handoff.** Someone builds a project for a client and wants the client's own
  lead to run it. The builder steps out; the client approves from then on.
- **Co-manager.** A second person should also be able to approve — to cover
  leave, to split the load, or to approve alongside an advisor who stays on
  part-time.

The code is already half-way there. `managerKeys(config)` reads a list of
identities and `canApprove` passes a caller who matches any of them. Nothing
writes to that list. Repair (#74) writes it, but only to empty it.

## How the gate works today

Worth stating exactly, because this proposal changes who can write it and the
details decide what is safe.

- **Storage.** `managerKey`, a single identity written at `init`, and
  `managerKeys`, a list. `managerKeys()` merges the two and removes duplicates,
  so either can hold the gate.
- **Matching.** `matchesActor` accepts three forms and no others:
  - `github:<numeric id>` — matches a GitHub caller's key.
  - `git:<email>` — matches a clone's key, and also any caller whose verified
    email is that address, which is what lets one person pass from a clone, a
    GitHub sign-in and a Google sign-in alike.
  - `@<login>` — matches a caller whose GitHub login is that name.
- **Not accepted:** a display name, ever. And not `github:<login>` — which is
  the shape `member add` stores for a member added by username. A co-manager
  written in that shape would match nobody.
- **Where the gate is consulted.** Approvals, rejections, snapshots, setting the
  review policy, member changes — and, on the hosted settings page, lending the
  project's GitHub credential (`lendDecision`).

## What changes

### 1. One gated write path, not a config key

A new core, `manager.core.js`, beside `setReviewPolicy` and `repairManagerGate`.
Every operation opens with `assertManager` against the resolved caller — so only
somebody who can already pass the gate can change it, which is the property #49
protects. `managerKey` stays off `WRITABLE`.

Three operations:

- **`add <ref>`** — puts another identity on the gate.
- **`remove <ref>`** — takes one off. Removing yourself is stepping down.
- **`transfer <ref>`** — `add` then removing the caller, in one commit, so there
  is no moment with the old manager gone and the new one not yet written.

Surfaces: `teamctx manager list | add | remove | transfer`, and MCP tools
`manager_add`, `manager_remove`, `manager_transfer`. `teamctx config manager`
keeps working as the read-only view it is today; it already lists every key.
`get_status` reports only the first manager, and should report all of them.

### 2. What `<ref>` becomes

The same shapes `member add` takes — a GitHub username or an email address,
told apart by shape — but written in the forms the gate can actually match.

- An email becomes `git:<email>`. This is the one identity every surface
  matches.
- A username becomes `@<login>`. It works for a GitHub sign-in and nothing
  else: a clone knows its user by email and has no login to compare.

The person does not have to be on the roster. The manager is not on their own
roster today, and the hosted access path already recognises a manager before it
looks at the roster at all.

### 3. The rules that keep it safe

- **Never zero managers.** `remove` and `transfer` refuse to leave the gate
  empty. An empty gate is not a locked project — `canApprove` treats it as *no
  gate*, and lets anyone approve.
- **Never an unmatchable gate.** A ref that parses to neither form is refused,
  rather than written as a key nobody can present — which is the failure repair
  exists to clean up.
- **A transfer must name an email address.** A transfer removes the only person
  who could fix a mistake. An `@login` manager cannot approve from a clone, and
  there is no path back through the tool once the old manager is gone.
  Co-managers may be either form, because the person adding them is still there.

### 4. What the outgoing manager is still providing

The issue decided that the API key is not handed off: the builder's key stays
the builder's. Looking at where keys actually come from, that decision has more
reach than it first appears.

- **On a clone** nothing is shared. Each clone reads its own `.env.local`, so a
  new manager uses their own key and the old manager's is never involved.
- **On the hosted server** two things belong to a *person*, not the project:
  - the project's **shared AI key**, stored with `sharedById` — members without
    a key of their own run on it;
  - the project's **lent GitHub credential**, stored with `lentById` — every
    member who signed in with Google reaches the project through it.

  Only the person who put either one there can take it away. If the builder
  steps out and later withdraws them — or their GitHub token is revoked — the
  project loses its model for keyless members, and loses Google members
  entirely.

So the check that matters is not "does the incoming manager have a key" — which
the outgoing manager's request has no way to see — but **"does this project
still run on the outgoing manager"**. Hosted, `remove` and `transfer` read both
records and refuse to let a manager step out while either is still theirs, and
say which one to hand over first.

### 5. A Google-only manager

The issue asks whether somebody with no GitHub account can be promoted. They
can: nothing in the approval path checks how a caller signed in, and
`git:<email>` matches a Google sign-in.

What they cannot do is *take over* a project alone. A per-person AI key is
stored against a GitHub id, and lending a GitHub credential needs a GitHub
token. A Google-only manager has neither, so their access and their model both
run on whatever someone else lent and shared. The rule in section 4 makes that
visible instead of letting it fail later: a builder handing over to a Google-only
manager is told they cannot step out while the project still runs on them.

### 6. Repair stays separate

Repair (#74) fires on a gate *nobody* can pass, and admits the project's creator
by the repository history. This fires on a gate somebody *can* pass, and admits
whoever passes it. Different trigger, different authority — sharing them would
put one authority's shortcut behind the other's check.

What they share is the write: one helper that keeps `managerKey` and
`managerKeys` consistent, so both paths leave the file in the same shape.

### 7. The audit trail

Every change is its own commit, attributed to the caller, naming what changed:
`manager: add a@b.com by Maya`, `manager: transfer to a@b.com by Maya`. The same
attribution `member add` uses, so it shows against the right GitHub profile.

## Decisions taken here

- Written through its own core, never `config_set`.
- Email becomes `git:<email>`, username becomes `@<login>`, and `github:<login>`
  is never written.
- No roster requirement.
- Never zero managers, never an unmatchable key.
- A transfer needs an email address; a co-manager does not.
- Repair stays a separate command and shares only the write.

## Open questions

1. **The prerequisite check.** The issue asks that the incoming manager have a
   working key before a transfer completes. That is not checkable from the
   outgoing manager's request: on a clone the key is on someone else's machine,
   and hosted it is stored against a GitHub id the transfer does not know. This
   proposal checks the other side instead — that the project no longer runs on
   the outgoing manager. Is that the intent?
2. **A transfer run from a clone.** A clone cannot read the hosted shared key or
   lent credential, so the check in section 4 cannot run there. Either refuse a
   step-out from a clone when the project records a `deployUrl`, and point at the
   connector — or allow it and say plainly that hosted members were not checked.

## Verification

- Only a current manager can add, remove or transfer, on both surfaces.
- An email is stored as `git:<email>` and passes on a clone, a GitHub sign-in and
  a Google sign-in. A username is stored as `@<login>` and passes a GitHub sign-in.
- A ref that is neither is refused, and nothing is written.
- `remove` and `transfer` refuse to leave the gate empty.
- A transfer to a username is refused.
- Hosted, stepping out is refused while the shared AI key or the lent GitHub
  credential is still the outgoing manager's, and the refusal names which.
- A co-manager can approve, and can lend the project's GitHub credential.
- Every change is one attributed commit.
- Repair behaves exactly as before.
