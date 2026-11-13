# Let assistants read the text of docx, xlsx and pdf outputs (#250)

## The moment

Someone attaches a spreadsheet or a Word document as a task output. A teammate's
assistant picks the task up, and all it can see is the file's name, type and
size — it cannot read a word of what is inside. To use it, a person has to open
the file themselves and paste the content back. For a product whose point is
that an AI agent works from the shared context, a deliverable it cannot read is
a hole.

## What exists now

- A file output stores `file: { name, type, size, sha256, path }` and the bytes
  in the repository (`src/file-output.js`, `saveFileOutput`). No text is kept.
- Allowed binary types include `docx`, `xlsx`, `pptx`, `pdf`; allowed text types
  are `csv`, `txt`, `md`, `json` (`FILE_OUTPUT_TYPES`).
- An assistant reading a task (`get_task`, `task_output`, `my_brief`) gets the
  file's metadata, never its content. So a plain-text file is already *there* as
  bytes, but an Office or PDF file is opaque.

## Proposal

Add one text-extraction step that turns a supported file output into a **bounded
text excerpt**, surfaced to an assistant when it reads the task. The web page is
unchanged — it still offers download.

1. **A single extractor**, `extractOutputText(bytes, ext, { maxChars })` in a new
   `src/file-text.js`, dispatching by type:
   - text types (`txt`, `md`, `csv`, `json`) — decode UTF-8 (already validated as
     text at upload);
   - `docx` — `mammoth` (→ plain text);
   - `xlsx` — SheetJS (`xlsx`), each sheet flattened to CSV-like rows;
   - `pdf` — a maintained text extractor (`pdfjs-dist` text content);
   - `pptx` — **out of this version** (slide XML extraction is fiddlier and lower
     value); it stays download-only, reported honestly as "no text extracted".
2. **Bounded, never the whole file.** Cap the excerpt at a constant (proposed
   ~20k characters / a page or sheet budget), append a clear truncation marker,
   and say the excerpt is partial. This is the answer to the token-cost open
   question: an assistant gets enough to work from, not an unbounded dump.
3. **Extract on read, not at upload.** The repository keeps only the original
   file; no derived text is committed (it would bloat history and drift from the
   source). Extraction is paid only when an assistant actually asks, and a bound
   keeps that cost flat. (The alternative — extract once and store — is noted
   under Alternatives.)
4. **Honest about failure.** A file that cannot be parsed, or a type with no
   extractor, yields no text and a short reason, never a crashed read. Extraction
   runs on untrusted bytes through maintained libraries only, with no macro or
   script execution and the output bounded.
5. **Surface:** the output an assistant reads gains a `text` excerpt field for a
   supported type (alongside the existing `file` metadata). `my_brief`,
   `get_task` and `task_output` carry it. The page does not.

## Alternatives considered

- **Extract once at upload, store the excerpt.** Smoother reads, but it commits
  derived content to the repo (against the "store the file, nothing derived"
  grain), and a stored excerpt can drift. Rejected for v1; revisit if on-read
  cost ever shows up.
- **Markdown via MarkItDown (named in the issue).** It is Python; this is a Node
  codebase, so a per-format Node library is the fit (mammoth, SheetJS, pdfjs).

## New dependencies

`mammoth` (docx), `xlsx`/SheetJS (xlsx), and a PDF text library (`pdfjs-dist`).
All are widely used and permissively licensed; each will be pinned and checked.
Note: these add to the hosted serverless bundle, so the build will confirm the
function stays within limits — a reason to keep pdf/pptx scope tight.

## Not in this issue

Preview/rendering in the page (#249); diffing versions (#253); OCR of scanned
PDFs or image text; pptx extraction.

## What changes for the end user

- **An assistant can now work from an uploaded spreadsheet, Word doc or PDF** —
  it reads a bounded excerpt of the content instead of only the file name.
- Nothing changes for the person attaching the file, or on the web page.
- Large files still attach; the assistant simply sees a capped excerpt with a
  note that it was truncated.

## Acceptance

- Reading a task with a `docx`, `xlsx` or `pdf` output returns a bounded text
  excerpt of its content to the assistant.
- A text output (`txt`/`md`/`csv`/`json`) reads as before.
- The excerpt is capped and marked when truncated; the whole file is never
  returned.
- An unparseable file, or a `pptx`, reads as "no text extracted" with a reason,
  never an error.
- The repository stores only the original file; no extracted text is committed.
- The project page is unchanged.
