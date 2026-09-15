# Recipe: Build a project for a client, then hand it over

Use this when you set up a teamctx project **for** someone else's team — as a
consultant, a fractional operator, or anyone delivering "an AI project" as the
work — and that team should be able to keep running it.

**Who reads this:** both sides.

- **The builder** — you set the project up. Steps 1–4, then one of the two
  endings in step 5.
- **The client** — you are receiving the project. Read
  [Before you start](#before-you-start) and [If you are the client](#if-you-are-the-client).

**What you end up with:** the client's people each get context scoped to their
part of the work, and one of two arrangements:

- **You stay on as manager** and approve the team's contributions on a regular
  cadence. Nothing moves.
- **You hand it over.** The client's lead becomes the manager, the repository
  belongs to the client, and you step out.

---

## Before you start

**The client needs one GitHub account.** Not everyone on their team — one
person, usually whoever looks after their tools. The project lives in a GitHub
repository, and handing it over means that repository belongs to the client.
Everyone else can stay on a Google sign-in; they never need GitHub.

If you are staying on as manager, the client needs no GitHub account at all.

**Whoever becomes manager brings their own AI key.** Your key stays yours. The
client does not depend on it, and you do not keep paying for their usage. A
person cannot be made manager until their own key has been added to the project
and checked.

---

## 1. Seed it from what the client signed off on

Start from the documents the client accepted — the brief, the spec, the final
deck — not from your working chat. The chat carries private reasoning, dead ends
and names that do not belong in the client's repository, or in its history.

Save the accepted documents as `.md` or `.txt` files and import them:

```
teamctx import ./deliverables/brief.md ./deliverables/spec.md --dry-run
teamctx import ./deliverables/brief.md ./deliverables/spec.md
teamctx review list
teamctx review approve <id>
```

`--dry-run` shows what would be imported without doing it. Documents in Google
Drive, Dropbox or Microsoft 365 can be imported directly — see
[`docs/import-gdrive.md`](../docs/import-gdrive.md) and its neighbours.

## 2. Add the reasoning behind the deliverables

The deliverables say *what* was agreed. They rarely say *why* — which options
were ruled out, which constraint forced a choice. That reasoning is what made
your own AI useful on this work, and it is what the client's team will need.

Add it as a few short contributions. The prompt below turns your notes into
them.

````
I am handing a project over to a client team. I need to record the reasoning
behind what we delivered, as a few short updates to the team's shared context.

Here is what the client signed off on:

<PASTE THE ACCEPTED DELIVERABLES, OR A SUMMARY OF THEM, HERE>

Here are my notes on why things ended up this way — decisions, trade-offs,
options we ruled out:

<PASTE YOUR NOTES HERE>

Please produce:

1. Between three and eight updates. Each is 2–4 sentences of plain prose that
   I can pass directly to `teamctx contribute "..."`, and each covers one
   decision or one piece of reasoning.
2. For each, say whether it is a **decision** — something the team is
   committed to. If so, remind me to add `--decision`.
3. List anything from my notes you left out because it should not reach the
   client: private reasoning, internal names, dead ends that no longer matter.

Rules:

- Only use what is in the deliverables and my notes. Don't invent reasons.
- Don't name people, other clients, or anyone outside the client's team.
- If a note is unclear, ask me instead of guessing.
````

Then add each one:

```
teamctx contribute "<UPDATE>" --decision
teamctx review approve <id>
```

## 3. Let the AI propose a structure, then accept what fits

```
teamctx workstream propose
```

This suggests how the project splits into parts, and who belongs in each. It
changes nothing. To create parts, run:

```
teamctx workstream split
```

It proposes its splits afresh — a separate AI call, so they may not match what
`propose` showed — and asks you to accept each one.

One part is a fine shape. Most projects never need a second.

## 4. Bring in the client's people

Add each person by email, limited to the parts of the project they work on:

```
teamctx member add sam@client.com --name "Sam" --workstream pricing
teamctx member scope sam@client.com --workstream pricing onboarding
```

Omit `--workstream` to give someone the whole project. If you may hand the
project over later, add the client's lead as a member too — they have to be on
the project before they can add their AI key to it.

Then get the link they paste into their AI tool:

```
teamctx connect
```

Send them that link and [`docs/mcp-join.md`](../docs/mcp-join.md). If the
client's people sign in with Google rather than GitHub, lend the project your
GitHub access first: on your deployment's **Settings** page, **Let members join
without GitHub → Lend GitHub access**.

## 5. Choose an ending

### Ending A — stay on as manager

Nothing more to set up. The client's people send their updates for review, and
you approve them on a cadence that suits the engagement — weekly is common:

```
teamctx review list
teamctx review approve <id>
teamctx review reject <id> --reason "<WHY>"
```

### Ending B — hand it over

Do these in order. A step that is out of order is refused rather than half-done.

**a. The client's lead adds their own AI key.** They must already be a member
(step 4). They sign in to your deployment's **Settings** page — with Google or
GitHub — and use **Add a key to a project**. Signing in with Google works only
once you have lent the project GitHub access (step 4).

**b. Make them the primary manager, while the repository is still yours.** Do
this through your AI tool's teamctx connector, not the terminal — a deployed
project only accepts manager changes there, where the key can be checked. Ask
your AI to transfer the manager role to their email address.

On a project that is not deployed, the terminal works:

```
teamctx manager transfer lead@client.com
teamctx manager list
```

You stay on as a co-manager for now. Don't step down yet.

**c. Transfer the repository to the client.** On GitHub, **Settings → Transfer
ownership**, to the client's GitHub account or organisation. Their GitHub owner
accepts. The managers and the member list live inside the repository, so they
move with it.

**d. Set the hosted side up again under the new address.** The hosted server
knows a project by its GitHub address, so after a transfer it treats the
project as new. This is expected, and it means:

- **The client's GitHub owner lends GitHub access** — on the **Settings** page,
  **Let members join without GitHub → Lend GitHub access**. Only needed if
  anyone signs in with Google, and it comes first if the lead does: the page
  cannot confirm a Google sign-in on a project that has not lent access.
- **The client's lead adds their AI key again** — step **a**, on the new
  project.
- **Everyone reconnects with a new link.** The old one points at the old
  address. On a clone, point it at the new repository first, then print the
  link:

  ```
  git remote set-url origin https://github.com/<client>/<repo>.git
  teamctx connect
  ```

- **Personal settings** — display name, which part of the project someone was
  working in — start fresh.

**e. Step out.** Ask your AI to remove your email from the managers, or from a
clone of a project that is not deployed:

```
teamctx manager remove you@builder.com
```

This is refused while members still reach the project through GitHub access you
lent — that is the reason for step **d**. Finally, the client removes you as a
collaborator on the repository in GitHub.

---

## If you are the client

What to expect when a project is handed to you:

- **Before the handover,** once the builder has added you as a member, add your
  own AI key to the project on the **Settings** page. The handover cannot finish
  without it.
- **After the handover,** you approve your team's updates. Ask your AI what is
  waiting for review.
- **One person on your side needs a GitHub account** to own the repository and,
  if anyone signs in with Google, to lend it GitHub access. Nobody else does.
- **Everyone reconnects once,** with the new link from after the repository
  moved.
- **Each person's first step** is to ask their AI what they are working on. It
  answers with their part of the project and the context behind it — the same
  as `teamctx brief` in a terminal.

---

## Tips

- Import the accepted version of each document, not every draft. The history of
  the project is in git; the shared context should describe where it ended up.
- Do step 2 while the reasoning is fresh — before the engagement closes, not
  after.
- If you are unsure which ending you want, start with **Ending A**. You can hand
  over later; nothing in steps 1–4 has to be redone.
- `teamctx manager list` shows who can approve at any point.

## See also

- [`recipes/author-contribution.md`](author-contribution.md) — shaping a single
  update before you contribute it.
- [`docs/mcp-manager-guide.md`](../docs/mcp-manager-guide.md) — running a project
  as its manager.
- [`docs/mcp-join.md`](../docs/mcp-join.md) — what the people you add do to join.
- [`docs/proposals/manager-handoff.md`](../docs/proposals/manager-handoff.md) —
  the rules behind handing the manager role over.
