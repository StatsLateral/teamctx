# Joining a teamctx project

For someone who has been added to a project that is already running. If you are
the one setting a project up, you want
[mcp-hosted-setup.md](mcp-hosted-setup.md) instead.

You need two things from the manager: the **connector URL**, and to have been
added to the project. They get the URL by running `teamctx connect`.

## 1. Add the connector

In Claude: **Settings → Connectors → Add custom connector**, paste the URL,
save.

> **If you have connected a different teamctx project before, remove that
> connector first.** Each project is its own connector, and two of them expose
> the same tool names — so the client has no way to tell you which project it
> just wrote to. Removing the old one is not required for it to work; it is
> required for you to be able to trust what you are looking at.

## 2. Sign in

Claude opens a sign-in page the first time. **Being asked to authorize is
expected** — it is teamctx asking who you are, once, so your work is recorded
under your own name rather than the manager's.

Approve it and the connector goes green. If it does not, see below.

## 3. Check it worked

Ask your assistant:

> what's the context on this project?

You should get the project's Whys back. If you do, you are connected.

## What you can do

- **See your work** — "what are my tasks?"
- **Get a task's prompt** — "give me the prompt for <task>". Do the work in a
  fresh chat with that prompt.
- **Send work back** — "here's what I found: …" queues a contribution for the
  manager to review.

Your contributions do not change the project's shared context until the manager
approves them. That is deliberate: it is what keeps a shared context worth
trusting.

## When it does not work

**"Authentication required" or the connector will not go green.**
You have been added to the project, but not given access to the repository it
lives in — those are two different things, and the second is the one the
connector needs. Ask the manager to check.

**You are asked to sign in every time.**
Your client is not keeping the session. Remove the connector and add it again.

**The tools appear but every call fails.**
Usually the URL points at a project you are not on. Check with the manager that
the URL is the one `teamctx connect` printed for *their* project.

**A tool that calls a model says no key is configured.**
Some tools (`ask`, `contribute`, `reflect`) need an AI provider key. Either set
your own at `<deployment>/settings`, or ask the manager to share the project's.
The other tools work without one.
