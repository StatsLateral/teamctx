# Proposal: the manager's review-and-impact screen

**Status:** Implemented · **Issue:** [#118](https://github.com/StatsLateral/teamctx/issues/118)
**Base:** `feat/assumption-evidence` (#126, #127, #121, #120, #122 — every one of which this screen shows)

## What the issue asks

One page for the manager at `/project/:owner/:repo`, replacing the interim layout:

1. **Waiting for you** — the review queue, each item in plain words with what it
   would change, its evidence (#122), any contradiction (#121), and the impact
   list (#120).
2. **Needs review** — broken assumptions and everything resting on them;
   assumptions past their check-by date; exceptions ending within 14 days.
3. **Current state** — active decisions, rules (exceptions under them) and
   assumptions, by part of the work, in plain words.

Members see section 3 only, for their own parts. Keep #108/#112's guarantees:
scope enforced in the page data, escaping, deep links, no AI calls from the page.

**Acceptance:** the manager can clear the queue and see what a broken assumption
affects without leaving the page; a scoped member's page data has nothing from
outside their parts; an unknown `?item=` shows "That item isn't here anymore" and
the value never appears on the page.

Out of the MVP: the outline, who's-on-what and at-a-glance views.

## Where it starts from

The page after #127 already has tabs — Context, Tasks, Waiting on you — shared
rows with Notes, pagination, and the queue showing #121 contradictions, #122
evidence and #120's impact list. So most of section 1's content and all of
section 3 exist. What is missing:

- **Acting on the queue.** The page is read-only; the issue's first acceptance
  line needs approve and reject on it.
- **Section 2** does not exist.
- **The queue reads wrong.** A contribution and each of its changes render as
  rows at the same level, so 2 contributions with 9 changes look like 11
  reviews while the tab says 2. A tester read it as "the count only includes
  reviews with warnings".
- **An unknown `?item=`** is dropped silently; the issue asks for a note.

## Design

### Tabs

For a manager: **Current state · Tasks · Review**. For a member: **Current state ·
Tasks**. "Context" is renamed "Current state", the issue's name for it. Tasks
stays: #127 put it there and #118 does not remove it.

The issue asks for sections, not tabs, so *Waiting for you* and *Needs review*
are two sections of the one **Review** tab, the queue first, each paging on its
own (`page` and `npage`, as the two context tables do). Current state is first
and the default; the Review tab's count is amber when there is something in it.

### 1 · Waiting for you

One **card per contribution**: who sent it, when, its summary, and a count of
its changes; under that, its changes as nested rows in the shared anatomy, with
the contradiction, evidence and impact notes where they apply. The tab and the
heading say "2 waiting · 9 changes", which answers the count confusion.

Each card has **Approve** and **Reject** (with an optional reason). A card with a
contradiction must say which existing record it replaces before Approve works —
one choice per flagged record, exactly what `review approve --replaces` takes. An
inherited conflict cannot be resolved from this part of the work, and the card
says where it can be.

The forms POST to `/project/:owner/:repo/review/:id`; the result comes back on
the page as a note, and the next card is in view. The manager gate is the one
`approveReview` already applies — a non-manager posting gets the same refusal
the CLI gives. Cross-site posts are already refused by the session cookie's
`SameSite=Lax`; an `Origin` check is added as well, since this is the first
form on the page that changes the team's context.

### 2 · Needs review

Three groups across the whole project, each row naming its part of the work:

- **Broken assumptions**, each followed by what rests on it — decisions, rules
  and tasks — from #120's `restingOn`. Dependents the manager has already
  re-confirmed are shown as such rather than hidden, so the list is the whole
  story.
- **Assumptions past their check-by date.**
- **Exceptions ending within 14 days**, and any already ended.

Manager only, per the issue; it reads every part of the work, so a member's page
data never contains it.

### 3 · Current state

The existing context view, renamed. Its rows — and every row on the page —
are now compact: the key in a narrow column, the statement taking the rest of
the row (capped at two lines), and type, status, owner, notes, where and source
as pills under it. A column each had left the statement a sliver and every row
tall; the manager reading the queue was the one paying for it. Clicking a row
shows the whole statement and every pill in full. (Asked for during review of
this screen, not in the issue.)

### Unknown items

`?item=`, `?task=` or `?review=` naming nothing this reader can reach shows
"That item isn't here anymore." The value itself is never written to the page.

### The one judgement call: role briefs on approval

Approving a contribution regenerates the role briefs for that part of the work,
and that is an AI call. #118 says "no AI calls from the page", carried over from
#108, where it meant **viewing** the page never spends AI: a page load is
deterministic and free.

So approving from the page does exactly what approving from an assistant does,
including refreshing role briefs on the project's key. Viewing still never calls
AI. The alternative — approve without refreshing — leaves every role brief in
that part describing context that no longer stands, which members read through
their assistants as current. If the refresh fails, nothing is written (a hosted
commit is all or nothing) and the card says to approve from an assistant.

Only a part of the work with roles makes the call; most have none.

## Existing open source first

Server-rendered on `src/views` with plain forms, as the issue asks. No
framework; no script beyond what the page already has.

## Plan

- [x] Tabs: Current state · Tasks · Review (both manager sections, paged apart)
- [x] Section 1 as cards with nested changes; "N waiting · M changes"
- [x] Approve / Reject / Replace from the page; manager gate; Origin check
- [x] Section 2: broken + what rests on them, overdue, ending soon
- [x] Unknown `?item=` note, never echoing the value
- [x] Member page data has neither section 1 nor 2
- [x] Tests for each acceptance line; CHANGELOG
- [x] Compact rows: statement plus pills, details on click (asked for in review)
