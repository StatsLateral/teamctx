# Waiting on you: two icons replace the Review button

**Date:** 2026-10-07
**Status:** Design confirmed in the demo conversation (UI fix 3 of a series); spec pending review
**Builds on:** [goal text](2026-10-07-project-goal-text-design.md) (fix 1), [settings block](2026-10-07-project-settings-block-design.md) (fix 2), the agent-first project view spec (#125), the unified project rows and review tab (#134)
**Prototype:** the internal prototype (synthetic data)

## Problem

Each item in "Waiting on you" has a green **Review** button on the right. Clicking
the row opens the right-hand drawer too, so the button and the row do the same
thing. The button costs a lot of visual weight (a solid green block on every row)
for no extra function, and it does not tell a person that the row itself is
clickable.

## Goal

Each row carries two small icon buttons that say what they do, and the
row stays clickable. The queue looks lighter and each action is distinct.

## Non-goals

- Building on-page approve / reject in the real product. The demo drawer keeps
  its Approve and Reject buttons as the target design; building them for real is
  a future, low-priority item (section 5).
- Changing queue contents, order, ownership or the warnings on each row.
- Bulk actions (select many, approve all).

## Design

Scope of this fix: the two icons and the drawer behaviour they trigger. What sits
in the drawer's decision section is covered in section 5.

### 1. The two icons

At the right end of each row, in this order:

| Icon | Name | Does |
|------|------|------|
| Eye | **View details** | Opens the right-hand drawer at the top, to read the item. Same as clicking the row. |
| Clipboard with a check | **Review** | Opens the same drawer, scrolled so the decision section is on screen. |

- The eye comes first because reading precedes deciding. The Review icon is
  the one with colour (accent outline, filled on hover): it is the action the
  manager is here for.
- Both are 34px square buttons with a 1px border and 8px radius, matching the other
  small icon buttons on the page. The icons are 17px line icons (no fill) so they
  read at a glance in light and dark mode.
- Each has a hover tooltip ("View details", "Review: approve or reject") and an
  `aria-label` that includes the item key ("View Q-1", "Review Q-1: approve or
  reject"), so screen readers and keyboard users know which item.
- The two icons replace the Review button. The row's key, text, source chip and
  "N to check against the record" warning are unchanged.
- Clicking anywhere else on the row still opens the drawer at the top, the same as
  the eye. The icons are shortcuts and cues, not the only way in.

### 2. Why two icons that open the same drawer

A manager does two different things with a queued item: read it, or decide it.
The eye answers "show me what this is"; the Review icon answers "I have what I need,
take me to the decision". With a single drawer, the difference is where it opens.
That keeps one drawer (no new screens) while still giving a distinct, labelled
action, and the eye doubles as the visual cue that the row opens something.

### 3. States and edge cases

| Case | Behaviour |
|------|-----------|
| Short drawer content | The decision section is already on screen; no scrolling happens. |
| Long evidence | The drawer scrolls the decision section into view (smooth, centred when possible). |
| Item already decided in another session | Drawer shows its decided state; the Review icon opens it without the decide controls. |
| Non-managers | The queue is not shown to them; no change. |
| Narrow screens | Icons stay at the right of the row; the text wraps first. |
| Keyboard | Both icons are focusable buttons, Enter/Space activate; focus returns to the icon when the drawer closes. |
| Click on an icon | Does not also trigger the row click (one drawer open, not two). |

### 4. Why this is right for the next 6 to 12 months

- Review will be the manager's main job as agents propose more work. A queue
  of many rows needs to be light and scannable; solid buttons on every row do not
  scale to dozens of items.
- Distinct labelled actions (read vs. decide) are easier for assistive tech and
  for anything that automates a click on the page.
- Decisions increasingly happen in a chat. Keeping the page to "see it" and
  "take me to the decision" leaves room for the decision itself to be made
  either here or in the manager's assistant (open question 1).

### 5. Approve and reject: demo now, real product later (low priority)

- **Demo (kept as is):** the drawer's decision section shows **Approve as
  submitted**, **Reject** and **Review with AI**. They stay so the prototype shows
  the full review flow, and the Review icon lands the manager on them.
- **Real product, this fix:** the real page is read-only (#125: approvals happen in
  the assistant or CLI). The Review icon still opens the drawer at a **Decide**
  section, which for now gives the exact approve / reject instruction to hand to
  the assistant (for example `teamctx review approve <id>` or the matching chat
  prompt). The icons ship with that.
- **Future, not a priority:** approve / reject buttons on the page itself, as in
  the demo. When built they need, at minimum: manager-only (the same
  `assertManager` check the CLI uses, enforced server-side, never by hiding a
  button), a confirmation that shows what will be written, the contradiction and
  stale-comparison checks the CLI runs (`--replaces`, changed-record refusal), the
  review-policy rules, and a record of who decided and when. It should be filed as a
  `parked` issue and picked up only after the assistant-based path proves
  insufficient.

## Existing open source first

Nothing to borrow. These are two inline SVG icons and a scroll call; an icon
library (Lucide, Heroicons) or a tooltip library would add a dependency for
two shapes and the browser's own `title`. If the page later needs many icons, add
one set then, not now.

## Changes

- `src/views/project.js` (the review tab / `queueRows`): replace the Review
  button with the two icon buttons in a right-aligned group; add the `View` and
  `Review` links or buttons with the labels above. The row link and keyboard
  behaviour stay as they are.
- `src/views/project-row.js` or the project view CSS: `.qicon` button styles, the
  coloured Review variant, hover and focus styles, dark mode.
- Drawer script: a "scroll to the decision section" option when opened from the Review
  icon.
- No change to the queue data, review policy, scope enforcement or approvals.

## Testing

- View test: each queued row renders two icon controls with the labels and keys above
  and no text "Review" button.
- View test: the two controls are focusable, carry distinct accessible names, and do not
  nest inside another interactive element incorrectly.
- Behaviour test (DOM): the eye opens the drawer at the top; the Review icon opens it
  scrolled to the decision section; clicking an icon opens exactly one drawer.
- Regression: clicking the row text still opens the drawer; warnings and source chips
  are unchanged.
- Visual check against the demo in light and dark mode at desktop and phone width.

## Open questions

1. **Resolved:** the demo keeps Approve / Reject in the drawer; the real product keeps
   decisions in the assistant or CLI until on-page approval is built (section 5,
   future, low priority).
2. Should rows show a count or the checks summary next to the icons (e.g. "2 to
   check")? It is already shown as the amber warning; left as is.
