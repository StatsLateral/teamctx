# Proposal: handing the manager role over, or sharing it

**Status:** Proposal · **Serves:** Managers in control ·
**Rough size:** Large — a gated write path for managers, keys stored by email,
Google sign-in on the settings page, and a key check before promotion ·
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
  leave, to split the load, or alongside an advisor who stays on part-time.

The issue also decides that the API key is not handed off: the incoming manager
brings their own, so a client running the project does not depend on the
builder's key and the builder does not keep paying for the client's usage.

## How it works today

Stated exactly, because the details decide what is safe.

- **The gate.** `managerKey` holds one identity, written at `init`. `managerKeys`
  is a list that `managerKeys(config)` merges in, and nothing writes to it except
  repair (#74), which empties it.
- **Matching.** `matchesActor` accepts `github:<numeric id>`, `git:<email>` and
  `@<login>`. `git:<email>` matches any caller whose verified email is that
  address — a clone, a GitHub sign-in and a Google sign-in alike.
- **Where people sign in.** The **Connect** page, reached when connecting an AI
  client, offers Google and GitHub. The **settings page**, where keys are saved,
  offers only GitHub.
- **Keys on the hosted server.**
  - A personal key is stored against a **GitHub id** (`aiKey(githubUserId)`), and
    only a GitHub connection ever looks one up.
  - A project key is **one record per project**, stored with the sharer's GitHub
    id. The first person to share blocks everyone else, and sharing needs push
    access to the repository.
  - Lent GitHub access is one record per project, stored with the lender's GitHub
    id. Members who signed in with Google reach the project through it.
- **Keys on a clone.** Each clone reads its own `.env.local`. Nothing is shared.

So signing in with Google and with GitHub makes you the same person to the gate
and the roster, and two different people to everything saved against you.

## What we are building

### 1. Managers are identified by email

Every manager identity is written as `git:<email>`. It is the one form every
surface matches, so there is no case where a manager can approve from one place
and not another. A username or a GitHub id is refused as a manager.

Members are untouched. A member can already be added by email alone; a username
is only needed for the optional `--invite`, which sends a GitHub repository
invitation that GitHub's API accepts only by username.

### 2. One primary manager, and co-managers

- **Primary:** `managerKey`. The one whose project key the project runs on.
- **Co-managers:** `managerKeys`. They approve exactly as the primary does.

Existing projects need no migration: today's single `managerKey` is already the
primary, with no co-managers.

### 3. Three manager-only operations

A new core, `manager.core.js`, beside `setReviewPolicy` and `repairManagerGate`.
Each opens with `assertManager` against the resolved caller, so only somebody who
can already pass the gate can change it. `managerKey` stays off `WRITABLE`.

- **`add <email>`** — a co-manager.
- **`remove <email>`** — takes a co-manager off. Removing yourself is stepping down.
- **`transfer <email>`** — makes that person primary. The previous primary becomes
  a co-manager, or leaves with `--step-down`.

Surfaces: `teamctx manager list | add | remove | transfer`, and MCP tools
`manager_list`, `manager_add`, `manager_remove`, `manager_transfer`.

### 4. The rules

- **Never zero managers.** An empty gate is not a locked project — `canApprove`
  treats it as no gate, and lets anyone approve.
- **The primary cannot leave without a successor.** Removing the primary is
  refused; `transfer` is the way out.
- **Nobody becomes a manager without a working key** — section 7.
- **Nobody steps out while the project still runs on them** — section 8.

### 5. Keys stored by email

Every key record on the hosted server is keyed by the verified email of the
person it belongs to, not their GitHub id. Signing in with GitHub or with Google
reaches the same keys, because both carry the same verified address.

- **Personal key:** one per person, by email. A Google connection now looks one
  up as well as a GitHub connection.
- **Project keys:** a project holds **one key per person**, each stored with the
  email of whoever added it — replacing today's single record.

Existing records keyed by GitHub id are read as a fallback, so nothing saved
today stops working.

### 6. Anyone on the project can add a project key

The settings page gains **Continue with Google** beside GitHub, using the same
Google flow the Connect page already has.

Adding a project key is open to anyone **on the project** — a manager or a
roster member — not to any signed-in stranger. A GitHub user is checked as they
are today. A Google user is checked against the roster, read through the
project's lent GitHub access; a project that has not lent access cannot take keys
from Google users, and the page says so.

**Which key a request runs on:** the caller's own personal key first, as now.
Otherwise **the primary manager's project key**. Other people's project keys are
stored but not used unless that person becomes primary — which is what makes a
handoff a matter of changing who is primary, rather than moving a secret.

### 7. The key check before becoming a manager

Before `add` or `transfer` completes, the person being promoted must have added a
project key, and that key is tested with the provider's **list-models** endpoint.
It confirms the key works and spends no tokens. A missing or failing key refuses
the promotion and says which.

The result is written into the commit that changes the gate.

### 8. Nobody steps out while the project still runs on them

Lent GitHub access still belongs to one person, and only someone signed in with
GitHub can lend it — people without a GitHub sign-in skip it entirely.

A manager cannot step down, or transfer with `--step-down`, while the project's
lent GitHub access is still theirs. The refusal says to lend it from another
account first. Their project key is no longer an obstacle, because the project
runs on the primary's key and they are no longer primary.

### 9. The terminal

A clone cannot read the hosted store, so it cannot run the key check or see who
lent access.

- **A project with a `deployUrl`:** manager changes are refused in the terminal,
  and it points at the connector, where the checks can run.
- **A project with no `deployUrl`:** there are no hosted keys to check. The
  terminal lists what it cannot verify and asks to confirm, and requires `--yes`
  when not interactive.

### 10. Repair stays separate

Repair (#74) fires on a gate *nobody* can pass, and admits the project's creator
by repository history. This fires on a gate somebody *can* pass, and admits
whoever passes it. They share only the write, one helper that keeps `managerKey`
and `managerKeys` consistent.

### 11. The audit trail

Every change is one commit attributed to the caller, naming the change and the
key check: `manager: transfer to a@b.com by Maya (key verified)`.

## Decisions

Recorded here so the commits and the pull request can cite them.

1. Managers are identified by email only, as `git:<email>`.
2. One primary manager (`managerKey`) and any number of co-managers (`managerKeys`).
3. Manager changes go through their own gated core, never `config_set`.
4. Never zero managers; the primary cannot leave without naming a successor.
5. Members are unchanged; a username is only for GitHub repository invites.
6. Hosted keys are stored by verified email, with the GitHub-id records read as a
   fallback.
7. A project holds one project key per person, recording who added it.
8. Anyone on the project may add a project key; the settings page gains Google
   sign-in.
9. A request runs on the caller's own key, then the primary manager's project key.
10. Promotion requires a project key that passes a free list-models check.
11. Lent GitHub access stays GitHub-only; a manager cannot step out while it is theirs.
12. On a deployed project, manager changes happen through the connector.
13. Repair stays a separate command.
14. Every change is one attributed commit that records the key check.
15. Lending records the lender's address. An older lent record that cannot say
    who lent it refuses a step-out, with the fix: lend it again to record it.
16. A manager recorded before managers were identified by email is matched by
    GitHub id or login in the step-out check, so they cannot slip past it.
17. The primary manager cannot remove the key the project runs on until they
    have handed the primary role over.

## Out of scope

- Storing preferences — active workstream, display name — by email. A person
  signing in both ways still keeps two sets. The handoff does not depend on it.

## Verification

- Only a current manager can add, remove or transfer, on both surfaces.
- A manager written by email approves from a clone, a GitHub sign-in and a
  Google sign-in. A username or GitHub id is refused as a manager.
- The gate is never left empty, and the primary cannot be removed.
- A promotion is refused without a project key, and refused when that key fails
  the list-models check; neither writes anything.
- A request with no personal key runs on the primary manager's project key, and
  changes key when the primary changes.
- A Google sign-in on the settings page reaches the same keys as a GitHub sign-in
  with the same address.
- A roster member can add a project key; a signed-in stranger cannot.
- A manager cannot step down while the lent GitHub access is theirs.
- On a deployed project the terminal refuses and points at the connector.
- Keys saved under a GitHub id before this change still work.
- Every change is one attributed commit recording the key check.
