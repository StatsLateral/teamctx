# Proposal: Manager approval queue

**Status:** Proposal (suggestion, not committed) · **Serves:** Managers in control ·
**Rough size:** Large — splittable (queue model → review UX → permissions)

## Problem

The vision says managers approve **the work** before it enters the shared context.
Today a contribution is applied to the context tree more or less immediately, so
there's no real gate — just a notification after the fact. Managers need a queue:
contributions wait, a manager reviews, and only approved ones change the team's
context.

## What exists today

- `teamctx contribute "<text>"` runs the AI distill → shows a **diff review** →
  applies it to the tree and regenerates role files. `--auto-approve` skips the
  review; `--decision` tags a human decision.
- `teamctx pull` fetches pending **web** contributions and processes them.
- `teamctx config manager-email <addr>` stores an address for notifications.
- So there's a *review-the-diff* step, but approval isn't a durable, gated state —
  applying is the default, and web contributions are processed in a batch.

## Suggested approach (one way to do it)

1. **Make a contribution a durable object with a status** — `pending` →
   `approved` / `rejected` — stored under `.teamctx/` (e.g. a `pending/` area),
   instead of being applied on submission. Capture author, source, timestamp, and
   the proposed operations.
2. **Only apply on approval** — approving a pending contribution runs the existing
   `applyOps` against the tree and regenerates role files; rejecting archives it
   with a reason. This reuses the current distill/apply logic — the change is
   *when* it runs, not *how*.
3. **Give managers a review surface:**
   - CLI: `teamctx review list`, `teamctx review approve <id>`,
     `teamctx review reject <id> [reason]`.
   - (Optional follow-up) a web review page, building on the existing
     `manager-email` notification.
4. **Basic roles/permissions** — who may approve. Start minimal: a configured
   manager identity vs. everyone else. Full RBAC is out of scope.

## Scope

**In:** the pending-contribution data model, the approve/reject transitions wired
to `applyOps`, the `teamctx review` CLI commands, and tests for the state machine.

**Out (note as follow-ups):** web review UI, multi-approver workflows, approving the
*context snapshot* itself (that's a separate, later roadmap item), full RBAC.

## Where to start

- A clean 🟢-ish first PR: the **pending-contribution model + `teamctx review list`**
  (read-only) — it makes the queue real without yet changing how `contribute`
  applies. Then a follow-up PR flips `contribute` to enqueue instead of apply, and
  wires `approve`/`reject`.
- Read `cli/commands/contribute.js`, `src/context.js` (`updateShared`), and
  `src/ops.js` (`applyOps`) to see the distill→apply path you'll be gating.

## Open questions

- Should `contribute` enqueue by default, with an opt-in `--apply` for solo users
  who don't want a gate? (Suggested: yes — keeps teamctx pleasant for one-person use.)
- How do approver identities relate to the API/MCP auth model
  ([external-api-and-mcp](external-api-and-mcp.md))? Worth aligning the two.
