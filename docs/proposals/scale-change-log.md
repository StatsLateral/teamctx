# Proposal: make the change log, impact card and pickup flag scale

**Status:** Implemented · **Issue:** [#206](https://github.com/StatsLateral/teamctx/issues/206)
· **Base:** `main` · **Builds on:** the accepted-work design (#204,
`docs/superpowers/specs/2026-10-14-accepted-work-updates-context-design.md`)

## Why

The issue pressure-tests the change log, the impact card (`reach`) and the
pickup flag (`changedSince`) against Slack-volume context: about 300 messages an
hour, a manager approving about 20 changes a day, about 7,000 log entries a
year. Its numbers are assumptions; so are the ones here.

## What is already there

- **Names answer "newer than".** `changes/<time>-<id>.json` sorts as it reads,
  and `listChanges({ after })` drops older files by name before reading any.
- **The page reads the log once** and indexes it in memory (`project-view.js`).
- **`reach` is data.** `reachOf` returns adds, inherited-by and in-progress
  tasks; `reachLines` renders them. It takes any list of operations.
- **Imports are queued**, so volume floods the review queue, not the log.

## What still breaks

1. **The hosted server reads every log file on every request.**
   `GithubSession.prefetch` downloads every blob under `.teamctx/`, one GitHub
   call each. At 7,000 entries that is thousands of calls per tool call, past
   GitHub's 5,000-an-hour limit, however the files are named. Locally, `get_task`
   also reads the whole log (`listChanges({})`) instead of what is newer than
   the task's last activity.
2. **Nothing sums reaches.** Forty waiting items are forty impact cards; nothing
   says "12 reach Registration, 3 clash with a decision".
3. **The pickup flag cries wolf.** Any change anywhere in a task's chain flags
   every task in progress below it, which on a busy project is always.
4. **Slack-derived candidates have no home.** That part waits for Slack mapping;
   see "Not now".

## What changes

### 1. Reading the log

- **The part goes in the file name:** `changes/<time>.<part>.<id>.json`, with
  `project` for project level. A name written before this keeps working: with no
  part in it, it is read and filtered by its contents as now.
- **`listChanges({ after, trees })`** drops files by name (older than `after`, or
  in a part outside `trees`) before reading any.
- **`get_task` and compile ask for what is newer than the task's last activity
  in its own chain**, not the whole log.
- **The hosted server stops downloading old log files up front.** `prefetch`
  lists every path, as now, but downloads change-log files only from the last
  30 days. Older ones are fetched on demand: before a log read, the caller awaits
  `prepareChanges({ after, trees })`, which downloads only the matching names.
  `get_task`, compile and the project page call it. A reader that forgets still
  sees the last 30 days, never an error.

### 2. Summing reaches

- **`mergeReach(reaches)`** adds up any number of reaches: totals added and
  changed, every part reached (with how many items reach it), and the in-progress
  tasks flagged, each once.
- **`list_pending_reviews` returns `overall`**: the merged reach of everything
  waiting, as lines such as "12 waiting items reach Registration; 3 clash with a
  decision or rule; 5 tasks in progress would be flagged." A scoped caller's
  overall view is merged from what they may see.
- The same function serves a future view of Slack candidates: it takes any set of
  candidate operations.

### 3. Tiers for the pickup flag

- **Each new log entry says whether it matters to everyone below it**
  (`significant`): it set the goal, touched a rule or an exception, or marked an
  assumption broken.
- **A task hears about a change in full** when it is significant or when it
  touched that task. Anything else, such as a plain added decision, becomes a
  count: "and 7 other changes".
- The five-line cap stays. An entry written before this has no `significant`
  field and is shown in full, as now, so nothing goes quiet.

## Not now

- **The signal store for Slack candidates (point 4).** Nothing produces
  candidates yet: the Slack connector (#186) records threads as sources of a
  contribution, not as per-member candidates. A store with no producer would be
  guesswork. What this proposal does make ready is `reach` over any candidate
  operations, and `mergeReach` for the manager's overall view. The issue's
  requirements for when Slack mapping is built (channel visibility, Slack user to
  member, a stable thread key, untrusted text, no raw text in the repository)
  stand as written there.
- **One commit for many approvals, a lock on hosted workstream writes, and
  narrowing candidates to tasks with embeddings.** The issue lists these as
  existing limits. Each is its own change.

## Reused

`listChanges`, `changeEntry`, `changesReaching`, `changedSummary`, `reachOf`,
`limitReach`, `reachLines`, `GithubSession`.

## Tests

The part is in the name and old names still read; `after` and `trees` drop files
before any is read; `get_task` reads only newer files; hosted prefetch downloads
only recent log files and `prepareChanges` fetches older matching ones;
`mergeReach` sums, counts parts and lists each task once; the overall lines in
`list_pending_reviews`, scoped; significant changes in full, others counted, old
entries in full.

## Plan

- [x] The part in log file names; `listChanges({ after, trees })`; `get_task` and compile read only newer entries
- [x] Hosted: recent log files up front, older ones on demand
- [x] `mergeReach` and the overall lines in `list_pending_reviews`
- [x] Tiers for the pickup flag
- [x] CHANGELOG
