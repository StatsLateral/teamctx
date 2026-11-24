# Showing how a file output changed between versions

**Date:** 2026-11-10
**Status:** Proposal; pending review
**Issue:** [#253](https://github.com/StatsLateral/teamctx/issues/253) (post-MVP of the files-as-task-outputs epic, [#254](https://github.com/StatsLateral/teamctx/issues/254))
**Builds on:** [files as task outputs](2026-11-02-task-file-outputs-design.md) (#244–#247) and [working outputs](2026-10-13-task-working-outputs-design.md) (#197). Sibling of [link-output staleness](2026-11-10-link-output-staleness-design.md) (#248): that shows when a *linked cloud* file drifts; this shows how an *uploaded* output changed from the version before it.

## Problem

Outputs are append-only. The file-outputs design settled that a changed file is **not** an edit of the old record but **a new output that points back at the earlier one** with `basedOn`:

> Outputs stay append-only: a changed file is a new output with `basedOn` pointing at the earlier one. — *files-as-task-outputs §1*

That linkage is already captured. `saveOutput`, `saveOutputFile` and `saveLinkOutput` each take `basedOn`, validate that it names a real output on the task, and store it; `outputsForReader` and `workData` carry it all the way to the page. But **nothing renders it**. So today:

- A reviewer looking at the newest output cannot tell it is the third take of the same deliverable, or see which one it replaced.
- When two versions are plain text, nobody can see *what* changed between them — the whole point of keeping both.

This is the gap #253 names: *show the chain, and a text diff when both are plain text.*

## Goals

1. In the task drawer and the review drawer, show an output's **version lineage**: what it is based on, and whether a newer version exists — for every kind (text, file, link).
2. When an output and the version it is based on are **both readable plain text**, show a **compact diff** (what was added and removed), so a reviewer sees the change itself, not just that there was one.
3. Do it with **no new infrastructure and no credential**: everything needed is already in the repository. Reuse the readable-text rule the file-outputs MVP already defined (`txt`, `md`, `csv`, `json`; valid UTF‑8, no NUL).
4. Be honest about reach, as #248 is: a pair that cannot be diffed (an image, a spreadsheet, a binary, a file too large, or a hosted file whose bytes this surface cannot read) shows the **chain only**, with a one-line reason — never a faked or partial diff.

## Non-goals (this version)

- A rich side-by-side / word-level diff UI. A unified, line-level diff is enough first.
- Diffing binary or office formats (png/jpg/gif/webp/pdf/docx/xlsx/pptx). The chain view is the answer there (per the issue's own open question).
- Diffing *linked* cloud files against each other — that is the connector/version world of #248, not uploaded bytes.
- Rewriting history or merging versions. Append-only stands; a new version is still a new output.
- Any AI call. The diff is mechanical.

## The crux: where the two texts can be read

A diff needs the text of **both** the output and its `basedOn` parent. Where that text lives depends on the kind and the surface:

| Output kind | Where its text is | Readable at render? |
|---|---|---|
| `text` | `body` on the record | **Always** — already carried to the client in `workData`. |
| `file`, text type (txt/md/csv/json) | bytes in the repo under `outputs/<task>/files/…` | **Locally / clone-backed:** yes, via `readOutputFile`. **Hosted:** only through the session blob read the download route uses — `readOutputFile` itself is filesystem-only. |
| `file`, binary/office | bytes in the repo | Not diffable — chain only. |
| `link` | nothing stored (only a reference + version marker) | Not diffable — chain only; drift is #248's job. |

So the two halves of this feature have very different cost:

- **Lineage** is pure presentation over `basedOn`, which is already on the client. Free, works everywhere, every kind.
- **Text-output diffs** need no file read — both bodies are already in hand.
- **Text-*file* diffs** need a byte read: trivial locally, but on the hosted page they depend on the same session blob read the file-download path (#247) already performs. This is the one place the surface matters.

Unlike #248, **no credential and no scheduler is involved** — every byte is in the repo the viewer can already read. And unlike #248, the result need not be stored: it can be computed at render time (bounded, see below), because nothing external can change it.

## Options

| | What | Cost | Verdict |
|---|---|---|---|
| **A** | Lineage chain only, no diff | Tiny | Under-delivers — the issue asks for a diff. |
| **B** | Chain + **client-side** diff of text-output bodies only | Small, but ships a diff lib (or a hand-rolled LCS) to every page load, and can never cover text *files* | Rejected: the issue says don't hand-roll, and a client lib bloats the page for a rarely-open drawer. |
| **C** | Chain (all kinds) + **server-side** diff for text outputs and locally-readable text files, attached to the output as a bounded summary the drawer renders; hosted text-file diff wired to the existing session blob read | Moderate; one maintained text-diff dependency, used server-side only | **Recommended.** Matches #248's "compute where the data is, render a small block" shape. |
| **D** | C plus a rich side-by-side/word-level UI and "chain is enough" affordances for images/sheets | Larger UI surface | Defer — follow-up once C is in use. |

## Design (option C)

### 1. Version lineage (all kinds)

From the task's outputs (already sorted) build the `basedOn` chain. For each output the drawer shows:

- **Based on:** a short reference to the parent output (its title, else a short id), when `basedOn` is set and the parent is visible to this reader.
- **Superseded:** on an output that another output is `basedOn`, a muted "A newer version exists" line.

Pure client-side presentation, like the #248 badge: a small line appended in `showWork` (task drawer) and in the review-drawer output list. No new data — `basedOn` is already in `workData`.

### 2. The diff (readable text pairs only)

Define the **text of an output**:

- `text` → `body`.
- `file` of a readable text type, within the output char limit → its bytes decoded as UTF‑8 (reusing `file-output.js`'s `TEXT_TYPES` + the UTF‑8/no‑NUL check).
- anything else → *no text*.

When both an output and its `basedOn` parent have text, compute a **unified line diff** with a maintained library (candidate: [`diff`](https://github.com/kpdecker/jsdiff), server-side only). Attach to the output a **bounded** summary:

```
diff: { added, removed, hunks: [ "…capped preview…" ], truncated }
```

- `added` / `removed`: line counts, always shown.
- `hunks`: a preview capped to a small number of changed lines; `truncated: true` when the real diff is larger, with a "download both to see the full change" hint.
- If either text exceeds the char limit, skip the body read and show counts only, or "too large to preview" — never a partial, misleading diff.

The drawer renders it as a collapsible block under the output (unified style: `+`/`−` lines), defaulting collapsed, with the add/remove counts always visible. Reuses the existing output-note styling plus a small `.diff` block.

### 3. Honest "no diff" line

A pair that cannot be diffed shows one muted line with the reason: *"No text diff — this is a PNG"*, *"…a spreadsheet"*, *"…a linked file"*, *"…its bytes aren't available on this page"* (hosted binary/large). The chain line still shows.

### 4. Where it is computed

- **Task drawer / review drawer, hosted:** computed in the project view builder (`src/oauth/project-view.js` / `src/views/project-work.js`), where the session can read a text file's blob exactly as the download route does. The bounded summary — not the raw texts — is what reaches the client.
- **Local/CLI-rendered contexts:** the same builder, reading via `readOutputFile`.

Text-*output* diffs need no read and are computed from `body` alone, so they work on every surface from day one; text-*file* diffs light up where the bytes are reachable.

## What this cannot do

- Diff images, PDFs, or office formats — chain view only.
- Show a change inside a file larger than the output char limit — counts and a download hint only.
- Diff across tasks, or between arbitrary outputs the person did not link with `basedOn`. The chain is the author's stated lineage, not a guess.
- Tell you a linked cloud file changed — that is #248.

## Rough shape of the work

1. **A text-diff helper** (`src/output-diff.js`): "text of an output" + a bounded unified-diff summary over two texts, with the char-limit guard. Unit-tested in isolation (identical, added-only, removed-only, mixed, over-limit, non-text).
2. **The view builder** attaches `basedOn` lineage facts and, where both texts are reachable, the bounded `diff` summary to each output — reusing the readable-text rule and, hosted, the session blob read.
3. **The drawer render** (`src/views/project.js`): a lineage line and a collapsible diff block in `showWork` and the review output list, plus small CSS. (Mirrors the #248 `appendCheck` addition.)
4. **One dependency**: a maintained text-diff library, used server-side only. (If review prefers zero new deps, a minimal LCS line-diff is the fallback — but the issue explicitly says to use a library.)
5. **Tests**: helper unit tests; a view test that the lineage + bounded diff reach the drawer data; a jsdom render check of the diff block and the "no diff" line (the kind of live render that caught nothing-rendered gaps in #248).

## Verdict

**Doable, and smaller than #248.** The hard part #248 had — a credential that lives only on the member's machine and no place to run unattended — does not exist here: every byte is in the repository the viewer can already read, so there is no scheduler, no stored check, and no "who holds the credential" problem. The lineage half is almost free (the data is already on the client); the diff half is a bounded, server-side computation over text we can already read, plus one small library. The only real seam is reading a text *file*'s bytes on the hosted page, which reuses the download path (#247) rather than inventing anything.

Recommendation: **build option C** — lineage for all kinds now, text diff for text outputs and readable text files, hosted text-file diff on the existing session read — and leave the rich side-by-side UI (option D) to a follow-up.

## Decisions to confirm with the reviewer

1. **Diffable types** = the readable-text set already defined for the MVP (`txt`, `md`, `csv`, `json`). Images and office formats get the chain only. *(Issue's open question.)*
2. **Unified, line-level diff**, collapsed by default, with always-visible add/remove counts — not side-by-side or word-level in v1.
3. **Compute server-side, send a bounded summary** (counts + capped hunks), not the raw texts and not a client-side diff library.
4. **One new dependency** (`diff`/jsdiff) used server-side, over a hand-rolled diff, per the issue's "use an existing diff library."
5. **Hosted text-file diffs** reuse the file-download session read; if that read is not yet factored out of the download route, v1 ships text-output + local text-file diffs and the hosted text-file diff follows it.
