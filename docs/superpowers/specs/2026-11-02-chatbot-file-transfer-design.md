# Getting chatbot-made files into a task without token cost

**Date:** 2026-11-02
**Status:** Draft for review. Options are laid out with a recommendation; the decisions at the end are open.
**Builds on:** [files as task outputs](2026-11-02-task-file-outputs-design.md) (#244–#247, tracking #254)
**Issues:** #256 (folder attach), #257 (upload by short-lived URL), #258 (file-reference spike)

## Problem

Someone makes a batch of files in a chatbot, for example dozens of marketing images in ChatGPT,
and wants them on a teamctx task for review. The file outputs MVP has two ways in: the CLI
(10 MB per file) and the project page (4 MB per file). It deliberately has **no MCP tool that
carries file bytes**, because a tool call carries text: a 1 MB image is roughly 1.3 MB of encoded
text the model must read and write, which is slow, unreliable and expensive, and some chat apps
will not let the model read its own generated file back into a tool call at all.

So today the person downloads each file and attaches it by hand. For a dozen files that is
tedious; for dozens it is not realistic.

## Goals

1. Moving a batch of chatbot-made files onto a task takes **minutes, not a file at a time**.
2. **The file's bytes never pass through the model**, so token cost stays near zero.
3. The same limits, type checks, scope rules and review flow as every other file output. A file
   from a chatbot is not special-cased.
4. Prefer what a platform already offers over building a service.

## Non-goals

- Larger files (#251), previews (#249), or reading file contents in assistants (#250).
- A hosted file store or sync service. Files still end up in the team's repository, or stay in
  their cloud folder and are linked.
- Anything specific to paid or hosted offerings. This is the free, open-source core.

## Anti-goals

- A long-lived or reusable upload credential that could be used outside its task.
- A new way to fill the repository with large binaries unnoticed (dozens of images per task add
  up).
- Building a connector per chatbot before we know which ones can do this.

## The three routes

### A. Attach a folder from the CLI (#256)

`teamctx task attach <task> <folder or glob>`. One output per file, each under the usual 10 MB
limit, type allow-list and name rules, committed together, with a summary of what was refused
and why.

- Works with **every** chatbot: the person downloads the files into a folder (or a script does)
  and runs one command. The "one-off script written by a coding assistant" is just this command.
- No server, no new security surface. Pure extension of the single-file attach in #246.
- A per-run total cap (my suggestion: 50 MB) so one command cannot quietly add hundreds of MB.
  Past it, the message suggests putting the folder in Drive or SharePoint and attaching the link.

### B. Upload by short-lived URL (#257)

MCP tool `request_upload(task, name, size)` returns a short-lived, single-use URL. The chatbot's
own code sandbox sends the file there (for example `curl -T image.png <url>`); the bytes go from
the sandbox to teamctx and never through the model. The model only handles the URL.

- Token cost: a short tool call and a short reply.
- **Only works where the chatbot's sandbox can reach our server over the network.** I believe
  ChatGPT's normal code sandbox cannot, and that some other chat apps' sandboxes can only with
  settings the user changes. This is **unverified** and decides how useful B is.
- The URL is bound to one task, one person, a maximum size (the page limit of 4 MB while uploads
  go through the hosted server, per the Vercel request-body limit) and a short expiry, and works
  once. The upload endpoint applies the same size, type, name and scope checks as the page.
- If the sandbox cannot reach us, B simply fails with a clear message and the person uses A.

### C. File references from the chat platform (#258, a spike first)

Some platforms can hand a file the user attached or the chatbot generated to a tool **by
reference**, so the platform uploads it and the model never carries it. I believe this exists in
ChatGPT's Custom GPT Actions and Apps SDK, and I do not know of an equivalent in Claude.ai.
**This is from memory and must be checked** before anything is built.

- The spike answers: which platforms and plans support it; does the file arrive as a URL we
  fetch or in the request body; and what are the platform's size limits.
- If it works it is the cleanest route for ChatGPT users (no sandbox network needed), but it
  means a connector per platform, so build it only for a platform with real users.

## Recommendation

1. **Build A first.** It works everywhere, is small, and is what a one-off script would call.
2. **Run the C spike in parallel** (it is research, not a build), starting with ChatGPT since it
   is the case that prompted this.
3. **Build B only if** the spike or a quick test shows at least one chatbot we care about can
   reach the endpoint from its sandbox. Otherwise B has no users.

For very large batches, the better answer is often not to upload at all: put the folder in Drive
or SharePoint and attach it as a link (#245). Dozens of images at a few MB each, revised
repeatedly, grow the repository quickly and git does not delete them later (#252).

## Security notes for B (and anything like it)

- The URL is a bearer credential: single use, short expiry (minutes), bound to task, person and
  size, never logged in full, never stored beyond its lifetime.
- The endpoint re-checks the person's access and the task's workstream scope on use, not only at
  issue time.
- Rate-limit issuing per person so the tool cannot be used to probe the endpoint.
- No filename or content is trusted: the same sniffing, allow-list and safe-name rules as the
  page upload.
- Files are only ever served back as downloads (as in the main design).

## Existing open source first

- **A:** no new library; extends single-file attach. A glob library already in the dependency
  tree, or Node's built-in, covers expansion. Check before adding one.
- **B:** signed expiring URLs are a standard pattern. Check for a maintained token library
  (for example `jose` for a signed, expiring token) before writing any signing. Multipart or raw
  body parsing as in the page upload (`busboy`).
- **C:** the platform's own file-passing features. Do not build a parallel upload service.
- Only teamctx should build: the task/person/size binding and the link to the review flow.

## Decisions needed

1. Order: A first, spike C in parallel, B conditional on the spike. Agree?
2. Per-run total cap for A: 50 MB suggested. Right number?
3. A: one output per file (my suggestion, so each can be accepted or sent back separately), or one
   output holding several files?
4. B: is it worth building at all if only one chatbot's sandbox can reach us?
5. Which chatbots must work first? (ChatGPT prompted this; is Claude.ai also required?)
6. B's expiry (suggested 10 minutes) and issue rate limit (suggested 30 per person per hour).
7. Should a batch of more than N files (suggest 20) get a prompt to link a cloud folder instead?

## What I verified and what I did not

- **Verified:** the file outputs MVP design and limits; that bytes in an MCP tool call cost
  tokens; that the hosted server's request bodies are capped at 4.5 MB.
- **Not verified:** whether any chatbot's sandbox can reach our server; whether ChatGPT or others
  can pass files to tools by reference, and under what limits. Both need a short test before
  committing to B or C.
