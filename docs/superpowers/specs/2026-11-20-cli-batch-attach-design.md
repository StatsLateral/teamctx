# Attach many files at once from the command line (#256)

Status: proposal, awaiting review.
Issue: #256 (enhancement, Post-MVP, low priority). Builds on the file-outputs
MVP (`docs/superpowers/specs/2026-11-02-task-file-outputs-design.md`, #244–#247),
specifically the single-file `teamctx task attach` (#246). Sibling of the
upload-by-URL and larger-file work (#257, #251) but independent of both — it
touches only the CLI and the shared save path, so it is based on `main`, not
stacked.

## Where this comes from

A person can make dozens of files in a chatbot — a folder of marketing images,
a set of exports. Today each one is a separate `teamctx task attach <task>
<file>`, and each is its own commit. This adds a batch form: point the command
at a folder or a glob and get one output per file in a single commit, with a
clear summary of what went in and what was skipped and why.

## The open questions, and what this proposes

The issue names three. This is a small, low-risk feature, so rather than list
variants at length, here is the proposed answer to each with the reasoning; the
review is really a yes/no on these.

1. **One output per file, or one output holding several?**
   → **One output per file.** It matches the MVP's model exactly (one file =
   one reviewable, downloadable output), reuses the single-file validate-and-store
   path unchanged, and keeps the manager's review and the download route simple.
   A multi-file output would be a new record shape and a new review surface for
   no real gain.

2. **A per-run total cap, so a folder cannot bloat the repo?**
   → **Yes — two caps.** Each file still obeys the single-file size cap
   (`MAX_OUTPUT_FILE_BYTES`). On top of that a run has a **file-count cap**
   (propose 50) and a **total-bytes cap** (propose 100 MB) so a stray `*`
   against a huge folder is refused before anything is written, not committed and
   regretted. Both are named constants, easy to tune.

3. **Suggest a cloud folder link when the batch is large.**
   → **Yes.** When a run is refused for a cap, or simply has many files, the
   message points at keeping the folder in a cloud tool and linking it with
   `task_attach_link` (one link, no repo bloat) instead of committing dozens of
   binaries.

## Behaviour

`teamctx task attach <task> <path>` where `<path>` is a file (today's behaviour,
unchanged), **a directory**, or **a glob**:

- A **directory** attaches the allowed-type files directly inside it — **not**
  recursively, so a nested tree never surprises the user with a huge commit.
  `--recursive` opts into descending.
- A **glob** (for example `out/*.png` or `exports/**/*.csv`) attaches its
  matches; the shell may expand it, so the command also accepts an already
  expanded list of paths.
- Files are filtered to the allowed types; a disallowed or unreadable file is
  **skipped and reported**, never aborting the batch. A file over the single-file
  cap is skipped and reported too.
- Before writing, the run is checked against the count and total-bytes caps; over
  either, it is refused whole with a message (nothing half-committed), pointing
  at a cloud link for a large set.
- All accepted files are written and recorded, then committed in **one commit**
  (and one push), not one per file.
- The command prints a summary: how many attached and their total size, and each
  skipped file with its reason.

Open choices left for the review: the exact cap numbers (50 files / 100 MB), and
whether `--recursive` is worth shipping now or deferring.

## Implementation sketch

- A batch core in `cli/commands/task.core.js` — `saveFileOutputs` (plural) — that
  resolves the paths, validates each with the existing `validateFileOutput`,
  writes each with `writeOutputFile` + `writeOutput`, and calls
  `commitAndPush` **once** for the whole set. The single-file `saveFileOutput`
  stays as-is (or becomes a one-element call of the same core).
- `cli/commands/task.js` grows the batch branch: expand the directory/glob,
  apply the caps, call the batch core, print the summary. The single-file path is
  untouched when `<path>` is one file.
- `cli/index.js`: the `attach` command's argument becomes `<path>` (file,
  folder or glob) with an optional `--recursive`; description updated.
- No new dependency. Directory reads and globbing use Node's `fs`
  (`readdirSync`, and a small glob already in the tree if there is one, else a
  minimal matcher) — confirmed at build before adding anything.

## Interaction with #251

#251 raises the single-file CLI cap to 50 MB. This feature reads that same
constant, so once #251 merges a batch inherits the 50 MB per-file ceiling with
no change here. The per-run total cap (100 MB) is deliberately above a single
file so a handful of large files can still go in one run.

## Testing (developer-run before PR)

- Unit: a folder of mixed files attaches the allowed ones in one commit and
  reports the skipped ones with reasons; a glob matches the right files; a run
  over the count cap and one over the total-bytes cap are each refused whole,
  writing nothing; a non-recursive run ignores a subfolder and `--recursive`
  descends; a single-file path still behaves exactly as before.
- Live: on a test project, attach a real folder of images to a task from the
  command line, confirm one commit with one output per file and the summary, and
  that the manager sees each output. Run alongside the #251 cap check.

## Out of scope

- Any MCP tool that carries bytes (that is #257 / #251; batch attach is CLI-only,
  reading from disk, no bytes through a model).
- A multi-file single output, previewing, or diffing (#249, #253).
- Attaching a whole folder as one cloud link — that is already `task_attach_link`
  with the folder's share URL.

## Relates to

`docs/superpowers/specs/2026-11-02-task-file-outputs-design.md`; #246 (single-file
attach), #257 (PR #328), #251 (larger files), #254 (epic).
