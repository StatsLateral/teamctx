# Files as task outputs: uploaded files and links to cloud files

**Date:** 2026-11-02
**Status:** Design agreed in conversation; pending review
**Builds on:** [working outputs](2026-10-13-task-working-outputs-design.md) (#197), [connected sources](../../proposals/connected-sources.md) (#168) and its per-tool proposals for Google Drive, SharePoint/OneDrive and Dropbox (#171–#173)

## Problem

A team member's deliverable is often a file, not text: an image a chatbot made, a spreadsheet
they analysed, a PDF export, a deck that already lives in SharePoint or Google Drive. Today:

- A working output is **text only**. The working-outputs spec lists binary files and images as a
  non-goal, and an output may hold at most 50,000 characters.
- A file that reaches the project through a connector leaves only a **reference** (link, title,
  summary), never the file, and a submission cannot carry one (the Slack proposal notes that
  `task_submit` does not take `sources` yet).

So the person describes the file in words, the manager approves the description, and nobody can
point at the thing that was actually reviewed. This is the same gap the working-outputs spec
closed for text ("the manager sees the AI's description, not the post"), now for files.

## Goals

1. A task output can be **a file the person uploads**, kept in the project's repository, so the
   manager reviews and approves exactly those bytes.
2. A task output can be **a link to a file that already lives in SharePoint, OneDrive, Google
   Drive or Dropbox**, with a version marker taken at submit time, **without copying it**.
3. Files go through **the same flow as any output**: save, submit, manager accepts or sends
   feedback. A file made by a chatbot is not special-cased; it is reviewed like anything else.
4. Keep it simple and cheap: a **10 MB limit** on uploads from the CLI (**4 MB** from the project page), and **the assistant is never handed a
   file's bytes**, which also keeps AI token cost down.

## Non-goals (this version)

- Files over 10 MB. The person keeps them in their cloud or local folder and submits the part
  that matters, or a summary.
- Showing a file's contents inside the project page (preview), or editing a file in place.
- Copying linked cloud files into the repository.
- Detecting that a linked file changed after approval.
- Scanning uploads for secrets or malware.
- Anything about paid or hosted offerings. This design is the free, open-source core.

## Anti-goals

- A confidential file landing in a repo's history with no warning that it cannot be fully
  removed.
- Uploaded content that runs in a reader's browser (an HTML or SVG file served inline).
- A silent cut-off. As with text outputs, a file over the limit is **refused**, never trimmed.
- The assistant paying tokens to carry a file through a tool call.

## Design

### 1. Two kinds of file output

An output gains a `kind`. Text outputs keep working unchanged (`kind` absent means text).

| `kind` | What it is | Where the file is |
|---|---|---|
| `text` (default) | Today's output. | In the output record. |
| `file` | A file the person uploaded. | In the repository, under the task. |
| `link` | A file that lives in a connected cloud tool. | Stays where it is. |

Every kind keeps the existing fields (`id`, `task`, `title`, `author` with how it was made,
`at`, `prompt`, `basedOn`, `notes`, `state`). Outputs stay **append-only**: a changed file is a
new output with `basedOn` pointing at the earlier one.

### 2. Uploaded files (`kind: file`)

The record adds `file: { name, type, size, sha256, path }`. The bytes are stored beside the
record: `outputs/<task id>/files/<output id>-<safe name>`, written once, never overwritten.

- **Size:** at most **10 MB** from the CLI and local use (`MAX_OUTPUT_FILE_BYTES`), and at most
  **4 MB** from the project page (`MAX_PAGE_UPLOAD_BYTES`), because the hosted server runs on
  Vercel, whose functions refuse request bodies over 4.5 MB. Over the limit for the route used,
  refused with a message that says which limit applies, to keep the file in a cloud or local
  folder and submit a part or a summary, or link it, and that the CLI takes up to 10 MB.
- **Types:** an allow-list of common work files: png, jpg, gif, webp, pdf, csv, txt, md, json,
  docx, xlsx, pptx. **No svg, html, scripts or executables.** The type is decided from the file's
  leading bytes, not only its extension, and a mismatch is refused.
- **Name:** reduced to a safe name (no path parts, no control characters, length limited). The
  output id prefix keeps two uploads of "report.pdf" apart.
- **Hash:** `sha256` is recorded at upload. The approval later records which output (and so which
  hash) was accepted, so "what was approved" is exact.
- **Warning at upload:** the person is told the file goes into the project's repository and,
  once committed, remains in its history even if the task or output is later removed.
- **Serving:** a file is only ever served as a download (attachment, with the sniffed type),
  through the project page or API, after the same scope check that guards the task. Raw access
  to the repository is whatever the repository's own permissions allow; this design does not
  change that.

### 3. Linked files (`kind: link`)

The record adds `link: { connector, title, url, itemId?, version }`.

- The link and item id are normalised by the connector code that already exists (#171–#173), so
  a copied "Share" link and an address-bar link become one reference.
- `version` is a marker taken **when the output is saved**: a Drive revision id, a SharePoint or
  OneDrive version/ETag, a Dropbox revision, or none if the tool gives nothing (then the record
  says so rather than inventing one). The manager approves "this link at this version".
- Nothing about the file's contents is stored, matching connected sources today. A short note
  from the person says what it is.
- Saving a link output also records the file as a connected source against the task, so it
  appears in the Connected sources drawer. This is the `sources` on `task_submit` the Slack
  proposal said was missing.
- teamctx holds no credential for the tool. The assistant, which has the connector, supplies the
  link, name and version.

### 4. How a file gets in

- **CLI and local:** `teamctx task attach <task> <path> --title "…" --note "…"`. Reads the file
  from disk; no bytes pass through an assistant.
- **Project page:** (4 MB limit) an upload control in the task's Working outputs section, for a signed-in
  member, including members who sign in without GitHub. The hosted server commits on their
  behalf as it does for other writes.
- **Assistant (MCP):** for links only: `task_attach_link` with the link, title, version and note.
  There is **no MCP tool that takes file bytes**: a 10 MB file as a tool argument is about 13 MB
  of encoded text, which is unworkable and expensive. An assistant that produced a file tells the
  person to save it and attach it with the CLI or the page. *(My call.)*

### 5. What the assistant and the reviewer see

- **Assistant:** for a file or link output, name, type, size, the person's note, prompt and
  state, never the bytes. It may read the content only when the file is plain text (txt, md,
  csv, json) and small enough to pass the existing output limit. Images, spreadsheets and PDFs
  are for the human; the note says what is in them.
- **Manager:** the review drawer lists each submitted output. A file has a download link and its
  size, type and hash; a link output opens the cloud file and shows its version marker. The
  person's note and message are shown as today. The "checked against what is already approved"
  section runs on the note and, for plain-text files, the text.
- **Accept / feedback:** unchanged. Accepting records the accepted output ids, which carry the
  file hash or link version.

### 6. Removing

An accepted task is closed and (per #202) a manager can later remove it with a reason. Removing a
task or output removes it from the plan, not from the history: the file stays in git history. The
upload warning (section 2) says so. Purging history is out of scope.

## Existing open source first

- **File type from leading bytes:** use [`file-type`](https://github.com/sindresorhus/file-type)
  rather than a hand-written signature table. It reads text-based formats poorly (csv, txt, md,
  json), so those are checked by extension plus a "valid UTF-8, no NUL bytes" test.
- **Storing the bytes:** the GitHub Git Data API and the local filesystem writers already used for
  outputs. Binary needs a bytes path (today's writers take strings and base64-encode utf8).
  [Git LFS](https://git-lfs.com) is deliberately not used; the 10 MB cap makes it unnecessary.
- **Upload parsing on the page:** a maintained multipart parser (for example
  [`busboy`](https://github.com/mscdex/busboy)) rather than hand-parsing request bodies.
- **Link normalisation:** the existing Drive, SharePoint and Dropbox code (#171–#173).
- **Text extraction from docx/pdf for assistants:** not in this version; see post-MVP issues,
  where [MarkItDown](https://github.com/microsoft/markitdown) and
  [mammoth](https://github.com/mwilliamson/mammoth.js) are the candidates.
- **Only teamctx should build:** the output kinds, the scope check on download, and the link between
  an approval and the exact hash or version.

## Constraints

- Data stays in the team's repository (data-ownership principle); no separate file store.
- The hosted server runs on Vercel, whose functions refuse request bodies over 4.5 MB, so the
  page's limit is 4 MB. The CLI writes to the repository itself and keeps the 10 MB limit. The
  CLI in hosted/session mode must be checked: if it also goes through the server it is subject
  to the same 4 MB limit, and the builder reports back rather than silently lowering it.
- Scope rules for workstreams apply to files exactly as to text outputs.

## Left to the builder

- Output id and file naming details, within the rules above.
- Exact allow-list edits if a listed type proves hard to verify.
- The wording of the refusal and upload-warning messages.
- How the page's upload control looks.

## Decisions made without the user (check these)

1. The CLI limit is **10 MB** (the user said 5 or 10); the page limit of **4 MB** was the user's choice, forced by the Vercel body limit.
2. **No MCP tool carries file bytes**; assistants attach links, people attach files via CLI or page.
3. The type allow-list and the no-svg/html rule.
4. The assistant reads a file's content only when it is small plain text.
5. `sha256` and the link version marker are recorded and carried into the approval.
6. A file made with a chatbot is recorded through the existing "how it was made" on the author,
   with no extra approval rule.

## Issues

MVP issues and post-MVP issues are linked from the tracking issue created with this design.
