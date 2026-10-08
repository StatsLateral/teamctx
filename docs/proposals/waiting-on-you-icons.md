# Proposal: finish the Waiting on you icons

**Status:** Implemented · **Issue:** [#142](https://github.com/StatsLateral/teamctx/issues/142)
**Spec:** [waiting-on-you icons](../superpowers/specs/2026-10-07-waiting-on-you-icons-design.md) ·
**Plan:** task 5 in [the UI specs build](../superpowers/plans/2026-10-07-ui-specs-build.md)
**Base:** `main` at `818ef8d` (the one-page project view)

## What the issue asks

Each queue row gets an eye (**View details**, opens the drawer at the top) and a
clipboard-check (**Review**, opens it scrolled to **Decide**). Clicking the row
still opens it at the top. Rows stop being a single `<button>`. The drawer's
Decide section shows the exact instruction to give the assistant, with a copy
button.

**Done when:** two labelled controls per row and no text Review button;
focusable, distinct accessible names; one drawer per click; keyboard focus
returns to the icon on close.

Not in this issue: approve or reject on the page. The page stays read-only.

## Where it starts from

`818ef8d` built most of it while making the page one page:

| Asked | On `main` |
|---|---|
| Eye and clipboard-check on each row, no text Review button | Yes |
| Distinct accessible names ("View 1.2", "Review 1.2: approve or reject") | Yes |
| Row is not one `<button>` (`div.q` with a `button.qmain`) | Yes |
| One drawer per click (`stopPropagation`) | Yes |
| Focus returns to the icon on close | Yes |
| Review scrolls to Decide; Decide says how to decide | Yes |
| **A copy button for the instruction** | No |
| **View and the row open the drawer at the top** | No |
| **Behaviour tests** (spec: "Behaviour test (DOM)") | No: tests match strings in the page source |

So this is the three missing pieces, not a rebuild.

## Design

### 1 · Decide: each instruction copyable

> **Changed after #159.** #159 made the drawer's assistant row open the
> assistant with a decide prompt, so the two assistant lines below were dropped
> in favour of it. Decide keeps #159's sentence and the two command-line lines,
> each with a Copy button.

Today Decide is two sentences, with the commands inside them. A manager has to
select the right part by hand. Instead, Decide lists the four things they can
hand over, each on its own line with a **Copy** button:

- **In your assistant:** `Approve 1.2` · `Reject 1.2 because …`
- **On the command line:** `teamctx review approve <id>` ·
  `teamctx review reject <id> --reason "…"`

An item with no number is named by what it says (`Approve "Add annual
billing"`), so the copied instruction still points at one thing.

Copying uses the page's existing copy helper, which already falls back for
plain-http deployments, and the existing toast says "Copied". Each button's
accessible name says what it copies, so the four are distinct.

### 2 · View and the row open at the top

The drawer body keeps its scroll position between openings. After a Review
click scrolls down to Decide, the next View or row click on another item opens
partway down. Every opening now starts the drawer at the top; only the Review
icon then scrolls to Decide. The same applies to the project and workstream
panels, which share the drawer.

### 3 · Behaviour tests in a real DOM

The spec asks for DOM behaviour tests: the eye opens at the top, Review opens
at Decide, one drawer per click, focus returns to the icon. The page's script
can only be checked by running it. The tests load the rendered page into
**jsdom** with its inline script running, click the controls, and assert on the
DOM. `scrollIntoView` and the clipboard are stubbed, since jsdom has neither.

## Existing open source first

**jsdom** as a dev dependency, for tests only. It is the standard DOM for Node
test runners; vitest supports it directly. Nothing is added at runtime. Writing
a fake DOM by hand to drive the script would be exactly the plumbing
[Build vs borrow](../../CONTRIBUTING.md#build-vs-borrow) warns against.

For the page itself, nothing: a button per line and two lines of script. The
spec already rejected icon, tooltip and clipboard libraries.

## Plan

- [x] Decide: structured instructions, each with a Copy button and a distinct label
- [x] Every drawer opening starts at the top; Review then scrolls to Decide
- [x] jsdom behaviour tests: View at the top, Review at Decide, one drawer per click,
      focus back to the icon on close, Copy copies the exact text
- [x] Update the string tests for the new Decide shape; CHANGELOG
