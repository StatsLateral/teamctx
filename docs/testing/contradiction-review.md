# Test contradiction review (#121)

## What & why

Proposed records are checked against active decisions and rules in their own
part of the work and its ancestors. A contradiction queues with both statements
named, even when the manager requests direct apply or the review policy is
`none`. Approval requires an explicit replacement or resolution of the inherited
record; rejection keeps existing context unchanged.

This stops conflicting choices from silently becoming active together. #120 is
different: after an assumption is marked broken, it flags choices resting on
that assumption. #121 checks new proposed changes before they enter context.

## Manual steps

Use a fresh sandbox and this checkout's CLI. Set the provider key in your shell
or sandbox `.env.local`. During init, answer **n** to auto-push.

```powershell
Set-Location 'D:\work\teamctx'
git switch feat/contradiction-review
$cli = 'D:\work\teamctx\cli\index.js'
New-Item -ItemType Directory -Path 'D:\work\teamctx-smoke-121'
Set-Location 'D:\work\teamctx-smoke-121'
git init
node $cli init
node $cli contribute 'Our goal is enterprise sales. We decided the entry offer is a pricing audit.' --apply --auto-approve
node $cli config review-policy none
node $cli contribute 'We decided the entry offer is an AI-readiness assessment rather than a pricing audit.' --apply --auto-approve
node $cli review list
```

Expect a queued proposal showing **Contradicts 'We decided: …'**, naming the
pricing audit and AI-readiness assessment. The old decision remains active.
The proposed decision has no allocated key, and `--apply` does not bypass this.

If the AI already proposes `links.replaces`, ordinary manager approval is the
explicit resolution. Otherwise plain approval refuses and leaves the item
queued. Select the old decision's internal id explicitly (records have no
number; the flagged id is printed with the conflict):

```powershell
node $cli review approve '<QUEUE-ID>' --replaces '<OLD-RECORD-ID>'
node $cli brief
Get-Content -Raw .teamctx\project.json
```

Expect the old decision to remain in history as replaced, with the new decision active and
carrying `links.replaces` to its internal ID. For a second conflicting proposal,
use `review reject '<QUEUE-ID>' --reason 'Keep the current offer'`: no new record
should be created.

Check an unrelated change:

```powershell
node $cli contribute 'We decided the website background will be navy blue. This is only a visual design choice.' --apply --auto-approve
```

Expect it to apply without a contradiction warning. Check a governed exception:

```powershell
node $cli contribute 'Our rule is that discounts must not exceed 15%.' --apply --auto-approve
node $cli contribute 'Allow Acme a 20% discount as an exception to the existing maximum-discount rule until 2026-12-31. Keep the rule unchanged.' --apply --auto-approve
```

Expect an exception linked through `bends`, without a contradiction flag against
that rule. Explicit exceptions are checked deterministically after AI output.

For inheritance, add Launch and Pricing under it (`workstream add 'Launch'`,
then `workstream add 'Pricing' --parent <LAUNCH-ID>`). Add an annual-contract rule
to Launch, then contribute a monthly-contract decision to Pricing. Expect the
parent rule to be named. Approving the child with `--replaces <PARENT-RULE>` must
refuse: replace or retire the parent rule in Launch before approving the child.

## Other interfaces

- MCP: `list_pending_reviews` returns `contradictions`; contribution results
  report why direct apply was refused. Resolve through
  `review_approve({id: '<QUEUE-ID>', replaces: ['<OLD-RECORD-ID>']})`.
- Web: the manager's queue shows the warning and both statements on shared rows.
  Pending contributions remain absent from member pages. A web test requires a
  test deployment running this branch; production cannot exercise unpushed code.
- CLI: repeated `--replaces` options resolve separate flagged operations. Every
  active conflict must be resolved; one selection cannot override several rules.

## Validation completed

Full suite: 124 test files and 2,155 tests passed.

Integration tests exercise the actual provider adapter contract, distiller,
operations, storage and manager gate, with provider responses stubbed. They also
cover dropped-operation indices, fabricated references, omitted checks, stale
context, rejected/failed approval, inherited scope and stable-key allocation.
CLI, MCP and page tests cover reporting, replacement inputs and escaping.

A disposable git sandbox with real Anthropic calls (`claude-sonnet-4-6`) verified
the entry-offer conflict and replacement, an unrelated design decision, an
inherited contract-rule conflict and a valid discount exception. The run found a
false positive on that exception; the deterministic `bends` guard fixed it and
all four cases were rerun successfully. Ordinary semantic contradictions still
depend on model judgement; missing or malformed check output cannot apply.

Linked issue: **Closes #121**. This branch is stacked on #127/#126; those changes
must merge before opening this as a focused PR against main, or use #127 as its
temporary base.
