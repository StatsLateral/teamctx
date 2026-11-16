# Warn about secrets in an upload, and help undo a mistaken one (#252)

## The moment

Someone attaches a file as a task output — a config they exported, a log, a
spreadsheet — and it carries an API key or a private key they did not notice.
The bytes go straight into the project's git repository and the manager reviews
exactly those bytes. Removing the task or the output later does not remove the
file: it stays in history. A leaked credential committed by mistake is the kind
of thing this product's security posture exists to avoid, and right now nothing
catches it. There is only a warning sentence (`FILE_OUTPUT_WARNING`) asking
people not to do it.

## What exists now

- Every upload, from either route, passes through one check:
  `validateFileOutput(bytes, name, { maxBytes })` in `src/file-output.js`. It
  enforces the size limit, the type allow-list, the real-type sniff and a safe
  name, and it **refuses, never trims** — a bad file is rejected with a message.
- Two routes call it: the CLI attach command (`cli/commands/task.core.js`, up to
  10 MB, writing to the repo directly) and the project page
  (`src/oauth/project-view.js`, up to 4 MB, through the hosted function).
- `FILE_OUTPUT_WARNING` is shown before a commit, but it is passive text; nothing
  inspects the bytes.

## Proposal

Add a secret scan at that one chokepoint, so both routes are covered by one
change, and ship guidance for removing a file already committed.

1. **Scan in `validateFileOutput`, after the type checks pass.** A new
   `src/secret-scan.js` exports `scanForSecrets(text)` → a list of
   `{ rule, line, match }` findings, with `match` redacted (first/last few
   characters only, never the whole secret). The validator runs it on the file's
   **decodable text** and, when it finds something, refuses with a
   `FileOutputError` that names each rule and line — exactly as the size and type
   refusals already read.

2. **Scope v1 to text content.** The text types (`txt`, `md`, `csv`, `json`) are
   scanned in full. For the Office/PDF binaries, a credential is far rarer and
   scanning the container bytes is noisy; v1 does **not** crack them open (it may
   do a cheap scan of any UTF-8 runs, but makes no promise). Images are not
   scanned. This keeps the scan fast, serverless-safe, and low on false alarms,
   and is honest about what it does and does not catch.

3. **Patterns from a maintained ruleset, not hand-rolled.** The issue is explicit:
   do not invent regexes. The detectors are a curated subset of
   **gitleaks**' rules (MIT) — the high-signal, low-false-positive ones: PEM
   private-key blocks, AWS access-key ids, GitHub tokens (`ghp_`/`gho_`/…), Slack
   tokens (`xox…`), Google API keys (`AIza…`), Stripe keys, generic
   `PRIVATE KEY`/`BEGIN OPENSSH` blocks, and high-entropy `secret`/`token`/
   `password` assignments. They are embedded as data (a small table), sourced from
   gitleaks rather than written from scratch, and pinned with a note of where they
   came from. A heavyweight scanner binary (gitleaks is Go) or the full
   `secretlint` dependency tree is **not** pulled into the hosted function.

4. **Refuse by default, with an explicit override.** Because a committed secret is
   expensive to undo, the default is to **refuse** the upload and show what
   matched and where, so the person can rotate it or confirm a false positive.
   An override lets them proceed when they know better:
   - CLI: a `--allow-secrets` flag on `task attach`.
   - Page: a second confirm on the attach form ("I checked these — attach
     anyway") that re-posts with the override set.
   The override is recorded in the message, not silently.

5. **Help undo a mistaken upload — guidance only.** History rewriting is
   destructive; v1 does **not** wrap it in a command. A new doc section (and a
   pointer from the refusal/warning) explains: remove the file, and to purge it
   from history use **git-filter-repo**, then rotate the exposed credential
   regardless — rotation is the real fix, since anyone who pulled already has it.

## Open questions resolved here (from the issue)

- **CLI, page or both?** Both, in one place — the shared validator.
- **History rewrite: guidance or a guarded command?** Guidance only for v1; a
  guarded command is out of scope and arguably never ours to own.

## Alternatives considered

- **Warn but allow (no refuse).** Lower friction, but a passive warning is what
  exists today and did not stop the mistake. Refuse-by-default with an override
  matches how `validateFileOutput` already behaves and is safer given git's
  permanence.
- **Bundle gitleaks/secretlint wholesale.** gitleaks is a Go binary (no place in
  a Vercel Node function); secretlint drags in a large dependency tree for a
  scan we need to be small and synchronous. Reusing their *rules* as data gets
  the "don't hand-roll" benefit without the weight.
- **Scan binaries too (unzip Office files).** More coverage, much more cost and
  noise; deferred, and the refusal message says binaries are not deeply scanned.

## New dependencies

None required — the detectors are embedded regex data sourced from gitleaks. (No
new runtime package; this is deliberate for the hosted function's size.)

## What changes for the end user

- **Attaching a file with an obvious secret is stopped**, with a message naming
  what was found and on which line, so they can rotate it before it lands.
- They can still attach on purpose with an explicit override.
- If something already slipped in, the docs tell them how to remove it from
  history and that rotating the credential is the real fix.
- Nothing changes for a clean file, on either route.

## Not in this issue

Scanning inside Office/PDF binaries; a command that rewrites history; scanning
of linked cloud files (#248's path); detection of non-credential sensitive data
(PII).

## Acceptance

- A `txt`/`md`/`csv`/`json` upload containing a recognisable secret is refused on
  both the CLI and the page, with a message naming the rule and line and a
  redacted match.
- A clean file of the same type attaches as before.
- The override (`--allow-secrets` / the page's second confirm) lets a flagged
  file through, and the fact is recorded in the message.
- The detectors come from gitleaks' ruleset, embedded as data; no scanner binary
  or heavy dependency is added, and the hosted function stays within its limit.
- The docs explain removing a committed file from history and rotating the
  credential; no destructive command is shipped.
- The repository still stores only the original file; the scan derives nothing
  that is committed.
