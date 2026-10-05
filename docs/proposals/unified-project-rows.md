# Proposal: one row layout and one task list

**Status:** Implemented · **Issue:** #127 · **Depends on:** #126
**Spec:** `docs/superpowers/specs/2026-10-04-agent-first-project-view-design.md`
(PR #125, section 3, read before implementation).

## Problem

The project page shows tasks both in its context columns and in a separate
table. Records, inherited context, tasks and pending contributions have different
layouts. Some locations show raw workstream ids, and a reader cannot spot an
overdue assumption or expired exception without inspecting stored data.

## Design

- Share a row renderer: key, plain type label, text, owner, state and governance,
  and source dot. Use it for context, inherited records, tasks and queue proposals.
- Keep tasks in one list. Workstream and owner filters are GET forms, so they
  work without JavaScript and preserve the current reading view.
- Display locations as breadcrumbs of visible workstream names. Internal ids
  remain in link targets and form values; they are never used as location labels.
  Ancestors outside a member's scope are omitted from breadcrumbs.
- Show overdue assumptions and expired active exceptions on their rows. Retired
  records (replaced, broken, closed) are reachable through a history toggle.
  A link to a retired record opens history automatically.
- Keep exceptions beside their rules, including expired exceptions; retain
  task-attached records in context rather than silently omitting them.
- Pending additions have no key yet. Proposed edits show the existing key;
  new records/tasks show Pending. No page read mints keys or writes data.
- Deep links still open the drawer for the requested item. Linked tasks remain
  reachable even when an owner or workstream filter would otherwise hide them.

The project tree, agent markers, expanded governance drawers and assistant
actions belong to #128–#131. This change supplies the shared presentation they
can use.

## Existing open source first

This is project-specific rendering of the existing data model. Reuse the page's
HTML, CSS, escaping and GET navigation; no rendering framework or dependency is
needed.

## Validation

- [x] Shared rows in both context views, inherited context, tasks and queue.
- [x] Each task appears once; both filters work with named breadcrumbs.
- [x] Overdue/expiry warning chips and retired-record history.
- [x] Deep links, sign-in return paths and view/filter/history preservation.
- [x] Scoped payloads, hidden ancestors, hostile stored text and unknown filters.
- [x] Full test suite and CHANGELOG.

Validation: 2,122 tests passed across 122 files. The route tests exercise filters,
scope boundaries, pending additions/edits, history and links. A headless Chrome
check at 1440px and 390px confirmed no horizontal overflow, exactly one task row,
matching row anatomy, both warning chips, and a working task drawer with the
correct copied prompt. No dependencies were added.
